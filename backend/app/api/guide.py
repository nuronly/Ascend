"""新手引导（比赛演示用，之后计划下线）。

设计要点：
- 不建表。进度存在 User.settings JSON 里：
    guide_started_at   引导开始时间（判定基准）
    guide_dismissed    用户关掉了引导（不再自动弹）
    guide_events       无写库动作的步骤（读节 / 看图谱 / 问大脑）在此打点
- 建卡类步骤走数据判定（created_at / vaulted_at > started_at），
  按「动作」而不是「状态」——否则有预置数据的账号（游客演示号）
  一打开引导就发现三步已完成，亲手划词的成就感就没了。
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter
from pydantic import BaseModel, Field
from sqlalchemy import func, select

from app.api.deps import CurrentUser, Db
from app.core.types import utcnow
from app.models.card import ORIGIN_PARENT_ANSWER, STATE_VAULT, Card
from app.models.course import Chapter, Course, Section

router = APIRouter(prefix="/guide", tags=["guide"])

# 步骤顺序即主路径顺序
STEPS = ("read_section", "create_card", "nest_card", "vault_card", "view_graph", "ask_brain")
# 前端打点的步骤（没有对应的库表动作可判定）
EVENT_STEPS = ("read_section", "view_graph", "ask_brain")


def _settings(user) -> dict:
    return dict(user.settings or {})


def _started_at(s: dict) -> datetime | None:
    raw = s.get("guide_started_at")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


class EventIn(BaseModel):
    step: str = Field(pattern="^(read_section|view_graph|ask_brain)$")


@router.get("/progress")
async def progress(user: CurrentUser, db: Db) -> dict:
    s = _settings(user)
    started = _started_at(s)
    events = s.get("guide_events") or {}

    done: dict[str, bool] = {}
    for key in EVENT_STEPS:
        done[key] = key in events

    if started:
        # 数据判定：只认引导开始之后发生的动作
        base = select(func.count(Card.id)).where(Card.user_id == user.id)
        done["create_card"] = bool(
            await db.scalar(base.where(Card.created_at >= started))
        )
        done["nest_card"] = bool(
            await db.scalar(
                base.where(Card.created_at >= started, Card.origin == ORIGIN_PARENT_ANSWER)
            )
        )
        done["vault_card"] = bool(
            await db.scalar(
                base.where(Card.state == STATE_VAULT, Card.vaulted_at >= started)
            )
        )
    else:
        done.update({"create_card": False, "nest_card": False, "vault_card": False})

    # 给前端一个开箱即用的跳转目标：当前用户第一个已生成正文的小节
    first = (
        await db.execute(
            select(Section.id, Course.id)
            .join(Chapter, Section.chapter_id == Chapter.id)
            .join(Course, Chapter.course_id == Course.id)
            .where(Course.user_id == user.id, Section.content_md.isnot(None))
            .order_by(Chapter.idx, Section.idx)
            .limit(1)
        )
    ).first()

    return {
        "started": started is not None,
        "dismissed": bool(s.get("guide_dismissed")),
        "steps": [{"key": k, "done": done.get(k, False)} for k in STEPS],
        "first_section": {"section_id": first[0], "course_id": first[1]} if first else None,
    }


@router.post("/start")
async def start(user: CurrentUser, db: Db) -> dict:
    """开始（或重新开始）引导：重置判定基准与打点。"""
    s = _settings(user)
    s["guide_started_at"] = utcnow().isoformat()
    s["guide_dismissed"] = False
    s["guide_events"] = {}
    user.settings = s
    await db.commit()
    return {"started": True}


@router.post("/event", status_code=204)
async def event(body: EventIn, user: CurrentUser, db: Db) -> None:
    s = _settings(user)
    if not _started_at(s):
        # 引导没开始时不记，免得 settings 里积攒无意义打点
        return
    events = dict(s.get("guide_events") or {})
    if body.step not in events:
        events[body.step] = utcnow().isoformat()
        s["guide_events"] = events
        user.settings = s
        await db.commit()


@router.post("/dismiss", status_code=204)
async def dismiss(user: CurrentUser, db: Db) -> None:
    s = _settings(user)
    s["guide_dismissed"] = True
    user.settings = s
    await db.commit()
