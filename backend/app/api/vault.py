"""笔记与卡片仓库 API（PLAN §3.2.1）。

★ 主界面已经从「卡片仓库」改成「笔记」（见 /notes 与 services/note.notebook）：
  卡片整理进仓库其实没人回来看 —— 粒度太碎、网格不是阅读单元、「归档」本身就是
  心理上的完结。卡片因此降级为素材层（仍是划词追问的产物、问题图的节点、
  复习单元），主界面换成真正能读的笔记。

★ 卡片不再有状态分类。原来是 draft →（用户点「收进仓库」）→ vault，但那个动作
  没人愿意做也没人理解：卡片就是卡片，划下来它就存在，索引与摘要在回答写完时
  自动补（services/card.stream_answer 尾部）。state 字段保留，只剩 archived
  还有意义（清理）。笔记卡的 draft → vault 保留 —— 「我改完了，这份算数」
  本来就该由人来说。

拒绝坟场现在靠：FSRS 排程主动推送 + 上下文唤醒（都在 review.py）。
孤岛卡那一路随全局图谱一起撤了。
"""

from __future__ import annotations

from fastapi import APIRouter, Query
from sqlalchemy import Integer, func, select

from app.api.cards import card_dict
from app.api.deps import Scope
from app.models.card import (
    KIND_CARD,
    KIND_NOTE,
    STATE_ARCHIVED,
    STATE_DRAFT,
    STATE_VAULT,
    Card,
)
from app.models.course import Chapter, Course, Section
from app.models.learning import ReviewState
from app.search.fts import search_cards_fts
from app.services import note as note_svc

router = APIRouter(prefix="/vault", tags=["vault"])


@router.get("")
async def list_vault(
    scope: Scope,
    q: str = Query("", max_length=200),
    state: str = Query(STATE_VAULT, pattern="^(draft|vault|archived|all)$"),
    course_id: str | None = None,
    rewritten: bool | None = None,
    has_children: bool | None = None,
    kind: str | None = Query(None, pattern="^(card|note)$"),
    sort: str = Query("recent", pattern="^(recent|oldest|touched|depth)$"),
    limit: int = Query(50, le=200),
    offset: int = Query(0, ge=0),
) -> dict:
    """仓库列表。

    ★ 这里**不默认过滤 kind**：笔记卡（一节汇流成的永久笔记）本身就是知识资产，
      收进仓库后必须能在仓库里找到，否则用户点了「收进仓库」就再也见不到它。
      与卡片空间那张画布相反 —— 那里默认排除笔记卡，因为它会搅乱追问树。
      需要只看笔记时传 kind=note。
    """
    stmt = scope.select(Card)
    if state != "all":
        stmt = stmt.where(Card.state == state)
    if kind:
        stmt = stmt.where(Card.kind == kind)
    if rewritten is not None:
        stmt = stmt.where(Card.is_rewritten.is_(rewritten))
    if course_id:
        await scope.require(Course, course_id, "课程")
        sub = (
            select(Section.id)
            .join(Chapter, Chapter.id == Section.chapter_id)
            .where(Chapter.course_id == course_id)
        )
        stmt = stmt.where(Card.source_section_id.in_(sub))
    if has_children is not None:
        from sqlalchemy.orm import aliased

        kid = aliased(Card)
        exists = select(kid.id).where(kid.parent_card_id == Card.id).exists()
        stmt = stmt.where(exists if has_children else ~exists)

    # 全文检索走 FTS，结果作为 id 集合与其它筛选条件求交
    if q.strip():
        hits = await search_cards_fts(scope.session, scope.user_id, q, limit=400)
        ids = [cid for cid, _ in hits]
        if not ids:
            return {"total": 0, "cards": [], "query": q}
        stmt = stmt.where(Card.id.in_(ids))

    total = await scope.count(stmt)

    order = {
        "recent": Card.created_at.desc(),
        "oldest": Card.created_at.asc(),
        "touched": Card.last_touched_at.desc(),
        "depth": Card.depth.desc(),
    }[sort]
    cards = await scope.all(stmt.order_by(order).offset(offset).limit(limit))

    # 附上溯源信息，让仓库列表能一眼看出这张卡是学什么时候产生的
    section_ids = {c.source_section_id for c in cards if c.source_section_id}
    origins: dict[str, dict] = {}
    if section_ids:
        rows = await scope.session.execute(
            select(Section.id, Section.title, Course.id, Course.title)
            .join(Chapter, Chapter.id == Section.chapter_id)
            .join(Course, Course.id == Chapter.course_id)
            .where(Section.id.in_(section_ids), Course.user_id == scope.user_id)
        )
        origins = {
            sid: {"section_title": st, "course_id": cid, "course_title": ct}
            for sid, st, cid, ct in rows
        }

    due_map = dict(
        (
            await scope.session.execute(
                select(ReviewState.card_id, ReviewState.due_date).where(
                    ReviewState.user_id == scope.user_id,
                    ReviewState.card_id.in_([c.id for c in cards] or [""]),
                )
            )
        ).all()
    )

    out = []
    for c in cards:
        d = card_dict(c, with_messages=False)
        d["origin_info"] = origins.get(c.source_section_id or "", {})
        if due := due_map.get(c.id):
            d["due_date"] = due.isoformat()
        out.append(d)

    return {"total": total, "cards": out, "query": q}


