"""概念图（AI 侧）与 Workspace 临时画布（PLAN §1.2 / §3.4 / §5）。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, Float, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.types import IdType, JSONType, TZDateTime
from app.models._common import TimestampMixin, pk


# ─────────────────────────────────────────────────────────────
# AI 概念图：客观的"这个领域长什么样"
# ─────────────────────────────────────────────────────────────
class Concept(Base):
    __tablename__ = "concepts"

    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    course_id: Mapped[str | None] = mapped_column(
        IdType, ForeignKey("courses.id", ondelete="CASCADE"), index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    # 归一化后的名字，用于去重与匹配卡片标签
    norm_name: Mapped[str] = mapped_column(String(200), nullable=False, index=True)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    section_id: Mapped[str | None] = mapped_column(
        IdType, ForeignKey("sections.id", ondelete="SET NULL"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)

    __table_args__ = (
        Index("uq_concepts_course_name", "course_id", "norm_name", unique=True),
        Index("ix_concepts_user", "user_id"),
    )


class ConceptEdge(Base):
    __tablename__ = "concept_edges"

    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    course_id: Mapped[str | None] = mapped_column(
        IdType, ForeignKey("courses.id", ondelete="CASCADE"), index=True
    )
    from_concept: Mapped[str] = mapped_column(
        IdType, ForeignKey("concepts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    to_concept: Mapped[str] = mapped_column(
        IdType, ForeignKey("concepts.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # prerequisite / part_of / related / contrast
    relation: Mapped[str] = mapped_column(String(20), default="related", nullable=False)

    __table_args__ = (
        Index("uq_concept_edges", "from_concept", "to_concept", "relation", unique=True),
    )


class CardConcept(Base):
    """叠加视图的连接桥（PLAN §3.4 ★ 杀手锏）。"""

    __tablename__ = "card_concepts"

    card_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("cards.id", ondelete="CASCADE"), primary_key=True
    )
    concept_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("concepts.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(IdType, nullable=False, index=True)
    weight: Mapped[float] = mapped_column(Float, default=1.0, nullable=False)


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
