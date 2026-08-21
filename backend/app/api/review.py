"""复习 API。

★ 主入口是**章节刷题**（/review/chapters → /review/quiz）：选一章，AI 出一套
  以选择题为主的题，即时判对错，刷完给总结。

★ FSRS 退到后台，但没有消失：
  · 它给章节列表算「待复习强度」（该刷哪一章）
  · 刷题结果回喂 apply_review，排程与记忆网络的节点亮度照常更新
  下面的 /due /question /answer /rate 是卡片级的老路径，保留给
  「番茄结束后的回顾」与上下文唤醒用，不再是复习的入口。
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.api.cards import card_dict
from app.api.deps import CurrentUser, Scope, user_quota
from app.core.types import utcnow
from app.models.card import STATE_VAULT, Card
from app.models.learning import Quiz, ReviewLog, ReviewState
from app.services import quiz as quiz_svc
from app.services import review as svc

router = APIRouter(prefix="/review", tags=["review"])


class AnswerIn(BaseModel):
    card_id: str
    question: str = Field(max_length=4000)
    answer: str = Field(default="", max_length=8000)


class QuizIn(BaseModel):
    chapter_id: str


class QuizAnswerIn(BaseModel):
    index: int = Field(ge=0, le=60)
    # 选择题给下标，简答题给文本 —— 二者只会有一个
    picked: int | None = Field(default=None, ge=0, le=9)
    reply: str = Field(default="", max_length=8000)


class ManualRatingIn(BaseModel):
    card_id: str
    rating: int = Field(ge=1, le=4)


class WakeupIn(BaseModel):
    concepts: list[str] = Field(default_factory=list, max_length=12)


# ─────────────────────────────────────────────────────────────
# 章节刷题（主入口）
# ─────────────────────────────────────────────────────────────
def _quiz_out(quiz: Quiz, *, with_answers: bool) -> dict:
    """给前端的题目。

    ★ with_answers=True 是刻意的：选择题的答案和解析随题一起下发，
      前端本地判对错 → **零延迟**。这是刷题爽感的前提。
      「怕用户看源码作弊」在这里不是威胁模型 —— 这是他自己的复习，
      作弊的唯一受害者是他自己的排程。真要防，代价是每题一次往返，
      把整个体验换掉了，不值得。
      简答题只下发题干，答案留在服务端（它要 AI 判分）。
    """
    items = []
    for i, it in enumerate(quiz.items or []):
        out = {
            "index": i,
            "kind": it.get("kind"),
            "q": it.get("q"),
            "options": it.get("options") or [],
            "concept": it.get("concept") or "",
            "why": it.get("why") or "",
            "picked": it.get("picked"),
            "correct": it.get("correct"),
        }
        if with_answers and it.get("kind") == "choice":
            out["answer"] = it.get("answer")
            out["explain"] = it.get("explain") or ""
        items.append(out)
    return {
        "id": quiz.id,
        "chapter_id": quiz.chapter_id,
        "chapter_title": quiz.chapter_title,
        "course_id": quiz.course_id,
        "course_title": quiz.course_title,
        "created_at": quiz.created_at.isoformat(),
        "finished_at": quiz.finished_at.isoformat() if quiz.finished_at else None,
        "items": items,
        "summary": quiz.summary or {},
    }


@router.get("/chapters")
async def chapters(scope: Scope) -> dict:
    """能刷的章 + 该刷的理由（到期卡多的排前面）。"""
    return {"chapters": await quiz_svc.chapter_targets(scope)}


@router.post("/quiz")
async def make_quiz(body: QuizIn, scope: Scope, user: CurrentUser) -> dict:
    # ⚠️ 必须走 require_chapter：chapters 表上没有 user_id，
    #    越权校验只能沿外键回溯到 course.user_id（scope 里已经封好了）
    chapter = await scope.require_chapter(body.chapter_id)
    try:
        quiz = await quiz_svc.generate(scope, chapter, quota=user_quota(user))
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc
    return _quiz_out(quiz, with_answers=True)


@router.post("/quiz/{quiz_id}/answer")
async def answer_quiz(
    quiz_id: str, body: QuizAnswerIn, scope: Scope, user: CurrentUser
) -> dict:
    quiz = await scope.session.get(Quiz, quiz_id)
    if quiz is None or quiz.user_id != scope.user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "这套题不存在")
    try:
        return await quiz_svc.record(
            scope, quiz, body.index,
            picked=body.picked, reply=body.reply, quota=user_quota(user),
        )
    except ValueError as exc:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc)) from exc


@router.post("/quiz/{quiz_id}/finish")
async def finish_quiz(quiz_id: str, scope: Scope) -> dict:
    quiz = await scope.session.get(Quiz, quiz_id)
    if quiz is None or quiz.user_id != scope.user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "这套题不存在")
    return await quiz_svc.finish(scope, quiz)


@router.get("/quiz/{quiz_id}")
async def get_quiz(quiz_id: str, scope: Scope) -> dict:
    """回到没刷完的那套题（一套题有模型成本，扔掉太浪费）。"""
    quiz = await scope.session.get(Quiz, quiz_id)
    if quiz is None or quiz.user_id != scope.user_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "这套题不存在")
    return _quiz_out(quiz, with_answers=True)


# ─────────────────────────────────────────────────────────────
# 卡片级路径（番茄回顾 / 上下文唤醒仍在用）
# ─────────────────────────────────────────────────────────────
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
