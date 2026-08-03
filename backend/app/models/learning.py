"""学习行为层：番茄钟 / FSRS 复习 / 勋章（PLAN §3.3 / §3.6 / §3.7 / §5）。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.types import IdType, JSONType, TZDateTime
from app.models._common import pk

# pomodoros.status
POMO_RUNNING = "running"
POMO_COMPLETED = "completed"
POMO_ABANDONED = "abandoned"


class Pomodoro(Base):
    """学习行为计量层。

    ❗ 时间全部靠 started_at / expected_end 落库计算，
    绝不靠前端累加 tick —— 浏览器后台标签页会把 setInterval 节流到
    1 次/分钟，累加式计时必然走不准（PLAN §3.3 / §7 风险 #6）。
    """

    __tablename__ = "pomodoros"

    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    section_id: Mapped[str | None] = mapped_column(
        IdType, ForeignKey("sections.id", ondelete="SET NULL"), index=True
    )
    started_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    expected_end: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    status: Mapped[str] = mapped_column(String(20), default=POMO_RUNNING, nullable=False)
    planned_minutes: Mapped[int] = mapped_column(Integer, default=25, nullable=False)
    # 番茄结束后的卡片回顾是否已完成
    reviewed_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)

    __table_args__ = (
        Index("ix_pomodoros_user_started", "user_id", "started_at"),
        Index("ix_pomodoros_user_status", "user_id", "status"),
    )


class ReviewState(Base):
    """FSRS 排程状态。每张 vault 卡一条（PLAN §3.6）。"""

    __tablename__ = "review_states"

    card_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("cards.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[str] = mapped_column(IdType, nullable=False, index=True)
    stability: Mapped[float | None] = mapped_column(Float)
    difficulty: Mapped[float | None] = mapped_column(Float)
    due_date: Mapped[datetime] = mapped_column(TZDateTime, nullable=False, index=True)
    last_review: Mapped[datetime | None] = mapped_column(TZDateTime)
    reps: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    lapses: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # fsrs State 枚举：1 learning / 2 review / 3 relearning
    state: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    # fsrs 的学习步进游标，必须持久化，否则每次复习都从第一步重来
    step: Mapped[int | None] = mapped_column(Integer, default=0)

    __table_args__ = (Index("ix_review_states_user_due", "user_id", "due_date"),)


class ReviewLog(Base):
    """复习不是弹原文，而是用卡片生成一道问题让用户答，AI 判分（PLAN §3.6）。"""

    __tablename__ = "review_logs"

    id: Mapped[str] = pk()
    card_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("cards.id", ondelete="CASCADE"), nullable=False, index=True
    )
    user_id: Mapped[str] = mapped_column(IdType, nullable=False, index=True)
    rating: Mapped[int] = mapped_column(Integer, nullable=False)  # 1 again 2 hard 3 good 4 easy
    reviewed_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False, index=True)
    elapsed_days: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    question: Mapped[str] = mapped_column(Text, default="", nullable=False)
    user_answer: Mapped[str] = mapped_column(Text, default="", nullable=False)
    ai_score: Mapped[float | None] = mapped_column(Float)
    ai_feedback: Mapped[str] = mapped_column(Text, default="", nullable=False)


class Badge(Base):
    """勋章（PLAN §3.7）。异步生图：先发占位，图好了替换。"""

    __tablename__ = "badges"

    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # completion / depth / persistence / exploration
    kind: Mapped[str] = mapped_column(String(30), nullable=False)
    code: Mapped[str] = mapped_column(String(80), nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    criteria: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    image_url: Mapped[str | None] = mapped_column(Text)
    # pending / generating / ready / failed —— 绝不同步阻塞
    image_status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)
    earned_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)

    __table_args__ = (Index("uq_badges_user_code", "user_id", "code", unique=True),)
