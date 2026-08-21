"""阶梯计划 · FastAPI 应用入口。"""

from __future__ import annotations

import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.db import dispose_db, init_db
from app.llm.base import BudgetExceeded, LLMError

logging.basicConfig(
    level=logging.INFO if not settings.is_dev else logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s · %(message)s",
    datefmt="%H:%M:%S",
)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
log = logging.getLogger("ladder")


@asynccontextmanager
async def lifespan(_: FastAPI):
    await init_db()
    from app.llm.registry import available_providers

    providers = available_providers()
    log.info("LLM Provider: %s", ", ".join(providers) if providers else "（未配置）")
    log.info(
        "分级路由 · 旗舰=%s 中档=%s 小模型=%s 向量=%s",
        settings.model_flagship,
        settings.model_standard,
        settings.model_small,
        settings.model_embedding,
    )

    # 上线自检：把容易漏的坑摆到眼前，而不是等出事
    if warnings := settings.production_warnings():
        log.warning("─" * 62)
        log.warning("生产环境自检发现 %s 个问题：", len(warnings))
        for w in warnings:
            log.warning("  ⚠️  %s", w)
        log.warning("─" * 62)
    elif settings.is_prod:
        log.info("生产环境自检通过 ✓")

    if settings.serve_frontend:
        log.info(
            "静态前端：%s", settings.dist_path or "未找到 dist，请先执行 npm run build"
        )
    yield
    from app.llm.registry import close_all
    from app.services.runstream import shutdown_runs

    # 后台还在跑的生成注定丢（正文没落库），至少干净地收掉，
    # 别留一串"task was destroyed but it is pending"的噪音
    await shutdown_runs()
    await close_all()
    await dispose_db()


app = FastAPI(
    title="阶梯计划 API",
    description="以疑问为原子单位的学习工作台",
    version="0.1.0",
    docs_url="/api/docs" if settings.is_dev else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if settings.is_dev else None,
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,  # httpOnly cookie 必需
    allow_methods=["*"],
    allow_headers=["*"],
)

# 速率限制（生产开启）：认证端点防撞库，AI 端点防刷额度
from app.core.ratelimit import rate_limit_middleware  # noqa: E402

app.middleware("http")(rate_limit_middleware)


# ── CSRF：SameSite 之外再加一道 Origin 校验 ──
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


def _is_same_origin(origin: str, request: Request) -> bool:
    """判断 Origin 是否与当前站点同源。

    浏览器对 POST 总会带上 Origin —— 同站的也带。
    之前的实现只认 CORS_ORIGINS 白名单，于是 IP 部署
    （白名单为空）时连自己站点的登录请求都被 403 掉。
    正确的做法是：同源直接放行，跨源才查白名单。
    """
    from urllib.parse import urlparse

    host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
    if not host:
        return False
    return urlparse(origin).netloc == host


@app.middleware("http")
async def csrf_origin_guard(request: Request, call_next):
    """cookie 鉴权天然面临 CSRF。SameSite=Lax 挡住大部分，
    但表单型 POST 仍可能带上 cookie，所以对写操作再校验一次 Origin。

    放行顺序：同源 > CORS_ORIGINS 白名单 > 拒绝。
    """
    if request.method not in _SAFE_METHODS and request.url.path.startswith("/api/"):
        origin = request.headers.get("origin")
        if (
            origin
            and not _is_same_origin(origin, request)
            and origin not in settings.cors_origin_list
        ):
            # 排查部署差异时这条日志是唯一的真相来源
            log.warning(
                "CSRF 拦截: origin=%r host=%r x-forwarded-host=%r forwarded=%r whitelist=%r",
                origin,
                request.headers.get("host"),
                request.headers.get("x-forwarded-host"),
                request.headers.get("x-forwarded-for"),
                settings.cors_origin_list,
            )
            return JSONResponse(
                {"detail": "请求来源不被信任"}, status_code=status.HTTP_403_FORBIDDEN
            )
    return await call_next(request)


# ── 请求体硬上限 ──
_WRITE_METHODS = {"POST", "PUT", "PATCH"}


class _BodyTooLarge(Exception):
    """请求体超过硬上限。只在中间件内部流转，不会漏到路由层。"""


