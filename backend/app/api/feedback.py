"""意见反馈。

流程刻意分成两步：
  1. 先落库 —— 反馈是用户花时间写的，不能因为邮件通道不通就丢了
  2. 再发邮件 —— 只是通知手段，失败了记下原因，用户侧照常显示「已收到」

所以就算 SMTP 完全没配置，这个功能也是可用的：
管理员从 feedback 表里捞就行。
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field, field_validator

from app.api.deps import CurrentUser, Db
from app.core.config import settings
from app.core.mail import send_mail
from app.core.types import new_id, utcnow
from app.models.system import Feedback

log = logging.getLogger("ladder.feedback")

router = APIRouter(prefix="/feedback", tags=["feedback"])


class FeedbackIn(BaseModel):
    content: str = Field(min_length=1, max_length=4000)
    contact: str = Field(default="", max_length=200)
    page: str = Field(default="", max_length=300)

    @field_validator("content", "contact", "page")
    @classmethod
    def _trim(cls, v: str) -> str:
        return v.strip()

    @field_validator("content")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        # min_length 只数字符数，"   " 能过 —— 会存下一条空反馈
        if not v:
            raise ValueError("反馈内容不能为空")
        return v


@router.post("", status_code=201)
async def submit(body: FeedbackIn, request: Request, user: CurrentUser, db: Db) -> dict:
    row = Feedback(
        id=new_id(),
        user_id=user.id,
        email=user.email,
        content=body.content,
        contact=body.contact,
        page=body.page,
        user_agent=(request.headers.get("user-agent") or "")[:400],
        created_at=utcnow(),
    )
    db.add(row)
    await db.commit()

    subject = f"[阶梯计划] 意见反馈 · {user.name or user.email}"
    lines = [
        f"来自：{user.name}（{user.email}）{'· 游客账号' if user.is_guest else ''}",
        f"页面：{body.page or '未知'}",
        f"联系方式：{body.contact or '未留'}",
        f"时间：{row.created_at:%Y-%m-%d %H:%M:%S}",
        "",
        "─" * 30,
        body.content,
        "─" * 30,
        "",
        f"反馈 ID：{row.id}",
    ]
    ok, err = await send_mail(settings.feedback_email, subject, "\n".join(lines))

    if ok:
        row.delivered_at = utcnow()
    else:
        row.error = err
        # 邮件没发出去不是用户的问题，日志留痕，管理员可从库里补看
        log.warning("反馈邮件未送达（已落库 %s）：%s", row.id, err)
    await db.commit()

    # 无论邮件成功与否，对用户都是「收到了」—— 因为确实收到了（在库里）
    return {"id": row.id, "delivered": ok}
