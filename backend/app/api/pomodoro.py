"""番茄钟 API（PLAN §3.3）。

不做独立小工具，只做课程结构的计量单位。

❗ 时间一律以服务端的 started_at / expected_end 为准，前端只做投影。
   浏览器后台标签页会把 setInterval 节流到 1 次/分钟，
   任何"累加 tick"式的计时都必然走不准（PLAN §7 风险 #6）。
"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.api.cards import card_dict
from app.api.deps import CurrentUser, Scope
from app.core.types import new_id, utcnow
from app.models.card import STATE_ARCHIVED, STATE_DRAFT, Card
from app.models.learning import (
    POMO_ABANDONED,
    POMO_COMPLETED,
    POMO_RUNNING,
    Pomodoro,
)

router = APIRouter(prefix="/pomodoros", tags=["pomodoro"])


class StartIn(BaseModel):
    section_id: str | None = None
    minutes: int | None = Field(default=None, ge=1, le=180)


def pomo_dict(p: Pomodoro) -> dict:
    now = utcnow()
    remaining = (p.expected_end - now).total_seconds()
    return {
        "id": p.id,
        "section_id": p.section_id,
        "status": p.status,
        "planned_minutes": p.planned_minutes,
        # 三个绝对时间戳交给前端，它自己按 Date.now() 算差值即可
        "started_at": p.started_at.isoformat(),
        "expected_end": p.expected_end.isoformat(),
        "ended_at": p.ended_at.isoformat() if p.ended_at else None,
        "server_now": now.isoformat(),
        "remaining_seconds": max(0, int(remaining)),
        "elapsed_seconds": int((now - p.started_at).total_seconds()),
        "reviewed": p.reviewed_at is not None,
    }


@router.get("/active")
async def active(scope: Scope) -> dict | None:
    """页面刷新 / 换设备后恢复计时 —— 靠库里的时间戳，不靠内存。"""
    p = await scope.one_or_none(
        scope.select(Pomodoro)
        .where(Pomodoro.status == POMO_RUNNING)
        .order_by(Pomodoro.started_at.desc())
        .limit(1)
    )
    if p is None:
        return None

    # 页面关闭/崩溃后重开：早已超时的番茄自动收尾，不让它永远挂着
    if (utcnow() - p.expected_end) > timedelta(minutes=30):
        p.status = POMO_COMPLETED
        p.ended_at = p.expected_end
        await scope.commit()
        return None
    return pomo_dict(p)


@router.post("", status_code=status.HTTP_201_CREATED)
async def start(body: StartIn, scope: Scope, user: CurrentUser) -> dict:
    """开始一颗番茄。时长：显式传入 > 用户设置的默认时长 > 25 分钟。

    不再对齐小节的 est_minutes —— AI 估的是纯阅读耗时，估不到个体差异
    和番茄中的划词追问，作为番茄时长不准；est_minutes 仅用于界面展示。
    """
    running = await scope.all(
        scope.select(Pomodoro).where(Pomodoro.status == POMO_RUNNING)
    )
    for p in running:  # 同时只允许一颗
        p.status = POMO_ABANDONED
        p.ended_at = utcnow()

    minutes = body.minutes
    if minutes is None:
        minutes = int((user.settings or {}).get("default_pomodoro_minutes") or 25)
    minutes = max(1, min(minutes, 180))

    now = utcnow()
    pomo = Pomodoro(
        id=new_id(),
        user_id=scope.user_id,
        section_id=body.section_id,
        started_at=now,
        expected_end=now + timedelta(minutes=minutes),
        status=POMO_RUNNING,
        planned_minutes=minutes,
    )
    scope.add(pomo)
    await scope.commit()
    return pomo_dict(pomo)


@router.post("/{pomodoro_id}/finish")
async def finish(
    pomodoro_id: str, scope: Scope, abandoned: bool = Query(False)
) -> dict:
    """结束番茄。

    ★ 不弹"休息一下"，而是弹**本颗番茄的卡片回顾** ——
      这是最自然的卡片整理时机（PLAN §3.3）。
    """
    p = await scope.require(Pomodoro, pomodoro_id, "番茄")
    if p.status == POMO_RUNNING:
        p.status = POMO_ABANDONED if abandoned else POMO_COMPLETED
        p.ended_at = utcnow()
        await scope.commit()

    cards = await scope.all(
        scope.select(Card)
        .where(
            Card.pomodoro_id == p.id,
            Card.state == STATE_DRAFT,
        )
        .order_by(Card.created_at)
    )
    return {
        "pomodoro": pomo_dict(p),
        "cards": [card_dict(c, with_messages=False) for c in cards],
    }


@router.post("/{pomodoro_id}/reviewed", status_code=status.HTTP_204_NO_CONTENT)
async def mark_reviewed(pomodoro_id: str, scope: Scope) -> None:
    p = await scope.require(Pomodoro, pomodoro_id, "番茄")
    p.reviewed_at = utcnow()
    await scope.commit()


@router.post("/{pomodoro_id}/extend")
async def extend(pomodoro_id: str, scope: Scope, minutes: int = Query(5, ge=1, le=60)) -> dict:
    p = await scope.require(Pomodoro, pomodoro_id, "番茄")
    if p.status != POMO_RUNNING:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "这颗番茄已经结束了")
    p.expected_end = p.expected_end + timedelta(minutes=minutes)
    p.planned_minutes += minutes
    await scope.commit()
    return pomo_dict(p)


@router.get("/stats")
async def stats(scope: Scope, days: int = Query(30, ge=1, le=365)) -> dict:
    """数据出口：勋章条件、第二大脑时间线维度、学习热力图（PLAN §3.3）。"""
    since = utcnow() - timedelta(days=days)
    rows = await scope.all(
        scope.select(Pomodoro)
        .where(Pomodoro.started_at >= since, Pomodoro.status == POMO_COMPLETED)
        .order_by(Pomodoro.started_at)
    )

    heat: dict[str, int] = {}
    total_minutes = 0
    for p in rows:
        day = p.started_at.date().isoformat()
        heat[day] = heat.get(day, 0) + 1
        end = p.ended_at or p.expected_end
        total_minutes += max(0, int((end - p.started_at).total_seconds() // 60))

    # 连续天数（含今天或从昨天起算，避免今天还没学就断签）
    days_set = set(heat)
    streak = 0
    cursor = utcnow().date()
    if cursor.isoformat() not in days_set:
        cursor -= timedelta(days=1)
    while cursor.isoformat() in days_set:
        streak += 1
        cursor -= timedelta(days=1)

    cards_in_pomo = int(
        await scope.session.scalar(
            select(func.count(Card.id)).where(
                Card.user_id == scope.user_id,
                Card.pomodoro_id.is_not(None),
                Card.state != STATE_ARCHIVED,
                Card.created_at >= since,
            )
        )
        or 0
    )
    return {
        "total": len(rows),
        "total_minutes": total_minutes,
        "heatmap": heat,
        "streak": streak,
        "cards_in_pomodoro": cards_in_pomo,
        "avg_cards_per_pomodoro": round(cards_in_pomo / len(rows), 2) if rows else 0.0,
    }


@router.get("/history")
async def history(scope: Scope, limit: int = Query(50, le=200)) -> list[dict]:
    rows = await scope.all(
        scope.select(Pomodoro).order_by(Pomodoro.started_at.desc()).limit(limit)
    )
    counts = dict(
        (
            await scope.session.execute(
                select(Card.pomodoro_id, func.count(Card.id))
                .where(
                    Card.user_id == scope.user_id,
                    Card.pomodoro_id.in_([p.id for p in rows] or [""]),
                )
                .group_by(Card.pomodoro_id)
            )
        ).all()
    )
    out = []
    for p in rows:
        d = pomo_dict(p)
        d["card_count"] = int(counts.get(p.id, 0))
        out.append(d)
    return out


__all__ = ["router"]
