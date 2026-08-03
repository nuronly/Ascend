"""系统层：AI 调用日志、LLM 缓存、检索索引（PLAN §4.1 / §5）。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.types import IdType, JSONType, TZDateTime, vector_column_type
from app.models._common import pk


class AICall(Base):
    """成本与调用日志 —— 从第一天就记，否则后期无从优化（PLAN §4.1）。"""

    __tablename__ = "ai_calls"

    id: Mapped[str] = pk()
    user_id: Mapped[str | None] = mapped_column(IdType, index=True)
    # outline / section / card_chat / enrich / translate / rerank / brain / review / image
    scene: Mapped[str] = mapped_column(String(40), nullable=False)
    provider: Mapped[str] = mapped_column(String(30), default="", nullable=False)
    model: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    tier: Mapped[str] = mapped_column(String(20), default="", nullable=False)
    prompt_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    completion_tokens: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    cache_hit: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    success: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    error: Mapped[str | None] = mapped_column(Text)
    # 降级链走了第几跳（0 = 主模型直接成功）
    fallback_hop: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False, index=True)

    __table_args__ = (
        Index("ix_ai_calls_user_created", "user_id", "created_at"),
        Index("ix_ai_calls_scene_created", "scene", "created_at"),
    )


class LLMCache(Base):
    """全链路 hash 缓存：小节正文 / 段落翻译 / embedding（PLAN §4.1）。"""

    __tablename__ = "llm_cache"

    key: Mapped[str] = mapped_column(String(64), primary_key=True)
    scene: Mapped[str] = mapped_column(String(40), default="", nullable=False, index=True)
    model: Mapped[str] = mapped_column(String(120), default="", nullable=False)
    value: Mapped[str] = mapped_column(Text, nullable=False)
    meta: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    hits: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)


class CardSearch(Base):
    """卡片检索索引。

    SQLite：全文走独立的 FTS5 虚拟表（见 app/search/fts.py），
            向量走本表的 float32 BLOB。
    Postgres：本表的 tsv 列换成 tsvector + GIN，embedding 换成 pgvector + HNSW。
    ⚠️ 两种方言下检索都必须先按 user_id 过滤再算相似度（PLAN §4.2 陷阱 4）。
    """

    __tablename__ = "card_search"

    card_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("cards.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(IdType, nullable=False, index=True)
    # jieba 分词后的空格分隔文本；PG 侧再用 to_tsvector 包一层
    tsv: Mapped[str] = mapped_column(Text, default="", nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    embedding: Mapped[Any | None] = mapped_column(vector_column_type())
    embedded_at: Mapped[datetime | None] = mapped_column(TZDateTime)


class BlockSearch(Base):
    __tablename__ = "block_search"

    block_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("doc_blocks.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(IdType, nullable=False, index=True)
    tsv: Mapped[str] = mapped_column(Text, default="", nullable=False)
    content_hash: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    embedding: Mapped[Any | None] = mapped_column(vector_column_type())
    embedded_at: Mapped[datetime | None] = mapped_column(TZDateTime)
