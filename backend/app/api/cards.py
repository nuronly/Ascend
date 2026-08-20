"""卡片 API（PLAN §3.2）。"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import Integer, func, or_, select
from sqlalchemy import inspect as sa_inspect

from app.api.deps import CurrentUser, Scope, user_quota
from app.api.sse import sse_response
from app.core.types import new_id, utcnow
from app.models.card import (
    KIND_CARD,
    LINK_REAL,
    ORIGIN_MANUAL,
    ORIGIN_PARENT_ANSWER,
    ORIGIN_PARENT_NOTE,
    ORIGIN_SOURCE_TEXT,
    RELATIONS,
    STATE_ARCHIVED,
    STATE_DRAFT,
    STATE_VAULT,
    Card,
    CardLink,
    CardMessage,
)
from app.services import calibrate
from app.services import card as svc

log = logging.getLogger(__name__)

router = APIRouter(prefix="/cards", tags=["cards"])


# ─────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────
class CreateCardIn(BaseModel):
    # 手动建卡（origin=manual）没有划中的文本，卡片标题由 question 顶上
    # （前端 CardNode 已有 selected_text || question 的回落）。
    # 具体校验按 origin 分流，见 create_card。
    selected_text: str = Field(default="", max_length=2000)
    question: str = Field(default="", max_length=2000)
    context_text: str = Field(default="", max_length=4000)
    source_type: str = Field(default="course", pattern="^(course|doc|brain)$")
    source_section_id: str | None = None
    source_doc_block_id: str | None = None
    text_anchor: dict[str, Any] = {}
    parent_card_id: str | None = None
    origin: str = Field(
        default=ORIGIN_SOURCE_TEXT,
        pattern="^(source_text|parent_answer|parent_note|manual)$",
    )
    origin_message_id: str | None = None
    origin_offset: dict[str, Any] = {}


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=2000)


class NoteIn(BaseModel):
    user_note: str = Field(max_length=20000)


class PositionIn(BaseModel):
    canvas_x: float
    canvas_y: float


class BulkPositionIn(BaseModel):
    positions: dict[str, PositionIn]


class CollapseIn(BaseModel):
    collapsed: bool


class LinkIn(BaseModel):
    to_card_id: str
    relation: str = Field(default="continuation")
    note: str = Field(default="", max_length=1000)


class LinkUpdateIn(BaseModel):
    relation: str | None = None
    note: str | None = Field(default=None, max_length=1000)


class BulkStateIn(BaseModel):
    card_ids: list[str] = Field(min_length=1, max_length=200)
    state: str = Field(pattern="^(draft|vault|archived)$")


# ─────────────────────────────────────────────────────────────
# 序列化
# ─────────────────────────────────────────────────────────────
def card_dict(c: Card, *, with_messages: bool = True) -> dict:
    d = {
        "id": c.id,
        "kind": c.kind,
        "question": c.question,
        "ai_answer": c.ai_answer,
        "user_note": c.user_note,
        "is_rewritten": c.is_rewritten,
        "summary": c.summary,
        "concept_tags": list(c.concept_tags or []),
        "source_type": c.source_type,
        "source_section_id": c.source_section_id,
        "source_doc_block_id": c.source_doc_block_id,
        "selected_text": c.selected_text,
        "context_text": c.context_text,
        "text_anchor": c.text_anchor or {},
        "origin": c.origin,
        "origin_message_id": c.origin_message_id,
        "origin_offset": c.origin_offset or {},
        "canvas_x": c.canvas_x,
        "canvas_y": c.canvas_y,
        "collapsed": c.collapsed,
        "pinned": c.pinned,
        "parent_card_id": c.parent_card_id,
        "depth": c.depth,
        "pomodoro_id": c.pomodoro_id,
        "state": c.state,
        "touch_count": c.touch_count,
        "created_at": c.created_at.isoformat(),
        "last_touched_at": c.last_touched_at.isoformat() if c.last_touched_at else None,
    }
    if with_messages:
        # 刚 create 出来的实例没走过查询，messages 尚未加载。
        # 在同步代码里碰它会触发懒加载 IO → MissingGreenlet。
        # 这里显式检查加载状态，未加载就当作空列表。
        loaded = "messages" not in sa_inspect(c).unloaded
        d["messages"] = (
            [
                {
                    "id": m.id,
                    "seq": m.seq,
                    "role": m.role,
                    "content": m.content,
                    "status": m.status,
                    "created_at": m.created_at.isoformat(),
                }
                for m in c.messages
            ]
            if loaded
            else []
        )
    return d


def link_dict(link: CardLink) -> dict:
    return {
        "id": link.id,
        "from_card_id": link.from_card_id,
        "to_card_id": link.to_card_id,
        "kind": link.kind,
        "relation": link.relation,
        "note": link.note,
        "confidence": link.confidence,
        "created_by": link.created_by,
        "promoted_at": link.promoted_at.isoformat() if link.promoted_at else None,
    }


# ─────────────────────────────────────────────────────────────
# 查询
# ─────────────────────────────────────────────────────────────
@router.get("")
async def list_cards(
    scope: Scope,
    section_id: str | None = None,
    doc_id: str | None = None,
    state: str | None = Query(None, pattern="^(draft|vault|archived)$"),
    pomodoro_id: str | None = None,
    kind: str | None = Query(None, pattern="^(card|note)$"),
    limit: int = Query(200, le=500),
) -> dict:
    """小节内的全部卡片 + 卡片之间的连线。

    这是卡片空间的主数据源 —— 一次拿全，前端不再逐张请求。

    ★ 默认只给划词卡：笔记卡（kind=note）是一节的汇流产物，摆进卡片空间那张
      画布只会把追问树搅乱。要取它请显式传 kind=note。
    """
    stmt = scope.select(Card).where(Card.kind == (kind or KIND_CARD))
    if section_id:
        await scope.require_section(section_id)
        stmt = stmt.where(Card.source_section_id == section_id)
    if doc_id:
        # 文档模式：整篇文档下的所有卡片（PLAN §3.5）
        from app.models.document import DocBlock, Document

        await scope.require(Document, doc_id, "文档")
        stmt = stmt.where(
            Card.source_doc_block_id.in_(
                select(DocBlock.id).where(DocBlock.doc_id == doc_id)
            )
        )
    if pomodoro_id:
        stmt = stmt.where(Card.pomodoro_id == pomodoro_id)
    if state:
        stmt = stmt.where(Card.state == state)
    else:
        stmt = stmt.where(Card.state != STATE_ARCHIVED)

    cards = await scope.all(stmt.order_by(Card.created_at).limit(limit))
    ids = [c.id for c in cards]

    links: list[CardLink] = []
    if ids:
        links = await scope.all(
            scope.select(CardLink).where(
                or_(CardLink.from_card_id.in_(ids), CardLink.to_card_id.in_(ids)),
                CardLink.dismissed_at.is_(None),
            )
        )

    return {
        "cards": [card_dict(c) for c in cards],
        "links": [link_dict(link) for link in links],
    }


@router.get("/{card_id}")
async def get_card(card_id: str, scope: Scope) -> dict:
    card = await scope.require_card(card_id)
    d = card_dict(card)
    d["ancestors"] = [
        {"id": a.id, "selected_text": a.selected_text}
        for a in await svc.ancestors_of(scope, card)
    ]
    return d


# ─────────────────────────────────────────────────────────────
# 建卡与问答
# ─────────────────────────────────────────────────────────────
@router.post("", status_code=status.HTTP_201_CREATED)
async def create_card(body: CreateCardIn, scope: Scope, user: CurrentUser) -> dict:
    if body.origin in (ORIGIN_PARENT_ANSWER, ORIGIN_PARENT_NOTE) and not body.parent_card_id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "从卡片内划词必须指定 parent_card_id")
    if body.origin == ORIGIN_SOURCE_TEXT and not (
        body.source_section_id or body.source_doc_block_id or body.parent_card_id
    ):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "根卡必须指定来源小节或文档段落")
    # 两种建卡方式各有各的必填项：划词卡靠选中的文本立身，
    # 手动卡没有划词、全靠问题本身，问题空了这张卡就没有内容了
    if body.origin == ORIGIN_MANUAL:
        if not body.question.strip():
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "手动建卡必须写下问题")
        if not (body.source_section_id or body.source_doc_block_id):
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "手动建卡必须指定来源小节或文档")
    elif not body.selected_text.strip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "划词建卡必须带上选中的文本")

    card = await svc.create_card(
        scope,
        question=body.question,
        selected_text=body.selected_text,
        context_text=body.context_text,
        source_type=body.source_type,
        source_section_id=body.source_section_id,
        source_doc_block_id=body.source_doc_block_id,
        text_anchor=body.text_anchor,
        parent_card_id=body.parent_card_id,
        origin=body.origin,
        origin_message_id=body.origin_message_id,
        origin_offset=body.origin_offset,
    )

    # ★ 边界的反向信号：他在一个自称「已掌握」的概念上划词提问了，
    #   说明那个「熟悉」是虚的。行为信号强于自评，直接把它撤出已知边界，
    #   下一门课会重新给他铺。这里只做纯字符串匹配，不额外调模型
    if forgotten := calibrate.forget(user, body.selected_text):
        await scope.commit()
        log.info("已知边界撤回 %d 个概念（划词追问命中）：%s", len(forgotten), "、".join(forgotten))

    d = card_dict(card)
    # 链深提示：从卡片反向驱动课程生成的闭环入口（PLAN §1.4 / §3.2.0）
    if card.depth + 1 >= svc.DEPTH_HINT_THRESHOLD:
        d["depth_hint"] = {
            "depth": card.depth + 1,
            "message": "这条追问链已经很深了 —— 提炼成一张索引卡？还是生成一节专项课程？",
        }
    return d


@router.post("/{card_id}/ask")
async def ask(
    card_id: str, body: AskIn, request: Request, scope: Scope, user: CurrentUser
):
    """SSE 流式回答。同一张卡可多轮（PLAN §3.2.0）。"""
    card = await scope.require_card(card_id)
    return await sse_response(
        svc.stream_answer(scope, card, body.question, quota=user_quota(user)), request
    )


@router.post("/{card_id}/regenerate")
async def regenerate(card_id: str, request: Request, scope: Scope, user: CurrentUser):
    """重答最后一问：删掉末尾的一问一答，用同样的问题重新生成。"""
    card = await scope.require_card(card_id)
    msgs = list(card.messages)
    last_q = next((m.content for m in reversed(msgs) if m.role == "user"), None)
    if not last_q:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "这张卡还没有提问")

    for m in reversed(msgs):
        if m.role == "assistant":
            await scope.session.delete(m)
            break
    for m in reversed(msgs):
        if m.role == "user":
            await scope.session.delete(m)
            break
    await scope.commit()
    await scope.session.refresh(card)

    return await sse_response(
        svc.stream_answer(scope, card, last_q, quota=user_quota(user)), request
    )


# ─────────────────────────────────────────────────────────────
# 编辑
# ─────────────────────────────────────────────────────────────
@router.patch("/{card_id}/note")
async def update_note(card_id: str, body: NoteIn, scope: Scope) -> dict:
    """己见 —— 卡片入仓库前的那道轻量确认动作（PLAN §1.3）。"""
    card = await scope.require_card(card_id)
    card.user_note = body.user_note
    card.is_rewritten = bool(body.user_note.strip())
    card.touch_count += 1
    card.last_touched_at = utcnow()
    await scope.commit()
    if card.state == STATE_VAULT:
        await svc.index_card(scope, card)
    return {"ok": True, "is_rewritten": card.is_rewritten}


@router.patch("/{card_id}/position")
async def update_position(card_id: str, body: PositionIn, scope: Scope) -> dict:
    """用户拖动后记住位置，此后不再跟随自动布局。"""
    card = await scope.require_card(card_id)
    card.canvas_x, card.canvas_y, card.pinned = body.canvas_x, body.canvas_y, True
    await scope.commit()
    return {"ok": True}


@router.patch("/positions")
async def bulk_positions(body: BulkPositionIn, scope: Scope) -> dict:
    """批量落位。拖动是高频操作，前端 debounce 后一次提交。"""
    cards = await scope.all(scope.select(Card).where(Card.id.in_(list(body.positions))))
    for c in cards:
        p = body.positions.get(c.id)
        if p:
            c.canvas_x, c.canvas_y, c.pinned = p.canvas_x, p.canvas_y, True
    await scope.commit()
    return {"updated": len(cards)}


@router.patch("/{card_id}/collapse")
async def collapse(card_id: str, body: CollapseIn, scope: Scope) -> dict:
    """折叠成标题条 —— 链长了也不会淹没屏幕（PLAN §3.2.0）。"""
    card = await scope.require_card(card_id)
    card.collapsed = body.collapsed
    await scope.commit()
    return {"ok": True}


@router.post("/{card_id}/vault")
async def vault(card_id: str, scope: Scope, user: CurrentUser) -> dict:
    """纳入检索与复习。

    ★ 划词卡不再需要它：建卡即 vault，回答写完自动补摘要与索引
      （见 services/card.stream_answer）。卡片没有「待整理」这种中间态了。
    ★ 现在它的用户是**笔记**：草稿 →「收进笔记」是用户的一次明确决定。
    """
    card = await scope.require_card(card_id)
    await svc.to_vault(scope, card, quota=user_quota(user))
    await scope.session.refresh(card)
    return card_dict(card)


@router.post("/bulk-state")
async def bulk_state(body: BulkStateIn, scope: Scope, user: CurrentUser) -> dict:
    """批量改状态。

    卡片已经没有「整理」这一步，所以这里剩下的实际用途是**丢弃**
    （state=archived）—— 番茄结束时把随手划的废卡清掉。
    """
    cards = await scope.all(scope.select(Card).where(Card.id.in_(body.card_ids)))
    for c in cards:
        if body.state == STATE_VAULT and c.state != STATE_VAULT:
            await svc.to_vault(scope, c, quota=user_quota(user))
        else:
            c.state = body.state
    await scope.commit()
    return {"updated": len(cards)}


@router.delete("/{card_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_card(card_id: str, scope: Scope) -> None:
    card = await scope.require_card(card_id)
    await svc.delete_card(scope, card)


# ─────────────────────────────────────────────────────────────
# 链接：用户手动建立的 real link
# ─────────────────────────────────────────────────────────────
@router.get("/{card_id}/links")
async def card_links(card_id: str, scope: Scope) -> dict:
    """围绕焦点卡的连线。不再自动展示其它卡的连线 —— 否则画布变噪音。"""
    card = await scope.require_card(card_id)
    rows = await scope.all(
        scope.select(CardLink).where(
            or_(CardLink.from_card_id == card.id, CardLink.to_card_id == card.id),
            CardLink.dismissed_at.is_(None),
        )
    )
    ids = {r.from_card_id for r in rows} | {r.to_card_id for r in rows} - {card.id}
    peers = await scope.all(scope.select(Card).where(Card.id.in_(list(ids)))) if ids else []
    return {
        "links": [link_dict(r) for r in rows],
        "peers": [card_dict(p, with_messages=False) for p in peers],
    }


@router.post("/{card_id}/links", status_code=status.HTTP_201_CREATED)
async def create_link(card_id: str, body: LinkIn, scope: Scope) -> dict:
    """用户手动建立连线（real link）。"""
    if body.relation not in RELATIONS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"关系类型必须是 {RELATIONS} 之一")
    card = await scope.require_card(card_id)
    target = await scope.require_card(body.to_card_id)
    if card.id == target.id:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "不能连到自己")

    existing = await scope.one_or_none(
        scope.select(CardLink).where(
            or_(
                (CardLink.from_card_id == card.id) & (CardLink.to_card_id == target.id),
                (CardLink.from_card_id == target.id) & (CardLink.to_card_id == card.id),
            )
        )
    )
    if existing:
        # 已存在就更新语义；dismissed_at 置空是复活历史数据里被否掉的连线
        existing.kind = LINK_REAL
        existing.relation = body.relation
        existing.note = body.note
        existing.created_by = "user"
        existing.dismissed_at = None
        await scope.commit()
        return link_dict(existing)

    link = CardLink(
        id=new_id(),
        user_id=scope.user_id,
        from_card_id=card.id,
        to_card_id=target.id,
        kind=LINK_REAL,
        relation=body.relation,
        note=body.note,
        created_by="user",
        created_at=utcnow(),
    )
    scope.add(link)
    await scope.commit()
    return link_dict(link)


@router.delete("/links/{link_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_link(link_id: str, scope: Scope) -> None:
    """删除一条连线。"""
    link = await scope.require(CardLink, link_id, "连线")
    await scope.session.delete(link)
    await scope.commit()


@router.patch("/links/{link_id}")
async def update_link(link_id: str, body: LinkUpdateIn, scope: Scope) -> dict:
    link = await scope.require(CardLink, link_id, "连线")
    if body.relation is not None:
        if body.relation not in RELATIONS:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, f"关系类型必须是 {RELATIONS} 之一")
        link.relation = body.relation
    if body.note is not None:
        link.note = body.note
    await scope.commit()
    return link_dict(link)


# ─────────────────────────────────────────────────────────────
# 统计
# ─────────────────────────────────────────────────────────────
@router.get("/meta/stats")
async def card_stats(scope: Scope) -> dict:
    """己见率是学习深度的真实指标，比学习时长诚实得多（PLAN §1.3）。"""
    total, vaulted, rewritten, max_depth = (
        await scope.session.execute(
            select(
                func.count(Card.id),
                func.sum(func.cast(Card.state == STATE_VAULT, Integer)),
                func.sum(func.cast(Card.is_rewritten, Integer)),
                func.coalesce(func.max(Card.depth), 0),
            ).where(Card.user_id == scope.user_id, Card.state != STATE_ARCHIVED)
        )
    ).one()
    vaulted = int(vaulted or 0)
    rewritten = int(rewritten or 0)
    return {
        "total": int(total or 0),
        "vaulted": vaulted,
        "drafts": int(total or 0) - vaulted,
        "rewritten": rewritten,
        "rewrite_rate": round(rewritten / vaulted, 3) if vaulted else 0.0,
        "max_depth": int(max_depth or 0),
        "real_links": int(
            await scope.session.scalar(
                select(func.count(CardLink.id)).where(
                    CardLink.user_id == scope.user_id, CardLink.kind == LINK_REAL
                )
            )
            or 0
        ),
    }


__all__ = ["router", "card_dict", "link_dict", "STATE_DRAFT", "ORIGIN_MANUAL", "CardMessage"]
