"""Workspace 临时画布（PLAN §1.2）。

这里原本还有一套 AI 概念图（Concept / ConceptEdge / CardConcept）。它的节点
是从**小节正文**里抽取的概念，也就是说只有正文生成之后才有内容 —— 刚建完课
时它完全是空的，撑不起「学之前就知道要学什么」这个最重要的诉求。

那个职责现在交给课程自己的学习路径图：节点就是小节，边是
`sections.prerequisite_ids`，大纲一生成就完整可用。概念图整套随之移除，
卡片侧只保留 `cards.concept_tags`（纯标签，供检索、仓库页与勋章统计）。
"""

from __future__ import annotations

from typing import Any

from sqlalchemy import Boolean, Float, ForeignKey, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.types import IdType, JSONType
from app.models._common import TimestampMixin, pk


# ─────────────────────────────────────────────────────────────
# Workspace：临时画布，"先画，后提交"（PLAN §1.2）
# ─────────────────────────────────────────────────────────────
class Workspace(Base, TimestampMixin):
    __tablename__ = "workspaces"

    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    title: Mapped[str] = mapped_column(String(300), default="未命名画布", nullable=False)


class WorkspaceNode(Base):
    __tablename__ = "workspace_nodes"

    id: Mapped[str] = pk()
    workspace_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 引用真实卡；为 NULL 表示临时卡
    card_id: Mapped[str | None] = mapped_column(
        IdType, ForeignKey("cards.id", ondelete="SET NULL"), index=True
    )
    temp_content: Mapped[str] = mapped_column(Text, default="", nullable=False)
    x: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    y: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    color: Mapped[str | None] = mapped_column(String(20))  # 仅本地颜色
    # 真实卡被删除时降级为无链接临时卡，保留在画布里不破坏视觉推理（PLAN §1.2）
    orphaned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)


class WorkspaceEdge(Base):
    __tablename__ = "workspace_edges"

    id: Mapped[str] = pk()
    workspace_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False, index=True
    )
    from_node: Mapped[str] = mapped_column(
        IdType, ForeignKey("workspace_nodes.id", ondelete="CASCADE"), nullable=False
    )
    to_node: Mapped[str] = mapped_column(
        IdType, ForeignKey("workspace_nodes.id", ondelete="CASCADE"), nullable=False
    )
    label: Mapped[str] = mapped_column(String(40), default="continuation", nullable=False)
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    color: Mapped[str | None] = mapped_column(String(20))
    # Apply 之后才写入正式仓库的双链
    applied: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    meta: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
