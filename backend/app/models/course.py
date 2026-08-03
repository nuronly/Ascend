"""课程 / 章 / 节（PLAN §3.1 / §5）。

核心约束：小节正文 **懒生成** —— 只有用户点进去才生成，生成后缓存。
content_status 就是这套懒生成状态机的载体。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base
from app.core.types import IdType, JSONType, TZDateTime
from app.models._common import TimestampMixin, pk

# courses.status
COURSE_DRAFT = "draft"  # 刚建，大纲还没出来
COURSE_OUTLINING = "outlining"  # 大纲生成中
COURSE_READY = "ready"  # 大纲已就绪，小节按需生成
COURSE_FAILED = "failed"
COURSE_ARCHIVED = "archived"

# sections.content_status —— 懒生成状态机
SECTION_PENDING = "pending"  # 还没生成过
SECTION_GENERATING = "generating"  # 正在流式生成
SECTION_READY = "ready"  # 已缓存，直接读库
SECTION_FAILED = "failed"


class Course(Base, TimestampMixin):
    __tablename__ = "courses"

    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    topic: Mapped[str] = mapped_column(String(500), nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    status: Mapped[str] = mapped_column(String(20), default=COURSE_DRAFT, nullable=False)
    # 用户指定的难度/侧重/背景，影响后续每一节的生成
    level: Mapped[str] = mapped_column(String(20), default="intermediate", nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    meta: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)

    chapters: Mapped[list[Chapter]] = relationship(
        back_populates="course",
        cascade="all, delete-orphan",
        order_by="Chapter.idx",
        lazy="selectin",
    )

    __table_args__ = (Index("ix_courses_user_status", "user_id", "status", "created_at"),)


class Chapter(Base):
    __tablename__ = "chapters"

    id: Mapped[str] = pk()
    course_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    idx: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)

    course: Mapped[Course] = relationship(back_populates="chapters")
    sections: Mapped[list[Section]] = relationship(
        back_populates="chapter",
        cascade="all, delete-orphan",
        order_by="Section.idx",
        lazy="selectin",
    )


class Section(Base):
    __tablename__ = "sections"

    id: Mapped[str] = pk()
    chapter_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("chapters.id", ondelete="CASCADE"), nullable=False, index=True
    )
    idx: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # 喂给番茄钟做时长对齐（PLAN §3.3）
    est_minutes: Mapped[int] = mapped_column(Integer, default=25, nullable=False)

    content_md: Mapped[str | None] = mapped_column(Text)
    content_status: Mapped[str] = mapped_column(
        String(20), default=SECTION_PENDING, nullable=False
    )
    # 供 AI 概念图抽取节点，避免二次调用（PLAN §3.1）
    key_concepts: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    prerequisite_ids: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    generated_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    # 用户点过"讲浅一点/深一点/换个例子"的次数，用于展示"已重生成 N 次"
    regenerate_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # 学习进度
    completed_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    chapter: Mapped[Chapter] = relationship(back_populates="sections")

    __table_args__ = (Index("ix_sections_chapter_idx", "chapter_id", "idx"),)
