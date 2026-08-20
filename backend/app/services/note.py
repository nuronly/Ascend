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
"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator

from sqlalchemy import func, select

from app.core.config import TIER_STANDARD
from app.core.scope import UserScope
from app.core.types import new_id, utcnow
from app.llm import Message, ThinkingBuffer, stream_chat
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


async def stream_section_note(
    scope: UserScope, section_id: str, *, force: bool = False, quota: int | None = None
) -> AsyncIterator[dict]:
    """流式生成这一节的笔记卡。

    事件：
      start    带上要汇流的卡片清单（前端用它做「卡片飞向中心」的动画，
               粒子数就是真实卡片数，用户能数出「我的 7 张卡进去了」）
      cached   已有笔记卡且未强制重生成 —— 直接回放，进编辑态
      thinking 思维链原文（等待期间看得见它在想什么）
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
            max_tokens=8000,  # 思维链也吃这份额度
            quota=quota,
        ):
            if chunk.done:
                break
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

    ★ undigested（未消化的疑问）
      卡片被降级之后最大的风险是它们没人管了。这个数字就是安全阀：还没被任何
      笔记吸收的卡片有多少 —— 它给用户一个明确的行动，而不是一个被藏起来的角落。
      口径是**小节粒度的近似**：这张卡所属的小节还没有笔记卡，就算未消化。
      精确到「笔记正文是否真的引用了它」代价太大，而这个近似足够驱动行动。
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

    # 每节有多少张划词卡（笔记条目上显示「3 张卡」，让人知道它吃进了什么）
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
                "cards": int(counts.get(section.id, 0)),
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

    # 未消化：所属小节还没有笔记卡的划词卡
    covered = {str(s.id) for _, s, _, _ in rows}
    undigested = 0
    for sid, n in counts.items():
        if sid and str(sid) not in covered:
            undigested += int(n)

    return {"groups": list(groups.values()), "undigested": undigested}


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