@router.get("/notes")
async def notebook(scope: Scope) -> dict:
    """笔记主视图：按课程分组的全部笔记 + 未消化的疑问数。

    「卡片整理进仓库其实也不会有人看」—— 所以主界面换成笔记，卡片降级为素材层。
    理由与 undigested 的口径见 services/note.notebook。
    """
    return await note_svc.notebook(scope)


# 孤岛卡端点已删除：它的定义建立在全局图谱之上，而图谱整块已撤。
# 卡片现在绑定在小节与笔记上，「有没有归属」不再是一个问题。


@router.get("/overview")
async def overview(scope: Scope) -> dict:
    """概览：给首页与笔记页用。

    ★ 己见率（rewrite_rate）已从界面撤下。它当初是「比学习时长诚实」的深度指标，
      但那时己见挂在卡片上；现在整理发生在笔记里（笔记的「我的理解」那一节），
      再按卡片算一个比例就既不准也没人看。字段暂留以兼容历史数据与导出，
      界面不再展示。
    """
    total, vaulted, drafts, rewritten = (
        await scope.session.execute(
            select(
                func.count(Card.id),
                func.sum(func.cast(Card.state == STATE_VAULT, Integer)),
                func.sum(func.cast(Card.state == STATE_DRAFT, Integer)),
                func.sum(func.cast(Card.is_rewritten, Integer)),
            ).where(
                Card.user_id == scope.user_id,
                Card.state != STATE_ARCHIVED,
                Card.kind == KIND_CARD,
            )
        )
    ).one()

    # 笔记口径：主界面是笔记，指标也该以它为主
    notes_total, notes_done = (
        await scope.session.execute(
            select(
                func.count(Card.id),
                func.sum(func.cast(Card.state == STATE_VAULT, Integer)),
            ).where(
                Card.user_id == scope.user_id,
                Card.kind == KIND_NOTE,
                Card.state != STATE_ARCHIVED,
            )
        )
    ).one()

    by_course = list(
        (
            await scope.session.execute(
                select(Course.id, Course.title, func.count(Card.id))
                .join(Chapter, Chapter.course_id == Course.id)
                .join(Section, Section.chapter_id == Chapter.id)
                .join(Card, Card.source_section_id == Section.id)
                .where(Course.user_id == scope.user_id, Card.state != STATE_ARCHIVED)
                .group_by(Course.id, Course.title)
                .order_by(func.count(Card.id).desc())
                .limit(10)
            )
        ).all()
    )

    top_concepts: dict[str, int] = {}
    for (tags,) in await scope.session.execute(
        select(Card.concept_tags).where(
            Card.user_id == scope.user_id, Card.state == STATE_VAULT
        )
    ):
        for t in tags or []:
            top_concepts[str(t)] = top_concepts.get(str(t), 0) + 1

    vaulted = int(vaulted or 0)
    return {
        "total": int(total or 0),
        "vaulted": vaulted,
        "drafts": int(drafts or 0),
        "rewritten": int(rewritten or 0),
        "notes": int(notes_total or 0),
        "notes_done": int(notes_done or 0),
        # 界面已不展示（见函数注释），保留供导出与历史数据兼容
        "rewrite_rate": round(int(rewritten or 0) / vaulted, 3) if vaulted else 0.0,
        "by_course": [{"id": i, "title": t, "count": n} for i, t, n in by_course],
        "top_concepts": sorted(
            ({"name": k, "count": v} for k, v in top_concepts.items()),
            key=lambda x: -x["count"],
        )[:20],
    }


@router.get("/search")
async def search(scope: Scope, q: str = Query(min_length=1, max_length=200), limit: int = 20) -> dict:
    """全局卡片检索。中文经 jieba 分词后走 FTS5 / tsvector。"""
    hits = await search_cards_fts(scope.session, scope.user_id, q, limit=limit)
    if not hits:
        return {"cards": []}
    ranks = {cid: i for i, (cid, _) in enumerate(hits)}
    cards = await scope.all(scope.select(Card).where(Card.id.in_(list(ranks))))
    cards.sort(key=lambda c: ranks.get(c.id, 999))
    return {"cards": [card_dict(c, with_messages=False) for c in cards]}


@router.get("/timeline")
async def timeline(scope: Scope, days: int = Query(90, ge=1, le=365)) -> dict:
    """卡片产出时间线，给热力图用。"""
    from datetime import timedelta

    from app.core.types import utcnow

    since = utcnow() - timedelta(days=days)
    rows = await scope.all(
        scope.select(Card)
        .where(Card.created_at >= since, Card.state != STATE_ARCHIVED)
        .order_by(Card.created_at)
    )
    buckets: dict[str, dict] = {}
    for c in rows:
        k = c.created_at.date().isoformat()
        b = buckets.setdefault(k, {"date": k, "cards": 0, "vaulted": 0, "rewritten": 0})
        b["cards"] += 1
        if c.state == STATE_VAULT:
            b["vaulted"] += 1
        if c.is_rewritten:
            b["rewritten"] += 1
    return {"days": sorted(buckets.values(), key=lambda d: d["date"])}


__all__ = ["router"]
