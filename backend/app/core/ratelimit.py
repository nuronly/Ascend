"""速率限制（上线防护）。

内存滑动窗口，够单机部署用。多实例部署时需要换 Redis ——
但那个规模下你也该上 PostgreSQL 了，一起换。

两条线分开限：
  · 认证端点 —— 防撞库
  · AI 端点   —— 防刷额度（真正烧钱的地方）
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

from fastapi import Request
from fastapi.responses import JSONResponse

from app.core.config import settings

_WINDOW = 60.0
_buckets: dict[str, deque[float]] = defaultdict(deque)
_last_sweep = 0.0

# 真正烧钱的路径：命中这些走 AI 配额
_AI_PATHS = ("/ask", "/stream", "/translate", "/courses", "/review/", "/brain/", "/badges")
_AUTH_PATHS = ("/api/auth/login", "/api/auth/register", "/api/auth/refresh", "/api/auth/guest")


def _client_ip(request: Request) -> str:
    """取真实来源 IP。

    ⚠️ 只信任反代注入的第一跳。如果直接暴露在公网（没有反代），
    X-Forwarded-For 是可以伪造的，那种部署方式本来也不该用。
    """
    xff = request.headers.get("x-forwarded-for")
    if xff:
        return xff.split(",")[0].strip()
    real = request.headers.get("x-real-ip")
    if real:
        return real.strip()
    return request.client.host if request.client else "unknown"


def _sweep(now: float) -> None:
    """定期清理空桶，避免内存随 IP 数无限增长。"""
    global _last_sweep
    if now - _last_sweep < 120:
        return
    _last_sweep = now
    for key in list(_buckets):
        q = _buckets[key]
        while q and now - q[0] > _WINDOW:
            q.popleft()
        if not q:
            del _buckets[key]


def _hit(key: str, limit: int, now: float) -> bool:
    q = _buckets[key]
    while q and now - q[0] > _WINDOW:
        q.popleft()
    if len(q) >= limit:
        return False
    q.append(now)
    return True


async def rate_limit_middleware(request: Request, call_next):
    if not settings.rate_limit_enabled:
        return await call_next(request)

    path = request.url.path
    if not path.startswith("/api/") or request.method == "OPTIONS":
        return await call_next(request)

    now = time.monotonic()
    _sweep(now)
    ip = _client_ip(request)

    if any(path.startswith(p) for p in _AUTH_PATHS):
        limit, bucket, hint = settings.rate_auth_per_minute, f"auth:{ip}", "登录尝试"
    elif any(seg in path for seg in _AI_PATHS) and request.method in ("POST", "GET"):
        limit, bucket, hint = settings.rate_ai_per_minute, f"ai:{ip}", "AI 请求"
    else:
        limit, bucket, hint = 240, f"api:{ip}", "请求"

    if not _hit(bucket, limit, now):
        return JSONResponse(
            {"detail": f"{hint}过于频繁，请稍后再试", "code": "rate_limited"},
            status_code=429,
            headers={"Retry-After": "60"},
        )

    return await call_next(request)
