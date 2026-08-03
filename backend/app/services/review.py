"""FSRS 主动复习（PLAN §3.6）。

灵感仓库防坟场三件套之一。关键设计：
**复习不是弹原文，而是用卡片生成一道问题让用户回答，AI 判分 → 反馈给 FSRS。**
这一步让第二大脑从"被动问答"变成"主动教练"，投入产出比极高。
"""

from __future__ import annotations

import logging
from datetime import datetime

from fsrs import Card as FCard
from fsrs import Rating, Scheduler, State
from sqlalchemy import func, select

from app.core.config import TIER_SMALL
from app.core.scope import UserScope
from app.core.types import new_id, utcnow
from app.llm import Message, chat, chat_json
from app.models.card import STATE_VAULT, Card
from app.models.learning import ReviewLog, ReviewState
from app.services import prompts

log = logging.getLogger(__name__)

_scheduler = Scheduler()


def _to_fsrs(row: ReviewState) -> FCard:
    return FCard(
        state=State(row.state or 1),
        step=row.step,
        stability=row.stability,
        difficulty=row.difficulty,
        due=row.due_date,
        last_review=row.last_review,
    )


def _from_fsrs(row: ReviewState, fc: FCard) -> None:
    row.state = int(fc.state.value)
    row.step = fc.step
    row.stability = fc.stability
    row.difficulty = fc.difficulty
    row.due_date = fc.due
    row.last_review = fc.last_review


async def ensure_review_state(scope: UserScope, card: Card) -> ReviewState:
    """卡片进 vault 时建立排程状态。"""
    row = await scope.session.get(ReviewState, card.id)
    if row is not None:
        return row
    fc = FCard()
    row = ReviewState(
        card_id=card.id,
        user_id=scope.user_id,
        state=int(fc.state.value),
        step=fc.step,
        stability=fc.stability,
        difficulty=fc.difficulty,
        due_date=fc.due,
    )
    scope.add(row)
    await scope.commit()
    return row


async def due_cards(scope: UserScope, limit: int = 20) -> list[tuple[Card, ReviewState]]:
    """到期待复习的卡。FSRS 排程，到期主动推送（防坟场三件套之一）。"""
    rows = await scope.session.execute(
        select(Card, ReviewState)
        .join(ReviewState, ReviewState.card_id == Card.id)
        .where(
            Card.user_id == scope.user_id,
            ReviewState.user_id == scope.user_id,  # 双重校验，防越权
            Card.state == STATE_VAULT,
            ReviewState.due_date <= utcnow(),
        )
        .order_by(ReviewState.due_date)
        .limit(limit)
    )
    return [(c, r) for c, r in rows]


async def due_count(scope: UserScope) -> int:
    return int(
        await scope.session.scalar(
            select(func.count(ReviewState.card_id))
            .join(Card, Card.id == ReviewState.card_id)
            .where(
                ReviewState.user_id == scope.user_id,
                Card.user_id == scope.user_id,
                Card.state == STATE_VAULT,
                ReviewState.due_date <= utcnow(),
            )
        )
        or 0
    )


async def make_question(scope: UserScope, card: Card, *, quota: int | None = None) -> str:
    """出一道检验理解的题 —— 不是原问题的复述。"""
    reference = "\n".join(
        filter(None, [f"疑问：{card.question}", f"解答：{card.ai_answer[:1500]}",
                      f"他的理解：{card.user_note[:800]}" if card.user_note else ""])
    )
    try:
        result = await chat(
            [
                Message(role="system", content=prompts.REVIEW_Q_SYSTEM),
                Message(role="user", content=f"卡片主题：{card.selected_text}\n\n{reference}"),
            ],
            scene="review_question",
            tier=TIER_SMALL,
            user_id=scope.user_id,
            temperature=0.8,
            max_tokens=300,
            quota=quota,
        )
        if q := result.text.strip():
            return q
    except Exception:
        log.warning("生成复习题失败，回退到原问题", exc_info=True)
    return card.question or f"用你自己的话解释一下「{card.selected_text}」。"


async def grade(
    scope: UserScope, card: Card, question: str, answer: str, *, quota: int | None = None
) -> dict:
    """AI 判分 → 反馈给 FSRS。"""
    reference = "\n".join(
        filter(None, [card.question, card.ai_answer[:1500], card.user_note[:800]])
    )
    try:
        data = await chat_json(
            [
                Message(role="system", content=prompts.REVIEW_GRADE_SYSTEM),
                Message(
                    role="user", content=prompts.review_grade_user(question, reference, answer)
                ),
            ],
            scene="review_grade",
            tier=TIER_SMALL,
            user_id=scope.user_id,
            temperature=0.2,
            max_tokens=500,
            quota=quota,
        )
    except Exception:
        log.warning("AI 判分失败，按 Good 记账", exc_info=True)
        data = {"score": 0.6, "rating": 3, "feedback": "本次未能自动判分，已按「答得不错」计入。"}

    try:
        rating_val = int(data.get("rating") or 3)
    except (TypeError, ValueError):
        rating_val = 3
    rating_val = max(1, min(rating_val, 4))

    return {
        "score": float(data.get("score") or 0.0),
        "rating": rating_val,
        "feedback": str(data.get("feedback") or ""),
    }


async def apply_review(
    scope: UserScope,
    card: Card,
    *,
    rating: int,
    question: str = "",
    answer: str = "",
    score: float | None = None,
    feedback: str = "",
    now: datetime | None = None,
) -> ReviewState:
    row = await ensure_review_state(scope, card)
    prev_review = row.last_review
    fc = _to_fsrs(row)
    fc, _ = _scheduler.review_card(fc, Rating(rating), now or utcnow())

    elapsed = (
        ((now or utcnow()) - prev_review).total_seconds() / 86400.0 if prev_review else 0.0
    )
    _from_fsrs(row, fc)
    row.reps += 1
    if rating == 1:
        row.lapses += 1

    card.touch_count += 1
    card.last_touched_at = utcnow()

    scope.add(
        ReviewLog(
            id=new_id(),
            card_id=card.id,
            user_id=scope.user_id,
            rating=rating,
            reviewed_at=now or utcnow(),
            elapsed_days=round(elapsed, 4),
            question=question[:4000],
            user_answer=answer[:4000],
            ai_score=score,
            ai_feedback=feedback[:4000],
        )
    )
    await scope.commit()
    return row


async def wakeup_cards(scope: UserScope, concepts: list[str], limit: int = 3) -> list[Card]:
    """上下文唤醒：学到相关概念时浮出"你 3 天前问过 X，还记得吗"。

    防坟场三件套之二（PLAN §3.2.1）。
    """
    if not concepts:
        return []
    from app.search.fts import search_cards_fts

    hits = await search_cards_fts(scope.session, scope.user_id, " ".join(concepts), limit=limit * 3)
    out: list[Card] = []
    for cid, _ in hits:
        c = await scope.get(Card, cid)
        if c and c.state == STATE_VAULT:
            out.append(c)
        if len(out) >= limit:
            break
    return out
