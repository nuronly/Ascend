"""SSE（Server-Sent Events）工具。

流式输出是硬需求：等 30 秒白屏必流失（PLAN §3.1）。
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator

import orjson
from fastapi import Request
from fastapi.responses import StreamingResponse

log = logging.getLogger(__name__)

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    # nginx 默认会缓冲代理响应，不关掉的话前端要等全部生成完才收到第一个字
    "X-Accel-Buffering": "no",
}


def pack(event: str, data: object) -> str:
    """data 一律 JSON 序列化 —— 裸文本里的换行会破坏 SSE 帧结构。"""
    return f"event: {event}\ndata: {orjson.dumps(data).decode()}\n\n"


async def sse_response(
    source: AsyncIterator[dict],
    request: Request | None = None,
    *,
    heartbeat: float = 15.0,
) -> StreamingResponse:
    async def gen() -> AsyncIterator[str]:
        queue: asyncio.Queue[dict | None] = asyncio.Queue(maxsize=256)

        async def pump() -> None:
            try:
                async for item in source:
                    await queue.put(item)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.exception("SSE 数据源异常")
                await queue.put({"event": "error", "data": {"message": str(exc)[:500]}})
            finally:
                await queue.put(None)

        task = asyncio.create_task(pump())
        try:
            while True:
                # 客户端关页面时立刻停掉生成，别把 token 烧在没人看的响应上
                if request is not None and await request.is_disconnected():
                    break
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=heartbeat)
                except TimeoutError:
                    yield ": ping\n\n"  # 注释帧保活，不触发前端 onmessage
                    continue
                if item is None:
                    break
                yield pack(item.get("event", "message"), item.get("data"))
        finally:
            task.cancel()
            try:
                await task
            except (asyncio.CancelledError, Exception):
                pass

    return StreamingResponse(gen(), media_type="text/event-stream", headers=SSE_HEADERS)
