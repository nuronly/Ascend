"""SQLite / PostgreSQL 双方言适配的自定义列类型。

PLAN 的 schema (§5) 用了 JSONB、vector(1024)、tsvector 等 PG 特性。
本模块把这些差异全部收敛在这里，业务模型只写一套。
切换数据库时只需改 .env 的 DATABASE_URL，模型代码零改动。
"""

from __future__ import annotations

import struct
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy.engine import Dialect
from sqlalchemy.types import TypeDecorator

from app.core.config import settings

# ─────────────────────────────────────────────────────────────
# JSON / JSONB
# ─────────────────────────────────────────────────────────────
# SQLAlchemy 的 JSON 在 PG 上默认落 JSON，这里显式变体到 JSONB 以启用 GIN 索引。
try:  # pragma: no cover - 仅在装了 postgres extra 时可用
    from sqlalchemy.dialects.postgresql import JSONB

    JSONType = sa.JSON().with_variant(JSONB, "postgresql")
except ImportError:  # pragma: no cover
    JSONType = sa.JSON()


# ─────────────────────────────────────────────────────────────
# 时间戳：统一存 UTC，读出必带 tzinfo
# ─────────────────────────────────────────────────────────────
class TZDateTime(TypeDecorator):
    """SQLite 不保存时区信息，会把 aware datetime 读成 naive。

    这会导致 FSRS 排程、番茄钟倒计时出现静默的时区错位 —— 属于那种
    "不报错但数据全错" 的 bug。这里强制：写入转 UTC，读出补 UTC tzinfo。
    """

    impl = sa.DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC)

    def process_result_value(self, value: datetime | None, dialect: Dialect) -> datetime | None:
        if value is None:
            return None
        if value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value.astimezone(UTC)


def utcnow() -> datetime:
    return datetime.now(UTC)


# ─────────────────────────────────────────────────────────────
# 向量：PG 用 pgvector，SQLite 用 float32 BLOB
# ─────────────────────────────────────────────────────────────
class VectorBlob(TypeDecorator):
    """SQLite 侧的向量存储：紧凑 float32 二进制。

    1024 维 = 4KB/条。单用户一年几千张卡 ≈ 十几 MB，
    全量载入内存用 numpy 做余弦相似度，延迟完全可接受（PLAN §3.6 量级测算）。
    切到 PG 后由 pgvector + HNSW 接管，本类型自动让位。
    """

    impl = sa.LargeBinary
    cache_ok = True

    def process_bind_param(
        self, value: list[float] | None, dialect: Dialect
    ) -> bytes | None:
        if value is None:
            return None
        return struct.pack(f"<{len(value)}f", *value)

    def process_result_value(self, value: bytes | None, dialect: Dialect) -> list[float] | None:
        if value is None:
            return None
        return list(struct.unpack(f"<{len(value) // 4}f", value))


def vector_column_type() -> Any:
    """按当前方言返回合适的向量列类型。"""
    if settings.is_postgres:  # pragma: no cover - 需要 postgres extra
        try:
            from pgvector.sqlalchemy import Vector

            return Vector(settings.embedding_dim)
        except ImportError:
            return VectorBlob()
    return VectorBlob()


# ─────────────────────────────────────────────────────────────
# 主键
# ─────────────────────────────────────────────────────────────
# 刻意用 CHAR(32) 而非原生 UUID 类型：两种方言下行为完全一致，
# 导出 JSON / Markdown 时也不需要额外序列化处理（PLAN §4 "数据可无损导出"）。
IdType = sa.String(32)


def new_id() -> str:
    import uuid

    return uuid.uuid4().hex
