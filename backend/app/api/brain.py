"""第二大脑 API（PLAN §3.6）。"""

from __future__ import annotations

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field

from app.api.cards import card_dict
from app.api.deps import CurrentUser, Scope, user_quota
from app.api.sse import sse_response
from app.services import brain as svc

router = APIRouter(prefix="/brain", tags=["brain"])


class HistoryItem(BaseModel):
    role: str = Field(pattern="^(user|assistant)$")
    content: str = Field(max_length=8000)


class AskIn(BaseModel):
    question: str = Field(min_length=1, max_length=2000)
    history: list[HistoryItem] = Field(default_factory=list, max_length=12)


@router.post("/ask")
async def ask(body: AskIn, request: Request, scope: Scope, user: CurrentUser):
    """多路召回 → RRF → 重排 → 带引用回答。全程 SSE。"""
    return await sse_response(
        svc.answer_stream(
            scope,
            body.question,
            history=[h.model_dump() for h in body.history],
            quota=user_quota(user),
        ),
        request,
    )


@router.get("/search")
async def search(scope: Scope, q: str = Query(min_length=1, max_length=200)) -> dict:
    """只做召回不生成，用于调试与"看看我学过什么"。"""
    cards = await svc.retrieve(scope, q, top_k=15)
    return {"cards": [card_dict(c, with_messages=False) for c in cards]}


@router.get("/recent")
async def recent(scope: Scope, days: int = Query(7, ge=1, le=90)) -> dict:
    cards = await svc.recent_context(scope, days=days)
    return {
        "cards": [card_dict(c, with_messages=False) for c in cards],
        "suggestions": [
            f"我关于「{c.selected_text}」都学过什么？" for c in cards[:3] if c.selected_text
        ],
    }


@router.get("/network")
async def network(scope: Scope, limit: int = Query(800, le=3000)) -> dict:
    """整张记忆网络：神经元 + 突触 + 大脑体检指标。"""
    return await svc.memory_network(scope, limit)


@router.post("/reindex")
async def reindex(scope: Scope, limit: int = Query(100, le=500)) -> dict:
    """补齐沉淀：缺失的向量 + 缺失的复习排程。

    向量是唯一有模型成本的一环，所以放在这个显式端点里；排程零成本，
    复习入口也会自动补（services/review.backfill_review_states）。
    """
    from app.services.review import backfill_review_states

    return {
        "embedded": await svc.reindex_missing(scope, limit),
        "scheduled": await backfill_review_states(scope),
    }
