"""笔记卡：一节学完，卡片与原文汇流成一张永久笔记。

★ 这是卢曼卡片盒缺失的最上层

    划词提问        → 闪念笔记（fleeting）    kind=card, state=draft
    回答 + 己见     → 文献笔记（literature）  kind=card, state=vault
    **汇流成一张**  → 永久笔记（permanent）   kind=note   ← 本模块

  所以它不是"另一个笔记功能"，而是把已有的痕迹收成一件东西。用同一张 cards
  表（见 models/card.KIND_*），免费继承划词追问、问题图、FSRS 复习、FTS 检索、
  导出 —— 其中"在自己的笔记里划词再提问"是最有价值的闭环：读自己的总结时
  产生新疑问，学习就继续转下去了。

★ 两条不能破的规矩

  1. **AI 原稿与用户终稿分开存**：ai_answer 是原稿快照（用户改了也不动它），
     user_note 是用户的终稿。知道原版还在，用户才敢大胆删改。
  2. **重新生成绝不覆盖**：已保存的笔记卡再生成，会新建一张并排放着，
     由用户自己挑或合并。用户写过的东西神圣。

★ 为什么是"用户点一下"才生成，而不是学完自动装配

  自动生成的东西没人看。用户点了那一下，这份笔记的所有权才是他的。
  顺带也省下了每节一次的模型调用。

★ 「与前面学过的关系」靠工具查证，不靠模型瞎猜

  这一节原来是整张笔记里最虚的一块 —— 模型手里根本没有前面几节的任何信息，
  于是要么省略，要么写出「与前文密切相关」这种占着位置的废话。
  现在两条腿走：note_routes 零成本列出「他哪几节写过笔记」（发现），
  read_note 让模型去读那一节的当前全文（引用）。查不到确切关联就省略。
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from sqlalchemy import and_, func, select

from app.core.config import TIER_STANDARD
from app.core.scope import UserScope
from app.core.types import new_id, utcnow
from app.llm import Message, ThinkingBuffer, stream_chat
from app.llm.tools.memory import NOTE_TOOLS, memory_tools
from app.models.card import KIND_CARD, KIND_NOTE, STATE_ARCHIVED, STATE_DRAFT, Card
from app.services import calibrate, prompts

log = logging.getLogger(__name__)

# 汇流进来的卡片上限。再多就不是"收敛"而是"平铺"了 ——
# 提了 30 个问题的人，笔记里塞 30 段摘要只会得到一页垃圾
MAX_CARDS = 12


def rank_sources(rows: list[Card]) -> list[Card]:
    """给汇流的卡片排优先级并截断。

    ★ 排序即优先级：**写过己见的排最前**（那是他真正处理过的思考），其次入过
      仓的，最后才是草稿卡。超出上限时砍掉的正是最末尾那些 —— 也就是
      「随手问了一下、就没再管」的卡。

      为什么要截断：提了 30 个问题的人，笔记里塞 30 段摘要只会得到一页垃圾。
      收敛是这张笔记卡存在的意义，不是限制。
    """
    ranked = sorted(
        rows, key=lambda c: (0 if c.is_rewritten else (1 if c.state != STATE_DRAFT else 2))
    )
    return ranked[:MAX_CARDS]


async def _source_cards(scope: UserScope, section_id: str) -> list[Card]:
    """这一节里值得汇流的卡片（已排好优先级）。"""
    rows = await scope.all(
        scope.select(Card)
        .where(
            Card.source_section_id == section_id,
            Card.kind == KIND_CARD,  # 笔记卡不能把自己也汇流进去
            Card.state != STATE_ARCHIVED,
        )
        .order_by(Card.created_at)
    )
    return rank_sources(rows)


def _card_payload(c: Card) -> dict:
    return {
        "selected_text": c.selected_text,
        "question": c.question,
        # 摘要优先（入仓时已抽好），没有就退回答案原文截断
        "answer": c.summary or c.ai_answer,
        "user_note": c.user_note,
    }


async def existing_note(scope: UserScope, section_id: str) -> Card | None:
    """这一节已有的笔记卡（取最新的一张）。"""
    return await scope.one_or_none(
        scope.select(Card)
        .where(Card.source_section_id == section_id, Card.kind == KIND_NOTE)
        .order_by(Card.created_at.desc())
    )


async def note_routes(scope: UserScope, course_id: str, *, upto: str = "") -> list[dict]:
    """他在这门课里已经写过笔记的小节 —— 给模型的「路由清单」。

    ★ 为什么是清单而不是让模型自己 search_memory

      每一次工具调用都是一轮完整的模型往返（正文一轮十几秒）。而「他哪几节
      写过笔记」是一句 SQL 的事，几百字就能列完。所以这里零成本把**路由**
      给足，工具只留给「读那一节的全文」——真正必须现场取、又大又会变的东西。
      这正是「索引用于发现，工具用于引用」在 prompt 侧的对应做法。

    ★ upto：只往回看

      顺序即知识依赖。写 1.5 的笔记时去引用 2.3，既是剧透，也颠倒了他真实的
      理解路径。所以只列排在这一节之前的（严格小于，本节自己也排除在外）。

    ★ 一条 SQL 拿全

      小节顺序与「这一节有没有笔记」本可以分两次查（后者 note_index 就有），
      但那样 upto 的切分点和笔记归属要在两份结果之间对齐，多一处能错的地方。
      外连接一次拿完，重复行在 Python 里按 section 收敛。
    """
    from app.models.course import Chapter, Section

    rows = list(
        (
            await scope.session.execute(
                select(
                    Section.id,
                    Section.title,
                    Section.key_concepts,
                    Chapter.idx,
                    Section.idx,
                    Card.id,
                    Card.is_rewritten,
                )
                .join(Chapter, Chapter.id == Section.chapter_id)
                .outerjoin(
                    Card,
                    and_(
                        Card.source_section_id == Section.id,
                        Card.user_id == scope.user_id,  # 隔离：连表也不能漏掉 owner
                        Card.kind == KIND_NOTE,
                        Card.state != STATE_ARCHIVED,
                    ),
                )
                .where(Chapter.course_id == course_id)
                # created_at 排最后：一节可能有多张笔记（「重新生成」会另建一张），
                # 同 section 的行里最后一条就是最新那份
                .order_by(Chapter.idx, Section.idx, Card.created_at)
            )
        ).all()
    )

    # section_id → 该节最新一张笔记的信息（缺键表示这节还没写）
    seen: list[str] = []  # 全部小节，按大纲顺序（upto 的切分点在这上面找）
    noted: dict[str, dict] = {}
    for sid, title, concepts, ci, si, note_id, edited in rows:
        key = str(sid)
        if key not in seen:
            seen.append(key)
        if note_id:
            noted[key] = {
                "section_id": key,
                "title": f"{int(ci) + 1}.{int(si) + 1} {title}",
                "concepts": [str(c) for c in (concepts or [])][:4],
                "edited": bool(edited),
            }

    if upto and upto in seen:
        seen = seen[: seen.index(upto)]

    out = [noted[k] for k in seen if k in noted]
    # 只留最近的十节：整门课铺进 prompt 就成了噪声，而相邻的几节才是真有关系的
    return out[-10:]


async def stream_section_note(
    scope: UserScope, section_id: str, *, force: bool = False, quota: int | None = None
) -> AsyncIterator[dict]:
    """流式生成这一节的笔记卡。

    事件：
      start    带上要汇流的卡片清单（前端用它做「卡片飞向中心」的动画，
               粒子数就是真实卡片数，用户能数出「我的 7 张卡进去了」）
      cached   已有笔记卡且未强制重生成 —— 直接回放，进编辑态
      thinking 思维链原文（等待期间看得见它在想什么）
      tool_*   它去读了哪一节的旧笔记（「与前面学过的关系」靠这个才写得实）
      delta    笔记正文
      done     card_id
    """
    section, chapter, course = await scope.section_course(section_id)

    existing = await existing_note(scope, section_id)
    if existing is not None and not force:
        yield {
            "event": "cached",
            "data": {
                "card_id": existing.id,
                "content": existing.user_note or existing.ai_answer,
                "ai_draft": existing.ai_answer,
                "state": existing.state,
                "edited": existing.is_rewritten,
            },
        }
        yield {"event": "done", "data": {"card_id": existing.id, "cached": True}}
        return

    cards = await _source_cards(scope, section_id)
    yield {
        "event": "start",
        "data": {
            "section_id": section.id,
            "title": section.title,
            # 前端动画要的：每一片"汇流粒子"的标签
            "sources": [
                {"id": c.id, "label": c.selected_text or c.question or "卡片"} for c in cards
            ],
            "has_content": bool(section.content_md),
        },
    }

    boundary = calibrate.as_any(course.boundary)
    user_msg = prompts.note_user(
        course_title=course.title or course.topic,
        chapter_title=chapter.title,
        section_title=section.title,
        content_md=section.content_md or section.summary or "",
        key_concepts=[str(k) for k in (section.key_concepts or [])],
        cards=[_card_payload(c) for c in cards],
        # 开课时他说不会的概念，笔记里要确保覆盖
        unknown=[str(x) for x in (boundary.get("unknown") or [])][:12],
        # ★ 「与前面学过的关系」那一节原来只能靠模型瞎猜 —— 它手里根本没有
        #   前面几节的任何信息，于是要么省略，要么写出「与前文密切相关」这种废话。
        #   现在给它一份路由清单（哪几节有笔记），让它自己 read_note 去查证。
        prior_notes=await note_routes(scope, course.id, upto=section.id),
    )

    think = ThinkingBuffer()
    buf: list[str] = []
    try:
        async for chunk in stream_chat(
            [
                Message(role="system", content=prompts.NOTE_SYSTEM),
                Message(role="user", content=user_msg),
            ],
            scene="note",
            # 笔记是要长期留存、反复重读的东西，值得用好一点的档位；
            # 它的质量决定了用户愿不愿意在上面继续写
            tier=TIER_STANDARD,
            user_id=scope.user_id,
            temperature=0.5,
            # 思维链吃这份额度，带工具的多轮往返也吃 —— 原来 8000 在
            # 「先读两份旧笔记再写」的路径上会把正文挤没
            max_tokens=12000,
            quota=quota,
            tools=memory_tools(scope, only=NOTE_TOOLS),
            # 「与前面的关系」最多需要读两份旧笔记。再多轮就是拿几十秒的等待
            # 换一句可有可无的关联 —— 而用户此刻正盯着这一栏等笔记出来
            max_rounds=2,
        ):
            if chunk.done:
                break
            # 它去读了哪一节的旧笔记，摊出来 —— 这是「关系」那一节的证据来源，
            # 用户点开就知道这句话不是编的
            if chunk.tool_event:
                if pending := think.flush():
                    yield pending
                ev = chunk.tool_event
                yield {
                    "event": f"tool_{ev.phase}",
                    "data": {"name": ev.name, "detail": ev.detail, "ms": ev.ms},
                }
                continue
            if chunk.reasoning:
                if pending := think.add(chunk.reasoning):
                    yield pending
                continue
            if pending := think.flush():
                yield pending
            if not chunk.delta:
                continue
            buf.append(chunk.delta)
            yield {"event": "delta", "data": {"text": chunk.delta}}
    except Exception as exc:
        log.exception("笔记卡生成失败")
        yield {"event": "error", "data": {"message": str(exc)[:400]}}
        return

    body = "".join(buf).strip()
    if not body:
        yield {"event": "error", "data": {"message": "模型没有返回内容，请重试"}}
        return

    card = Card(
        id=new_id(),
        user_id=scope.user_id,
        kind=KIND_NOTE,
        question=f"{chapter.idx + 1}.{section.idx + 1} {section.title}",
        # ai_answer = 原稿快照；user_note 留空，等用户动手（见模块头的规矩 1）。
        # is_rewritten 显式给 False：ORM 的 default 要等 INSERT 才生效，
        # 而这个字段是「己见率」的口径，不能有一瞬间的 None
        ai_answer=body,
        user_note="",
        is_rewritten=False,
        source_section_id=section.id,
        selected_text=section.title,
        context_text=section.summary or "",
        concept_tags=[str(k) for k in (section.key_concepts or [])][:6],
        state=STATE_DRAFT,  # 用户改完点保存才 → vault（复用现有状态机）
        # 卡片绑定在小节与笔记上，不再独立存在：记下这一份吃进了哪几张卡
        note_sources=[c.id for c in cards],
        created_at=utcnow(),
        updated_at=utcnow(),
    )
    scope.add(card)
    await scope.commit()

    yield {
        "event": "done",
        "data": {
            "card_id": card.id,
            "state": card.state,
            "sources": len(cards),
            "length": len(body),
        },
    }


async def notebook(scope: UserScope) -> dict:
    """笔记主视图：按课程分组的全部笔记 + 未消化的疑问数。

    ★ 为什么主界面是笔记而不是卡片

      「卡片整理进仓库其实也不会有人看」—— 病因有四个：粒度太碎（脱离语境
      读不懂）、卡片网格不是阅读单元（那是数据库视图）、「归档」这个动作本身
      就等于心理上的完结、以及它是**过程产物而不是成果**。把过程产物当主界面，
      等于让人天天翻草稿箱。

      所以卡片降级为素材层（仍然存在：划词追问的产物、问题图的节点、复习单元），
      主界面换成笔记 —— 一个真正能读、且有回访理由的单元。

    ★ 分组按「课程 → 小节」而不是时间流
      笔记的回访路径是「我要复习 Transformer 的注意力那节」，不是「我三周前
      记了什么」。时间流适合日志，不适合知识。

    ★ 卡片不出现在这里
      卡片不是独立存在的东西，它绑定在小节（source_section_id）与笔记
      （note_sources）上，入口只有小节页的卡片空间。笔记页不再有「疑问」栏，
      也不再统计「未消化的疑问」—— 那又是在把过程产物摆到台面上。
    """
    from app.models.course import Chapter, Course, Section

    rows = list(
        (
            await scope.session.execute(
                select(Card, Section, Chapter, Course)
                .join(Section, Section.id == Card.source_section_id)
                .join(Chapter, Chapter.id == Section.chapter_id)
                .join(Course, Course.id == Chapter.course_id)
                .where(Card.user_id == scope.user_id, Card.kind == KIND_NOTE)
                .order_by(Course.created_at.desc(), Chapter.idx, Section.idx)
            )
        ).all()
    )

    # 每节有多少张划词卡（笔记条目上显示「吃进 3 张卡」，让人知道它由什么汇成）
    counts = dict(
        (
            await scope.session.execute(
                select(Card.source_section_id, func.count(Card.id))
                .where(
                    Card.user_id == scope.user_id,
                    Card.kind == KIND_CARD,
                    Card.state != STATE_ARCHIVED,
                )
                .group_by(Card.source_section_id)
            )
        ).all()
    )

    groups: dict[str, dict] = {}
    for card, section, chapter, course in rows:
        g = groups.setdefault(
            course.id,
            {
                "course_id": course.id,
                "course_title": course.title or course.topic,
                "notes": [],
            },
        )
        body = card.user_note or card.ai_answer
        g["notes"].append(
            {
                "card_id": card.id,
                "section_id": section.id,
                "title": f"{chapter.idx + 1}.{section.idx + 1} {section.title}",
                "state": card.state,
                "edited": card.is_rewritten,
                # 摘要剥掉 Markdown 标题行，否则列表里全是「## 这一节解决了什么问题」
                "excerpt": _excerpt(body),
                # 优先用落库时记下的来源；老数据没有这个字段就退回按小节数
                "cards": len(card.note_sources or []) or int(counts.get(section.id, 0)),
                "updated_at": card.updated_at.isoformat() if card.updated_at else None,
            }
        )

    # 每门课总共多少节（用来显示 6/12 节有笔记）
    totals = dict(
        (
            await scope.session.execute(
                select(Chapter.course_id, func.count(Section.id))
                .join(Section, Section.chapter_id == Chapter.id)
                .where(Chapter.course_id.in_(list(groups) or [""]))
                .group_by(Chapter.course_id)
            )
        ).all()
    )
    for cid, g in groups.items():
        g["sections_total"] = int(totals.get(cid, 0))

    return {"groups": list(groups.values())}


def _excerpt(md: str, limit: int = 160) -> str:
    lines = [
        ln.strip()
        for ln in (md or "").splitlines()
        if ln.strip() and not ln.lstrip().startswith("#")
    ]
    text = " ".join(lines)
    return text[:limit]


async def note_index(scope: UserScope, course_id: str) -> dict[str, dict]:
    """课程内每一节的笔记卡状态，供课程页/路径图标记「这节有没有笔记」。"""
    from app.models.course import Chapter, Section

    rows = await scope.all(
        scope.select(Card)
        .where(
            Card.kind == KIND_NOTE,
            Card.source_section_id.in_(
                select(Section.id)
                .join(Chapter, Chapter.id == Section.chapter_id)
                .where(Chapter.course_id == course_id)
            ),
        )
        .order_by(Card.created_at)
    )
    return {
        str(c.source_section_id): {
            "card_id": c.id,
            "state": c.state,
            "edited": c.is_rewritten,
        }
        for c in rows
        if c.source_section_id
    }
