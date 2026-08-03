"""全文检索的方言适配层。

SQLite  → FTS5 虚拟表（本文件负责建表与查询）
Postgres → tsvector + GIN（同一套接口，切库时只有本文件内部分支变化）

两边共用的前提：写入前先用 jieba 分好词（见 tokenize.py）。
"""

from __future__ import annotations

import logging

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.config import settings
from app.search.tokenize import to_fts_query

log = logging.getLogger(__name__)

CARD_FTS = "card_fts"
BLOCK_FTS = "block_fts"


async def ensure_fts(engine: AsyncEngine) -> None:
    """建立全文索引结构。幂等，每次启动都可安全调用。"""
    async with engine.begin() as conn:
        if settings.is_postgres:  # pragma: no cover
            for tbl in ("card_search", "block_search"):
                await conn.execute(
                    text(
                        f"CREATE INDEX IF NOT EXISTS ix_{tbl}_tsv ON {tbl} "
                        f"USING GIN (to_tsvector('simple', tsv))"
                    )
                )
            log.info("PostgreSQL 全文索引就绪")
            return

        # FTS5 虚拟表。content 已是 jieba 分好的空格分隔文本，
        # 所以这里用 unicode61 分词器正好按空格切，不会把整句中文吞掉。
        await conn.execute(
            text(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS {CARD_FTS} USING fts5("
                "  card_id UNINDEXED,"
                "  user_id UNINDEXED,"
                "  content,"
                "  tokenize='unicode61 remove_diacritics 2'"
                ")"
            )
        )
        await conn.execute(
            text(
                f"CREATE VIRTUAL TABLE IF NOT EXISTS {BLOCK_FTS} USING fts5("
                "  block_id UNINDEXED,"
                "  user_id UNINDEXED,"
                "  content,"
                "  tokenize='unicode61 remove_diacritics 2'"
                ")"
            )
        )
        log.info("SQLite FTS5 索引就绪")


async def upsert_card_fts(session: AsyncSession, card_id: str, user_id: str, content: str) -> None:
    if settings.is_postgres:
        return  # PG 侧由 card_search.tsv 列承载，无需额外表
    await session.execute(
        text(f"DELETE FROM {CARD_FTS} WHERE card_id = :cid"), {"cid": card_id}
    )
    if content.strip():
        await session.execute(
            text(f"INSERT INTO {CARD_FTS} (card_id, user_id, content) VALUES (:cid, :uid, :c)"),
            {"cid": card_id, "uid": user_id, "c": content},
        )


async def delete_card_fts(session: AsyncSession, card_id: str) -> None:
    if settings.is_postgres:
        return
    await session.execute(text(f"DELETE FROM {CARD_FTS} WHERE card_id = :cid"), {"cid": card_id})


async def search_cards_fts(
    session: AsyncSession, user_id: str, query: str, limit: int = 30
) -> list[tuple[str, float]]:
    """返回 [(card_id, score)]，score 越大越相关。

    ⚠️ user_id 过滤必须写在 SQL 里，不能在应用层再滤 —— 那样会漏召回，
    而且是跨用户越权的高发点（PLAN §4.2 / §7 风险 #12）。
    """
    if settings.is_postgres:  # pragma: no cover
        rows = await session.execute(
            text(
                "SELECT card_id, ts_rank(to_tsvector('simple', tsv), "
                "       plainto_tsquery('simple', :q)) AS score "
                "FROM card_search "
                "WHERE user_id = :uid "
                "  AND to_tsvector('simple', tsv) @@ plainto_tsquery('simple', :q) "
                "ORDER BY score DESC LIMIT :lim"
            ),
            {"uid": user_id, "q": query, "lim": limit},
        )
        return [(r[0], float(r[1])) for r in rows]

    match = to_fts_query(query)
    if not match:
        return []
    rows = await session.execute(
        text(
            f"SELECT card_id, -bm25({CARD_FTS}) AS score "
            f"FROM {CARD_FTS} "
            f"WHERE {CARD_FTS} MATCH :q AND user_id = :uid "
            f"ORDER BY score DESC LIMIT :lim"
        ),
        {"q": match, "uid": user_id, "lim": limit},
    )
    return [(r[0], float(r[1])) for r in rows]
