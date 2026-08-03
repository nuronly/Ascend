"""模型公共件。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy.orm import Mapped, mapped_column

from app.core.types import IdType, TZDateTime, new_id, utcnow


def pk() -> Mapped[str]:
    return mapped_column(IdType, primary_key=True, default=new_id)


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        TZDateTime, default=utcnow, nullable=False, index=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        TZDateTime, default=utcnow, onupdate=utcnow, nullable=False
    )
