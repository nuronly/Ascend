"""双图谱 API（PLAN §3.4）。

两张图人格不同：
  · AI 概念图   —— "这个领域长什么样"（客观），只读为主
  · 卡片图      —— "我怎么想的"（主观、有时间性），可拖拽可编辑

★ 叠加视图是杀手锏，不是附赠功能：AI 图做底图，用户卡片作为挂件钉在
  对应概念旁，一眼看到「这个领域我啃过哪几块、哪几块一片空白」，
  空白区域**反向驱动学习**。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select

from app.api.cards import card_dict, link_dict
from app.api.deps import CurrentUser, Scope, user_quota
from app.core.types import new_id, utcnow
from app.models.card import (
    LINK_REAL,
    STATE_ARCHIVED,
    STATE_VAULT,
    Card,
    CardLink,
)
from app.models.course import Chapter, Course, Section
from app.models.graph import (
    CardConcept,
    Concept,
    ConceptEdge,
    Workspace,
    WorkspaceEdge,
    WorkspaceNode,
)

router = APIRouter(prefix="/graph", tags=["graph"])


# ─────────────────────────────────────────────────────────────
# 卡片图（我的问题图）
# ─────────────────────────────────────────────────────────────
@router.get("/cards")
async def card_graph(
    scope: Scope,
    course_id: str | None = None,
    state: str = Query("vault", pattern="^(vault|all)$"),
    limit: int = Query(800, le=3000),
) -> dict:
    stmt = scope.select(Card)
    stmt = (
        stmt.where(Card.state == STATE_VAULT)
        if state == "vault"
        else stmt.where(Card.state != STATE_ARCHIVED)
    )
    if course_id:
        await scope.require(Course, course_id, "课程")
        sub = (
            select(Section.id)
            .join(Chapter, Chapter.id == Section.chapter_id)
            .where(Chapter.course_id == course_id)
        )
        stmt = stmt.where(Card.source_section_id.in_(sub))

    cards = await scope.all(stmt.order_by(Card.created_at).limit(limit))
    ids = [c.id for c in cards]

    links = (
        await scope.all(
            scope.select(CardLink).where(
                CardLink.from_card_id.in_(ids),
                CardLink.to_card_id.in_(ids),
                CardLink.dismissed_at.is_(None),
            )
        )
        if ids
        else []
    )

    return {
        "nodes": [
            {
                "id": c.id,
                "label": c.summary or c.selected_text or c.question[:40],
                "depth": c.depth,
                "is_rewritten": c.is_rewritten,  # 己见卡 → 实心描边
                "state": c.state,
                "parent_card_id": c.parent_card_id,
                "concept_tags": list(c.concept_tags or []),
                "touch_count": c.touch_count,
                "created_at": c.created_at.isoformat(),
                "section_id": c.source_section_id,
            }
            for c in cards
        ],
        # 父子链也是图的一部分，但它是结构性的，与用户手建的 real link 分开表达
        "parent_edges": [
            {"from": c.parent_card_id, "to": c.id, "kind": "parent"}
            for c in cards
            if c.parent_card_id and c.parent_card_id in set(ids)
        ],
        "links": [link_dict(link) for link in links],
    }


# ─────────────────────────────────────────────────────────────
# AI 概念图
# ─────────────────────────────────────────────────────────────
@router.get("/concepts")
async def concept_graph(scope: Scope, course_id: str | None = None) -> dict:
    stmt = scope.select(Concept)
    estmt = scope.select(ConceptEdge)
    if course_id:
        await scope.require(Course, course_id, "课程")
        stmt = stmt.where(Concept.course_id == course_id)
        estmt = estmt.where(ConceptEdge.course_id == course_id)

    concepts = await scope.all(stmt)
    edges = await scope.all(estmt)
    ids = {c.id for c in concepts}

    # 每个概念挂了多少张卡 —— 叠加视图的核心数据
    counts = dict(
        (
            await scope.session.execute(
                select(CardConcept.concept_id, func.count(CardConcept.card_id))
                .join(Card, Card.id == CardConcept.card_id)
                .where(
                    CardConcept.user_id == scope.user_id,
                    Card.user_id == scope.user_id,
                    Card.state != STATE_ARCHIVED,
                )
                .group_by(CardConcept.concept_id)
            )
        ).all()
    )
    rewritten = dict(
        (
            await scope.session.execute(
                select(CardConcept.concept_id, func.count(CardConcept.card_id))
                .join(Card, Card.id == CardConcept.card_id)
                .where(
                    CardConcept.user_id == scope.user_id,
                    Card.user_id == scope.user_id,
                    Card.is_rewritten.is_(True),
                )
                .group_by(CardConcept.concept_id)
            )
        ).all()
    )

    return {
        "nodes": [
            {
                "id": c.id,
                "label": c.name,
                "description": c.description,
                "section_id": c.section_id,
                "course_id": c.course_id,
                "card_count": int(counts.get(c.id, 0)),
                "rewritten_count": int(rewritten.get(c.id, 0)),
            }
            for c in concepts
        ],
        "edges": [
            {"id": e.id, "from": e.from_concept, "to": e.to_concept, "relation": e.relation}
            for e in edges
            if e.from_concept in ids and e.to_concept in ids
        ],
    }


@router.get("/overlay")
async def overlay(scope: Scope, course_id: str) -> dict:
    """★ 叠加视图。

    AI 概念图做底图（浅色），卡片作为挂件钉在对应概念节点旁。
    卡片密集区 = 困难区 = 复习优先区；
    空白区 = 一个问题都没提过 = 反向驱动学习的入口。
    """
    await scope.require(Course, course_id, "课程")
    concepts = await concept_graph(scope, course_id)

    pairs = list(
        (
            await scope.session.execute(
                select(CardConcept.concept_id, CardConcept.card_id, Card.is_rewritten, Card.summary)
                .join(Card, Card.id == CardConcept.card_id)
                .where(
                    CardConcept.user_id == scope.user_id,
                    Card.user_id == scope.user_id,
                    Card.state != STATE_ARCHIVED,
                )
            )
        ).all()
    )
    attach: dict[str, list[dict]] = {}
    for concept_id, card_id, is_rw, summary in pairs:
        attach.setdefault(concept_id, []).append(
            {"card_id": card_id, "is_rewritten": bool(is_rw), "label": summary or ""}
        )

    covered = {n["id"] for n in concepts["nodes"] if n["card_count"] > 0}
    blank = [n for n in concepts["nodes"] if n["id"] not in covered]

    return {
        **concepts,
        "attachments": attach,
        # 这份 blank_spots 直接驱动「要生成一节强化课吗」的提示
        "blank_spots": [{"id": n["id"], "label": n["label"]} for n in blank],
        "coverage": round(len(covered) / len(concepts["nodes"]), 3) if concepts["nodes"] else 0.0,
    }


@router.post("/reinforce")
async def reinforce(
    scope: Scope, user: CurrentUser, course_id: str, concept: str = Query(max_length=200)
) -> dict:
    """从图上的空白处一键生成强化课（PLAN §3.4 / v0.2 交付标准）。"""
    from app.models.course import COURSE_OUTLINING
    from app.services.course import generate_outline

    parent = await scope.require(Course, course_id, "课程")
    new_course = Course(
        id=new_id(),
        user_id=scope.user_id,
        topic=f"{concept}（{parent.title} 强化）",
        title=f"{concept} 强化",
        level=parent.level,
        status=COURSE_OUTLINING,
        meta={
            "reinforce_of": parent.id,
            "extra": f"这是针对「{concept}」的专项强化课，学习者在《{parent.title}》中"
            f"对这块还没有提出过任何问题，说明可能存在盲区。请聚焦这一个概念展开，"
            f"不要泛讲整个领域。",
        },
    )
    scope.add(new_course)
    await scope.commit()
    await generate_outline(scope, new_course, quota=user_quota(user))
    return {"course_id": new_course.id, "title": new_course.title}


# ─────────────────────────────────────────────────────────────
# Workspace：临时画布（PLAN §1.2）
# ─────────────────────────────────────────────────────────────
class WorkspaceIn(BaseModel):
    title: str = Field(default="未命名画布", max_length=300)


class NodeIn(BaseModel):
    card_id: str | None = None
    temp_content: str = Field(default="", max_length=8000)
    x: float = 0.0
    y: float = 0.0
    color: str | None = Field(default=None, max_length=20)


class NodeUpdateIn(BaseModel):
    temp_content: str | None = Field(default=None, max_length=8000)
    x: float | None = None
    y: float | None = None
    color: str | None = Field(default=None, max_length=20)


class EdgeIn(BaseModel):
    from_node: str
    to_node: str
    label: str = Field(default="continuation", max_length=40)
    note: str = Field(default="", max_length=1000)
    color: str | None = Field(default=None, max_length=20)


@router.get("/workspaces")
async def list_workspaces(scope: Scope) -> list[dict]:
    rows = await scope.all(scope.select(Workspace).order_by(Workspace.updated_at.desc()))
    return [
        {"id": w.id, "title": w.title, "updated_at": w.updated_at.isoformat()} for w in rows
    ]


@router.post("/workspaces", status_code=status.HTTP_201_CREATED)
async def create_workspace(body: WorkspaceIn, scope: Scope) -> dict:
    w = Workspace(id=new_id(), user_id=scope.user_id, title=body.title)
    scope.add(w)
    await scope.commit()
    return {"id": w.id, "title": w.title}


@router.get("/workspaces/{ws_id}")
async def get_workspace(ws_id: str, scope: Scope) -> dict:
    w = await scope.require(Workspace, ws_id, "画布")
    nodes = await scope.all(
        select(WorkspaceNode).where(WorkspaceNode.workspace_id == w.id)
    )
    edges = await scope.all(
        select(WorkspaceEdge).where(WorkspaceEdge.workspace_id == w.id)
    )

    # 引用的真实卡：逐张走 scope 取，天然防越权
    cards: dict[str, dict] = {}
    for n in nodes:
        if n.card_id and n.card_id not in cards:
            c = await scope.get(Card, n.card_id)
            if c:
                cards[c.id] = card_dict(c, with_messages=False)
            else:
                # 真实卡被删 → 降级为无链接临时卡，保留在画布里不破坏视觉推理
                n.orphaned = True
                n.temp_content = n.temp_content or "（原卡片已删除）"
                n.card_id = None
    await scope.commit()

    return {
        "id": w.id,
        "title": w.title,
        "nodes": [
            {
                "id": n.id,
                "card_id": n.card_id,
                "temp_content": n.temp_content,
                "x": n.x,
                "y": n.y,
                "color": n.color,
                "orphaned": n.orphaned,
            }
            for n in nodes
        ],
        "edges": [
            {
                "id": e.id,
                "from_node": e.from_node,
                "to_node": e.to_node,
                "label": e.label,
                "note": e.note,
                "color": e.color,
                "applied": e.applied,
            }
            for e in edges
        ],
        "cards": cards,
    }


@router.post("/workspaces/{ws_id}/nodes", status_code=status.HTTP_201_CREATED)
async def add_node(ws_id: str, body: NodeIn, scope: Scope) -> dict:
    w = await scope.require(Workspace, ws_id, "画布")
    if body.card_id:
        await scope.require_card(body.card_id)
    n = WorkspaceNode(
        id=new_id(),
        workspace_id=w.id,
        card_id=body.card_id,
        temp_content=body.temp_content,
        x=body.x,
        y=body.y,
        color=body.color,
    )
    scope.add(n)
    w.updated_at = utcnow()
    await scope.commit()
    return {"id": n.id}


@router.patch("/workspaces/{ws_id}/nodes/{node_id}")
async def update_node(ws_id: str, node_id: str, body: NodeUpdateIn, scope: Scope) -> dict:
    await scope.require(Workspace, ws_id, "画布")
    n = await scope.one_or_none(
        select(WorkspaceNode).where(
            WorkspaceNode.id == node_id, WorkspaceNode.workspace_id == ws_id
        )
    )
    if n is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "节点不存在")
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(n, k, v)
    await scope.commit()
    return {"ok": True}


@router.delete("/workspaces/{ws_id}/nodes/{node_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_node(ws_id: str, node_id: str, scope: Scope) -> None:
    await scope.require(Workspace, ws_id, "画布")
    n = await scope.one_or_none(
        select(WorkspaceNode).where(
            WorkspaceNode.id == node_id, WorkspaceNode.workspace_id == ws_id
        )
    )
    if n:
        await scope.session.delete(n)
        await scope.commit()


@router.post("/workspaces/{ws_id}/edges", status_code=status.HTTP_201_CREATED)
async def add_edge(ws_id: str, body: EdgeIn, scope: Scope) -> dict:
    await scope.require(Workspace, ws_id, "画布")
    e = WorkspaceEdge(
        id=new_id(),
        workspace_id=ws_id,
        from_node=body.from_node,
        to_node=body.to_node,
        label=body.label,
        note=body.note,
        color=body.color,
    )
    scope.add(e)
    await scope.commit()
    return {"id": e.id}


@router.delete("/workspaces/{ws_id}/edges/{edge_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_edge(ws_id: str, edge_id: str, scope: Scope) -> None:
    await scope.require(Workspace, ws_id, "画布")
    e = await scope.one_or_none(
        select(WorkspaceEdge).where(
            WorkspaceEdge.id == edge_id, WorkspaceEdge.workspace_id == ws_id
        )
    )
    if e:
        await scope.session.delete(e)
        await scope.commit()


@router.post("/workspaces/{ws_id}/apply")
async def apply_workspace(ws_id: str, scope: Scope) -> dict:
    """★ Apply 之后才写入正式仓库的双链（PLAN §1.2 "先画，后提交"）。

    这道闸门避免了「随手一问就污染知识图」—— 关系不确定时先在画布上
    画草稿，想清楚了再提交。
    """
    await scope.require(Workspace, ws_id, "画布")
    nodes = {
        n.id: n
        for n in await scope.all(select(WorkspaceNode).where(WorkspaceNode.workspace_id == ws_id))
    }
    edges = await scope.all(
        select(WorkspaceEdge).where(
            WorkspaceEdge.workspace_id == ws_id, WorkspaceEdge.applied.is_(False)
        )
    )

    applied = skipped = 0
    for e in edges:
        a, b = nodes.get(e.from_node), nodes.get(e.to_node)
        # 只有两端都是真实卡才能提交成双链；临时卡留在画布上
        if not a or not b or not a.card_id or not b.card_id:
            skipped += 1
            continue
        if not await scope.get(Card, a.card_id) or not await scope.get(Card, b.card_id):
            skipped += 1
            continue

        dup = await scope.one_or_none(
            scope.select(CardLink).where(
                or_(
                    (CardLink.from_card_id == a.card_id) & (CardLink.to_card_id == b.card_id),
                    (CardLink.from_card_id == b.card_id) & (CardLink.to_card_id == a.card_id),
                )
            )
        )
        if dup:
            dup.kind, dup.relation, dup.note = LINK_REAL, e.label, e.note or dup.note
            dup.promoted_at = dup.promoted_at or utcnow()
            dup.dismissed_at = None
        else:
            scope.add(
                CardLink(
                    id=new_id(),
                    user_id=scope.user_id,
                    from_card_id=a.card_id,
                    to_card_id=b.card_id,
                    kind=LINK_REAL,
                    relation=e.label,
                    note=e.note,
                    created_by="user",
                    created_at=utcnow(),
                )
            )
        e.applied = True
        applied += 1

    await scope.commit()
    return {"applied": applied, "skipped": skipped}


@router.delete("/workspaces/{ws_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_workspace(ws_id: str, scope: Scope) -> None:
    w = await scope.require(Workspace, ws_id, "画布")
    await scope.session.delete(w)
    await scope.commit()
