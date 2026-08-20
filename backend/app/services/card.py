"""★ 卡片服务 —— 产品的灵魂交互（PLAN §3.2）。

与传统 chat 的本质区别：**传统 chat 是一维时间线，卡片是二维空间。**
深挖一个概念不会把上文顶走 —— 每张卡各自占位置，追问的过程本身就在画图。
"""

from __future__ import annotations

import hashlib
import logging
from collections.abc import AsyncIterator

from sqlalchemy import func, select

from app.core.config import TIER_SMALL, TIER_STANDARD
from app.core.scope import UserScope
from app.core.types import new_id, utcnow
from app.llm import Message, chat_json, stream_chat
from app.models.card import (
    ORIGIN_PARENT_ANSWER,
    ORIGIN_SOURCE_TEXT,
    STATE_VAULT,
    Card,
    CardMessage,
)
from app.models.learning import POMO_RUNNING, Pomodoro
from app.models.system import CardSearch
from app.search.fts import delete_card_fts, upsert_card_fts
from app.search.tokenize import to_index_text
from app.services import prompts

log = logging.getLogger(__name__)

# 链深达到这个值就提示"提权成索引卡"（Folium：编号长到难受说明该提权，PLAN §1.4）
DEPTH_HINT_THRESHOLD = 4

# 画布自动布局的基准间距
CARD_W, CARD_GAP_X, CARD_GAP_Y, ROOT_GAP_Y = 340.0, 380.0, 150.0, 420.0


# ─────────────────────────────────────────────────────────────
# 建卡
# ─────────────────────────────────────────────────────────────
async def _sibling_index(scope: UserScope, parent_id: str | None, section_id: str | None) -> int:
    stmt = select(func.count(Card.id)).where(Card.user_id == scope.user_id)
    if parent_id:
        stmt = stmt.where(Card.parent_card_id == parent_id)
    else:
        stmt = stmt.where(
            Card.parent_card_id.is_(None),
            Card.source_section_id == section_id,
        )
    return int(await scope.session.scalar(stmt) or 0)


async def _active_pomodoro_id(scope: UserScope) -> str | None:
    """番茄进行中产生的卡片自动打上 pomodoro_id（PLAN §3.3）。"""
    return await scope.session.scalar(
        scope.select(Pomodoro, Pomodoro.id)
        .where(Pomodoro.status == POMO_RUNNING)
        .order_by(Pomodoro.started_at.desc())
        .limit(1)
    )


async def create_card(
    scope: UserScope,
    *,
    question: str,
    selected_text: str,
    context_text: str = "",
    source_type: str = "course",
    source_section_id: str | None = None,
    source_doc_block_id: str | None = None,
    text_anchor: dict | None = None,
    parent_card_id: str | None = None,
    origin: str = ORIGIN_SOURCE_TEXT,
    origin_message_id: str | None = None,
    origin_offset: dict | None = None,
) -> Card:
    """三种产生方式（PLAN §3.2.0，都必须支持）：

      · 在**原文**划词      → 根卡（parent=NULL，挂在该小节下）
      · 在**AI 回答**里划词  → 子卡（parent=当前卡，自动连线）← 铁律 #1
      · 在**己见**里划词     → 子卡（用户常在自述中发现新疑问）
    """
    parent: Card | None = None
    depth = 0
    if parent_card_id:
        parent = await scope.require_card(parent_card_id)
        depth = parent.depth + 1
        # 子卡继承父卡的来源，保证整条链都能回跳到同一处原文
        source_type = parent.source_type
        source_section_id = parent.source_section_id
        source_doc_block_id = parent.source_doc_block_id
        if origin == ORIGIN_SOURCE_TEXT:
            origin = ORIGIN_PARENT_ANSWER
    elif source_section_id:
        await scope.require_section(source_section_id)
    elif source_doc_block_id:
        await scope.require_doc_block(source_doc_block_id)

    idx = await _sibling_index(scope, parent_card_id, source_section_id)

    # 默认自动布局：父卡右下方错位排开，用户拖动后 pinned=True 不再自动摆
    if parent:
        x, y = parent.canvas_x + CARD_GAP_X, parent.canvas_y + idx * CARD_GAP_Y
    else:
        x, y = 0.0, idx * ROOT_GAP_Y

    card = Card(
        id=new_id(),
        user_id=scope.user_id,
        question=question.strip(),
        selected_text=selected_text.strip()[:2000],
        context_text=context_text.strip()[:4000],
        source_type=source_type,
        source_section_id=source_section_id,
        source_doc_block_id=source_doc_block_id,
        text_anchor=text_anchor or {},
        origin=origin,
        origin_message_id=origin_message_id,
        origin_offset=origin_offset or {},
        canvas_x=x,
        canvas_y=y,
        parent_card_id=parent_card_id,
        depth=depth,
        pomodoro_id=await _active_pomodoro_id(scope),
        # ★ 卡片不再有状态分类。原来是 draft →（用户点"收进仓库"）→ vault，
        #   但那个动作没人愿意做，也没人理解它在做什么：卡片就是卡片，
        #   划下来它就存在。索引与摘要在回答写完时自动补（见 stream_answer 尾部）。
        state=STATE_VAULT,
        vaulted_at=utcnow(),
        touch_count=1,
        last_touched_at=utcnow(),
    )
    scope.add(card)
    await scope.commit()
    return card


