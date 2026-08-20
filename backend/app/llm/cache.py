"""LLM 侧的内容缓存。

同一份输入不重复付费：对话按内容 hash、embedding 按文本 hash、
联网检索按查询词 hash，共用 llm_cache 一张表。

缓存失败一律吞掉 —— 它是省钱手段，不是正确性的一部分。
读不到就当没缓存，写不进就下次再写，绝不能因此让主流程失败。
"""

from __future__ import annotations

import hashlib
import logging

from app.core.db import SessionLocal
from app.core.types import utcnow
from app.models.system import LLMCache

log = logging.getLogger(__name__)


def cache_key(*parts: str) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode())
        h.update(b"\x00")
    return h.hexdigest()


async def cache_get(key: str) -> str | None:
    try:
        async with SessionLocal() as s:
            row = await s.get(LLMCache, key)
            if row is None:
                return None
            row.hits += 1
            await s.commit()
            return row.value
    except Exception:
        log.exception("读取 LLM 缓存失败（已忽略）")
        return None


async def cache_put(
    key: str, scene: str, model: str, value: str, meta: dict | None = None
) -> None:
    try:
        async with SessionLocal() as s:
            if await s.get(LLMCache, key) is None:
                s.add(
                    LLMCache(
                        key=key,
                        scene=scene,
                        model=model,
                        value=value,
                        meta=meta or {},
                        created_at=utcnow(),
                    )
                )
                await s.commit()
    except Exception:
        log.exception("写入 LLM 缓存失败（已忽略）")
