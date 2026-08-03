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


# ── CSRF：SameSite 之外再加一道 Origin 校验 ──
_SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


@app.middleware("http")
async def csrf_origin_guard(request: Request, call_next):
    """cookie 鉴权天然面临 CSRF。SameSite=Lax 挡住大部分，
    但表单型 POST 仍可能带上 cookie，所以对写操作再校验一次 Origin。"""
    if request.method not in _SAFE_METHODS and request.url.path.startswith("/api/"):
        origin = request.headers.get("origin")
        if origin and origin not in settings.cors_origin_list:
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


@app.get("/api/health")
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
    export.router,
):
    app.include_router(r, prefix="/api")