async def ancestors_of(scope: UserScope, card: Card, limit: int = 6) -> list[Card]:
    """自根向下的祖先链。逐跳都在 user scope 内取，天然防越权。"""
    chain: list[Card] = []
    cur = card
    while cur.parent_card_id and len(chain) < limit:
        parent = await scope.get(Card, cur.parent_card_id)
        if parent is None:
            break
        chain.append(parent)
        cur = parent
    return list(reversed(chain))


# ─────────────────────────────────────────────────────────────
# 卡片内问答（同一张卡可多轮）
# ─────────────────────────────────────────────────────────────
async def _next_seq(scope: UserScope, card_id: str) -> int:
    return int(
        await scope.session.scalar(
            select(func.coalesce(func.max(CardMessage.seq), -1) + 1).where(
                CardMessage.card_id == card_id
            )
        )
        or 0
    )


async def stream_answer(
    scope: UserScope,
    card: Card,
    question: str,
    *,
    quota: int | None = None,
) -> AsyncIterator[dict]:
    """卡片问答：中档模型 + 流式 —— 高频交互，延迟比质量重要（PLAN §4.1）。"""
    question = question.strip()
    if not question:
        yield {"event": "error", "data": {"message": "问题不能为空"}}
        return

    seq = await _next_seq(scope, card.id)
    scope.add(
        CardMessage(
            id=new_id(), card_id=card.id, seq=seq, role="user",
            content=question, status="done", created_at=utcnow(),
        )
    )
    answer_id = new_id()
    answer_msg = CardMessage(
        id=answer_id, card_id=card.id, seq=seq + 1, role="assistant",
        content="", status="pending", created_at=utcnow(),
    )
    scope.add(answer_msg)
    if not card.question:
        card.question = question[:2000]
    card.touch_count += 1
    card.last_touched_at = utcnow()
    await scope.commit()

    yield {"event": "start", "data": {"card_id": card.id, "message_id": answer_id}}

    # 构造上下文：源标题 + 祖先摘要（非全文）+ 本卡历史轮次
    source_title = ""
    if card.source_section_id:
        try:
            sec, ch, co = await scope.section_course(card.source_section_id)
            source_title = f"{co.title} / {ch.title} / {sec.title}"
        except Exception:
            pass

    ancestors = [
        {
            "selected_text": a.selected_text,
            "summary": a.summary or (a.ai_answer[:150] if a.ai_answer else ""),
            "question": a.question,
        }
        for a in await ancestors_of(scope, card)
    ]

    messages = [
        Message(role="system", content=prompts.CARD_SYSTEM),
        Message(
            role="user",
            content=prompts.card_context(
                selected_text=card.selected_text,
                context_text=card.context_text,
                source_title=source_title,
                ancestors=ancestors,
                origin=card.origin,
            ),
        ),
    ]
    # 本卡此前的轮次（不含刚插入的这一问）
    prior = await scope.all(
        select(CardMessage)
        .where(CardMessage.card_id == card.id, CardMessage.seq < seq, CardMessage.status == "done")
        .order_by(CardMessage.seq)
    )
    for m in prior[-8:]:
        messages.append(Message(role=m.role, content=m.content))  # type: ignore[arg-type]
    messages.append(Message(role="user", content=question))

    buf: list[str] = []
    try:
        async for chunk in stream_chat(
            messages,
            scene="card_chat",
            tier=TIER_STANDARD,
            user_id=scope.user_id,
            temperature=0.6,
            max_tokens=2500,
            quota=quota,
        ):
            if chunk.done:
                if chunk.usage:
                    answer_msg.token_usage = {
                        "prompt": chunk.usage.prompt_tokens,
                        "completion": chunk.usage.completion_tokens,
                    }
                break
            buf.append(chunk.delta)
            yield {"event": "delta", "data": {"text": chunk.delta}}
    except Exception as exc:
        answer_msg.status = "failed"
        answer_msg.content = "".join(buf)
        await scope.commit()
        log.exception("卡片问答失败")
        yield {"event": "error", "data": {"message": str(exc)[:400]}}
        return

    text = "".join(buf)
    answer_msg.content = text
    answer_msg.status = "done"
    card.ai_answer = text  # 始终保留最新一条回答，供检索与摘要
    await scope.commit()

    # ★ 答完就自动补摘要与索引，不再等用户点「收进仓库」。
    #   摘要用小模型（几百 token），换来的是每一张卡都能被检索到、能进复习 ——
    #   而原来那个手动动作的实际效果是「大部分卡永远停在 draft，等于不存在」。
    #   失败不影响这次问答：卡和回答都已经落库了。
    try:
        await enrich_card(scope, card, quota=quota)
        await index_card(scope, card)
    except Exception:
        log.warning("卡片自动索引失败（不影响本次问答）", exc_info=True)

    yield {
        "event": "done",
        "data": {"card_id": card.id, "message_id": answer_id, "content": text},
    }


