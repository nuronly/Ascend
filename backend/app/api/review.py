"""FSRS 主动复习 API（PLAN §3.6）。"""

from __future__ import annotations

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.api.cards import card_dict
from app.api.deps import CurrentUser, Scope, user_quota
from app.core.types import utcnow
from app.models.card import STATE_VAULT, Card
from app.models.learning import ReviewLog, ReviewState
from app.services import review as svc

router = APIRouter(prefix="/review", tags=["review"])


class AnswerIn(BaseModel):
    card_id: str
    question: str = Field(max_length=4000)
    answer: str = Field(default="", max_length=8000)


class ManualRatingIn(BaseModel):
    card_id: str
    rating: int = Field(ge=1, le=4)


class WakeupIn(BaseModel):
    concepts: list[str] = Field(default_factory=list, max_length=12)


@router.get("/due")
async def due(scope: Scope, limit: int = Query(20, le=50)) -> dict:
    rows = await svc.due_cards(scope, limit)
    return {
        "count": await svc.due_count(scope),
        "cards": [
            {
                **card_dict(c, with_messages=False),
                "due_date": r.due_date.isoformat(),
                "reps": r.reps,
                "lapses": r.lapses,
            }
            for c, r in rows
        ],
    }


@router.post("/question")
async def question(
    card_id: str, scope: Scope, user: CurrentUser
) -> dict:
    """出题。不是弹原文，而是换角度检验是否真的理解了。"""
    card = await scope.require_card(card_id)
    return {"card_id": card.id, "question": await svc.make_question(scope, card, quota=user_quota(user))}


@router.post("/answer")
async def answer(body: AnswerIn, scope: Scope, user: CurrentUser) -> dict:
    """作答 → AI 判分 → 反馈给 FSRS 重新排程。"""
    card = await scope.require_card(body.card_id)
    quota = user_quota(user)
    graded = await svc.grade(scope, card, body.question, body.answer, quota=quota)
    state = await svc.apply_review(
        scope,
        card,
        rating=graded["rating"],
        question=body.question,
        answer=body.answer,
        score=graded["score"],
        feedback=graded["feedback"],
    )
    return {
        **graded,
        "next_due": state.due_date.isoformat(),
        "reps": state.reps,
        "interval_days": round((state.due_date - utcnow()).total_seconds() / 86400, 2),
    }


@router.post("/rate")
async def rate(body: ManualRatingIn, scope: Scope) -> dict:
    """跳过 AI 判分，用户自评。省 token，也给不想打字的时候一条快路。"""
    card = await scope.require_card(body.card_id)
    state = await svc.apply_review(scope, card, rating=body.rating)
    return {
        "next_due": state.due_date.isoformat(),
        "reps": state.reps,
        "interval_days": round((state.due_date - utcnow()).total_seconds() / 86400, 2),
    }


@router.post("/wakeup")
async def wakeup(body: WakeupIn, scope: Scope) -> dict:
    """上下文唤醒：学到相关概念时浮出旧卡（防坟场三件套之二）。"""
    cards = await svc.wakeup_cards(scope, body.concepts)
    return {"cards": [card_dict(c, with_messages=False) for c in cards]}


@router.get("/stats")
async def stats(scope: Scope) -> dict:
    total = int(
        await scope.session.scalar(
            select(func.count(ReviewState.card_id)).where(ReviewState.user_id == scope.user_id)
        )
        or 0
    )
    logs = int(
        await scope.session.scalar(
            select(func.count(ReviewLog.id)).where(ReviewLog.user_id == scope.user_id)
        )
        or 0
    )
    avg_score = await scope.session.scalar(
        select(func.avg(ReviewLog.ai_score)).where(
            ReviewLog.user_id == scope.user_id, ReviewLog.ai_score.is_not(None)
        )
    )
    vaulted = int(
        await scope.session.scalar(
            select(func.count(Card.id)).where(
                Card.user_id == scope.user_id, Card.state == STATE_VAULT
            )
        )
        or 0
    )
    return {
        "scheduled": total,
        "vaulted": vaulted,
        "due": await svc.due_count(scope),
        "reviews": logs,
        "avg_score": round(float(avg_score), 3) if avg_score is not None else None,
    }
