"""用户与刷新令牌（PLAN §4.2 / §5）。"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, ForeignKey, Index, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base
from app.core.types import IdType, JSONType, TZDateTime, new_id, utcnow
from app.models._common import pk


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = pk()
    email: Mapped[str] = mapped_column(String(320), unique=True, nullable=False, index=True)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    # argon2id 哈希；OAuth 用户为 NULL
    password_hash: Mapped[str | None] = mapped_column(String(255))
    oauth_provider: Mapped[str | None] = mapped_column(String(40))
    oauth_sub: Mapped[str | None] = mapped_column(String(255))
    email_verified: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 游客账号：多人共享同一个演示身份，数据互通（比赛/体验场景）。
    # 只做标记，权限与正式账号一致 —— 限制全部落在额度与入口限流上
    is_guest: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 含 daily_token_quota / theme 等
    settings: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    # ★ 已知边界：这个用户已经掌握的概念名（归一化后的字符串数组）。
    #   这是整个产品的复利所在 —— 建第二门课时它会被预勾成「熟悉」，
    #   学得越多，AI 越清楚该从哪句话开始讲，而 level 永远从零猜。
    #   信号来源：建课校准时的自评、学完一节后该节的 key_concepts；
    #   反向信号（划词追问命中某个已知概念）会把它移出去 —— 真实行为
    #   比自评可信得多。
    known_concepts: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow, nullable=False)

    __table_args__ = (Index("ix_users_oauth", "oauth_provider", "oauth_sub"),)


class RefreshToken(Base):
    """可撤销的 refresh token。只存哈希，明文只在 httpOnly cookie 里。"""

    __tablename__ = "refresh_tokens"

    id: Mapped[str] = mapped_column(IdType, primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, nullable=False, index=True)
    expires_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    user_agent: Mapped[str | None] = mapped_column(String(400))
    ip: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(TZDateTime, default=utcnow, nullable=False)

    @property
    def is_active(self) -> bool:
        return self.revoked_at is None and self.expires_at > utcnow()
