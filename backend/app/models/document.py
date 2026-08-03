"""文档模式（v0.3；表结构 v0.1 先建好，PLAN §3.5 / §5）。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base
from app.core.types import IdType, JSONType, TZDateTime
from app.models._common import TimestampMixin, pk

DOC_PENDING = "pending"
DOC_PARSING = "parsing"
DOC_READY = "ready"
DOC_FAILED = "failed"


class Document(Base, TimestampMixin):
    __tablename__ = "documents"

    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    filename: Mapped[str] = mapped_column(String(500), nullable=False)
    title: Mapped[str] = mapped_column(String(500), default="", nullable=False)
    mime: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    # 原始来源：upload / arxiv / url
    origin: Mapped[str] = mapped_column(String(20), default="upload", nullable=False)
    source_url: Mapped[str | None] = mapped_column(Text)
    storage_path: Mapped[str | None] = mapped_column(Text)
    page_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    parse_status: Mapped[str] = mapped_column(String(20), default=DOC_PENDING, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    meta: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)

    blocks: Mapped[list[DocBlock]] = relationship(
        back_populates="document", cascade="all, delete-orphan", lazy="noload"
    )

    __table_args__ = (Index("ix_documents_user_created", "user_id", "created_at"),)


class DocBlock(Base):
    __tablename__ = "doc_blocks"

    id: Mapped[str] = pk()
    doc_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("documents.id", ondelete="CASCADE"), nullable=False, index=True
    )
    page: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    idx: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # paragraph / heading / code / formula / figure / table
    block_type: Mapped[str] = mapped_column(String(20), default="paragraph", nullable=False)
    text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    bbox: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    # 翻译缓存 key —— 同一篇翻两次不能重复烧钱（PLAN §3.5 硬要求）
    text_hash: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    translation: Mapped[str | None] = mapped_column(Text)
    translated_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    document: Mapped[Document] = relationship(back_populates="blocks")

    __table_args__ = (
        Index("ix_doc_blocks_doc_order", "doc_id", "page", "idx"),
        Index("ix_doc_blocks_hash", "text_hash"),
    )
