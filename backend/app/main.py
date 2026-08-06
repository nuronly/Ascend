"""阶梯计划 · FastAPI 应用入口。"""

from __future__ import annotations

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
    graph,
    guide,
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
    graph.router,
    brain.router,
    review.router,
    badges.router,
    guide.router,
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
