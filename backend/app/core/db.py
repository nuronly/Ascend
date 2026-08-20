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
    # 用解析后的绝对路径，行为与启动时的工作目录无关
    return create_async_engine(settings.resolved_database_url, **kwargs)


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
        await _migrate_light(conn)

    await ensure_fts(engine)

    if settings.is_sqlite:
        await _sqlite_checkpoint()

    log.info("数据库就绪：%s", settings.resolved_database_url.split("://")[0])


async def _migrate_light(conn) -> None:
    """轻量迁移：给已存在的库补新列。

    create_all 只建缺失的表，不会给已有表加列。项目没有引入 Alembic
     migration 链（表结构在设计时一次埋齐，新增列极少），
    所以用「查 pragma，缺就补」的最小方案，SQLite / PostgreSQL 通用。
    """
    if settings.is_sqlite:
        rows = (await conn.execute(text("PRAGMA table_info(users)"))).all()
        cols = {r[1] for r in rows}
        if "is_guest" not in cols:
            await conn.execute(
                text("ALTER TABLE users ADD COLUMN is_guest BOOLEAN NOT NULL DEFAULT 0")
            )
            log.info("迁移：users 表补充 is_guest 列")

        # est_minutes 已废弃（AI 估不准个体阅读耗时）。
        # SQLite 3.35+ 原生支持 DROP COLUMN，无需重建表
        rows = (await conn.execute(text("PRAGMA table_info(sections)"))).all()
        if "est_minutes" in {r[1] for r in rows}:
            await conn.execute(text("ALTER TABLE sections DROP COLUMN est_minutes"))
            log.info("迁移：sections 表删除 est_minutes 列")

        # luhmann_id 已废弃：parent_card_id + depth 已完整表达追问树
        rows = (await conn.execute(text("PRAGMA table_info(cards)"))).all()
        if "luhmann_id" in {r[1] for r in rows}:
            await conn.execute(text("ALTER TABLE cards DROP COLUMN luhmann_id"))
            log.info("迁移：cards 表删除 luhmann_id 列")

        # AI 联网检索推荐的参考资料。JSONType 在 SQLite 上落成 TEXT，
        # 所以默认值给字符串 '[]' 而不是 SQL 的 JSON 字面量
        for table in ("courses", "sections"):
            rows = (await conn.execute(text(f"PRAGMA table_info({table})"))).all()
            if "resources" not in {r[1] for r in rows}:
                await conn.execute(
                    text(f"ALTER TABLE {table} ADD COLUMN resources TEXT NOT NULL DEFAULT '[]'")
                )
                log.info("迁移：%s 表补充 resources 列", table)
    else:  # pragma: no cover
        await conn.execute(
            text("ALTER TABLE users ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT FALSE")
        )
        await conn.execute(text("ALTER TABLE sections DROP COLUMN IF EXISTS est_minutes"))
        await conn.execute(text("ALTER TABLE cards DROP COLUMN IF EXISTS luhmann_id"))
        for table in ("courses", "sections"):
            await conn.execute(
                text(f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS resources JSONB NOT NULL DEFAULT '[]'")
            )


async def _sqlite_checkpoint() -> None:
    """把 WAL 合并回主文件并清空日志。

    WAL 模式下写入先进 ladder.db-wal，主文件迟迟不更新。
    不主动 checkpoint 的话，主文件可能一直是 4KB 空壳而数据全在
    -wal 里 —— 谁要是只复制了主文件，数据就"消失"了。
    启动和正常关闭时各做一次，让主文件始终承载全量数据。
    """
    try:
        async with engine.begin() as conn:
            await conn.execute(text("PRAGMA wal_checkpoint(TRUNCATE)"))
    except Exception as exc:
        log.warning("WAL checkpoint 失败（不影响功能）：%s", exc)


async def dispose_db() -> None:
    if settings.is_sqlite:
        await _sqlite_checkpoint()
    await engine.dispose()