# ─────────────────────────────────────────────────────────────
# draft → vault：写入期做重活（PLAN §3.6 第 1 步）
# ─────────────────────────────────────────────────────────────
async def enrich_card(scope: UserScope, card: Card, *, quota: int | None = None) -> None:
    """抽概念标签 + 一句话摘要。

    成本摊薄到每次交互，用户无感。这是整个检索方案的关键 ——
    **把检索难度前移到写入期**，查询时就不必只靠向量硬捞。

    标签写在 card.concept_tags 上，供检索索引、仓库页与勋章统计使用。
    """
    if not card.ai_answer and not card.user_note:
        return
    try:
        data = await chat_json(
            [
                Message(role="system", content=prompts.ENRICH_SYSTEM),
                Message(
                    role="user",
                    content=prompts.enrich_user(
                        card.question, card.ai_answer, card.user_note, card.selected_text
                    ),
                ),
            ],
            scene="enrich",
            tier=TIER_SMALL,  # 结构化小任务，小模型完全够
            user_id=scope.user_id,
            temperature=0.2,
            max_tokens=500,
            quota=quota,
        )
    except Exception:
        log.warning("卡片 enrich 失败，跳过（不影响入库）", exc_info=True)
        return

    card.summary = str(data.get("summary") or "")[:400]
    card.concept_tags = [
        str(t).strip() for t in (data.get("concepts") or []) if str(t).strip()
    ][:6]
    card.enriched_at = utcnow()
    await scope.commit()


async def index_card(scope: UserScope, card: Card) -> None:
    """写入检索索引。jieba 分词后再入库（PLAN §3.6）。"""
    text = "\n".join(
        filter(
            None,
            [
                card.selected_text,
                card.question,
                card.summary,
                card.ai_answer,
                card.user_note,
                " ".join(card.concept_tags or []),
            ],
        )
    )
    digest = hashlib.sha256(text.encode()).hexdigest()
    row = await scope.session.get(CardSearch, card.id)
    if row and row.content_hash == digest:
        return  # 内容没变，跳过重建（也跳过重复的 embedding 付费）

    tsv = to_index_text(text)
    if row is None:
        row = CardSearch(card_id=card.id, user_id=scope.user_id, tsv=tsv, content_hash=digest)
        scope.add(row)
    else:
        row.tsv, row.content_hash = tsv, digest
        row.embedding = None  # 内容变了，旧向量作废
        row.embedded_at = None

    await upsert_card_fts(scope.session, card.id, scope.user_id, tsv)
    await scope.commit()


async def to_vault(scope: UserScope, card: Card, *, quota: int | None = None) -> Card:
    """把一张卡（或一份笔记）纳入检索与复习。

    ★ 对**划词卡**这一步已经自动化：建卡即 state=vault，回答写完自动补索引，
      用户不必再点「收进仓库」—— 那个动作没人愿意做，也没人理解它在做什么。
    ★ 对**笔记卡**它仍是用户的一次明确决定（草稿 → 收进笔记），
      因为「我改完了，这份算数」本来就该由人来说。
    """
    card.state = STATE_VAULT
    card.vaulted_at = utcnow()
    card.is_rewritten = bool(card.user_note.strip())
    card.last_touched_at = utcnow()
    await scope.commit()

    await enrich_card(scope, card, quota=quota)
    await index_card(scope, card)

    # 向量化：第四路召回。失败不影响其它三路，所以整段容错
    try:
        from app.services.brain import embed_card

        await embed_card(scope, card)
    except Exception:
        log.warning("卡片向量化失败（其它召回路不受影响）", exc_info=True)

    from app.services.review import ensure_review_state

    await ensure_review_state(scope, card)
    return card


async def delete_card(scope: UserScope, card: Card) -> None:
    """删卡。子卡随之级联删除（ON DELETE CASCADE），索引单独清理。"""
    ids = [card.id]
    frontier = [card.id]
    while frontier:
        kids = list(
            await scope.session.scalars(
                select(Card.id).where(
                    Card.parent_card_id.in_(frontier), Card.user_id == scope.user_id
                )
            )
        )
        if not kids:
            break
        ids.extend(kids)
        frontier = kids

    for cid in ids:
        await delete_card_fts(scope.session, cid)
    await scope.session.delete(card)
    await scope.commit()


# 孤岛卡（长期未触碰且无连线）已删除：它的定义建立在全局图谱之上，
# 而图谱这一整块已经撤掉。卡片现在绑定在小节与笔记上，"有没有归属"不再是问题。