class BodySizeLimitMiddleware:
    """按字节数掐掉过大的请求体。

    为什么必须有：上传接口拿到的 UploadFile，在 multipart 解析阶段就已经把
    数据接收并落到临时文件了 —— 等执行到路由函数里的大小判断，磁盘已经被写满
    （磁盘满 → SQLite 写不进 → 全站挂）。反代部署时这道闸由 Nginx 的
    client_max_body_size 提供，单体部署（uvicorn 直接对外）没有反代，
    就只能在这里挡。

    为什么是纯 ASGI 而不是 @app.middleware("http")：BaseHTTPMiddleware 会自己
    包一层 receive 再交给下游，在它的 dispatch 里改 request._receive 是无效的
    —— 必须拿到原始 receive 才能边收边数。
    """

    def __init__(self, app, max_bytes: int) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http" or scope.get("method") not in _WRITE_METHODS:
            return await self.app(scope, receive, send)

        # 快路径：声明了 Content-Length 的（浏览器上传、curl 都会声明），
        # 一个字节都不用收就能拒绝
        declared = self._declared_length(scope)
        if declared is not None and declared > self.max_bytes:
            return await self._reject(send)

        received = 0
        started = False

        async def counting_receive() -> dict:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                # 不声明 Content-Length 的分块传输只能边收边数
                if received > self.max_bytes:
                    raise _BodyTooLarge
            return message

        async def tracking_send(message: dict) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, counting_receive, tracking_send)
        except _BodyTooLarge:
            log.warning("请求体超过 %s 字节上限，已拒绝：%s", self.max_bytes, scope.get("path"))
            # 响应已经开头了就改不了状态码，只能让它自然结束
            if not started:
                await self._reject(send)

    @staticmethod
    def _declared_length(scope: dict) -> int | None:
        for name, value in scope.get("headers", []):
            if name == b"content-length":
                try:
                    return int(value)
                except ValueError:
                    return None
        return None

    async def _reject(self, send) -> None:
        body = json.dumps(
            {
                "detail": f"请求体过大，上限 {self.max_bytes // (1024 * 1024)}MB",
                "code": "payload_too_large",
            },
            ensure_ascii=False,
        ).encode()
        await send(
            {
                "type": "http.response.start",
                # 写字面量：starlette 已把 HTTP_413_REQUEST_ENTITY_TOO_LARGE 标记为
                # 弃用，而新名字 HTTP_413_CONTENT_TOO_LARGE 在旧版本里还不存在
                "status": 413,
                "headers": [
                    (b"content-type", b"application/json; charset=utf-8"),
                    (b"content-length", str(len(body)).encode()),
                    # 请求体没读完就回响应，连接不能再复用
                    (b"connection", b"close"),
                ],
            }
        )
        await send({"type": "http.response.body", "body": body})


# 最后 add = 最外层 = 最先执行。越早拒绝越好，别让大 body 白走一圈中间件
app.add_middleware(BodySizeLimitMiddleware, max_bytes=settings.max_body_bytes)


# ── 异常映射：把内部错误翻译成用户能看懂的话 ──
@app.exception_handler(BudgetExceeded)
async def _budget_handler(_: Request, exc: BudgetExceeded):
    return JSONResponse({"detail": str(exc), "code": "budget_exceeded"}, status_code=429)


@app.exception_handler(LLMError)
async def _llm_handler(_: Request, exc: LLMError):
    log.error("LLM 调用失败：%s", exc)
    return JSONResponse(
        {
            "detail": "AI 服务暂时不可用，请稍后重试。（已尝试全部备用模型）",
            "code": "llm_unavailable",
        },
        status_code=503,
    )


# 带 HEAD：负载均衡器和监控探针常用 HEAD 做健康检查，收到 405/404 会误判为宕机
@app.api_route("/api/health", methods=["GET", "HEAD"])
async def health() -> dict:
    from app.llm.registry import available_providers

    return {
        "status": "ok",
        "env": settings.app_env,
        "db": settings.database_url.split("://")[0],
        "providers": available_providers(),
    }


# ── 路由注册 ──
from app.api import (  # noqa: E402
    auth,
    badges,
    brain,
    cards,
    courses,
    documents,
    export,
    feedback,
    guide,
    pet,
    pomodoro,
    review,
    vault,
)

for r in (
    auth.router,
    courses.router,
    cards.router,
    documents.router,
    pomodoro.router,
    vault.router,
    # 全局图谱（graph）已整块撤除：卡片不再是一张需要俯瞰的网，
    # 它绑定在小节与笔记上。卡片空间里的连线仍在（cards.py 的 /links）。
    brain.router,
    review.router,
    badges.router,
    guide.router,
    pet.router,
    feedback.router,
    export.router,
):
    app.include_router(r, prefix="/api")


# ── 静态前端（单体部署）──
# 路由注册必须在此之后：SPA 的 catch-all 会吞掉一切未匹配路径，
# 放前面的话所有 API 都会被它接管。
if settings.serve_frontend and (_dist := settings.dist_path):
    from fastapi.responses import FileResponse  # noqa: E402
    from fastapi.staticfiles import StaticFiles  # noqa: E402

    app.mount("/assets", StaticFiles(directory=_dist / "assets"), name="assets")

    # 带上 HEAD：健康检查、CDN 预检、curl -I 都惯用 HEAD，
    # 只注册 GET 会让它们收到 405，看起来像站点挂了
    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    async def spa(full_path: str):
        """SPA fallback：前端是 BrowserRouter，刷新任意深层路由都要回到 index.html。"""
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not Found"}, status_code=404)
        candidate = (_dist / full_path).resolve()
        # 目录穿越防护
        if (
            full_path
            and str(candidate).startswith(str(_dist.resolve()))
            and candidate.is_file()
        ):
            return FileResponse(candidate)
        return FileResponse(
            _dist / "index.html",
            headers={"Cache-Control": "no-cache, must-revalidate"},
        )
