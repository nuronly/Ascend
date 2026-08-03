"""数据库引擎与会话。"""

from __future__ import annotations

import logging
from collections.abc import AsyncIterator
from typing import Any

from sqlalchemy import event, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.core.config import settings

log = logging.getLogger(__name__)


class Base(DeclarativeBase):
    """全部 ORM 模型的基类。"""


def _make_engine():
    kwargs: dict[str, Any] = {"echo": False, "future": True}
    if settings.is_sqlite:
        # SQLite 的 async 驱动是单连接串行的，连接池设置需要保守
        kwargs["connect_args"] = {"timeout": 30}
    else:  # pragma: no cover
        kwargs.update(pool_size=10, max_overflow=20, pool_pre_ping=True)
    return create_async_engine(settings.database_url, **kwargs)


engine = _make_engine()

if settings.is_sqlite:

    @event.listens_for(engine.sync_engine, "connect")
    def _sqlite_pragmas(dbapi_conn, _rec):  # pragma: no cover - 驱动回调
        cur = dbapi_conn.cursor()
        # 外键约束默认关闭，不开的话 ON DELETE CASCADE 全部失效
        cur.execute("PRAGMA foreign_keys=ON")
        # WAL：读写不互相阻塞，SSE 长连接期间仍可写入
        cur.execute("PRAGMA journal_mode=WAL")
        cur.execute("PRAGMA synchronous=NORMAL")
        cur.execute("PRAGMA busy_timeout=30000")
        cur.close()


SessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
)


async def get_session() -> AsyncIterator[AsyncSession]:
    """FastAPI 依赖：每请求一个会话，异常自动回滚。"""
    async with SessionLocal() as session:
        try:
            yield session
        except Exception:
            await session.rollback()
            raise


async def init_db() -> None:
    """建表 + 建全文索引。开发期直接建表，生产走 Alembic。"""
    # 必须先 import 全部模型，元数据才完整
    import app.models  # noqa: F401
    from app.search.fts import ensure_fts

    async with engine.begin() as conn:
        if settings.is_postgres:  # pragma: no cover
            for ext in ("vector", "pg_trgm"):
                try:
                    await conn.execute(text(f"CREATE EXTENSION IF NOT EXISTS {ext}"))
                except Exception as exc:
                    log.warning("创建扩展 %s 失败：%s", ext, exc)
        await conn.run_sync(Base.metadata.create_all)

    await ensure_fts(engine)
    log.info("数据库就绪：%s", settings.database_url.split("://")[0])


async def dispose_db() -> None:
    await engine.dispose()
