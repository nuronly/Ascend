"""邮件发送（目前只用于意见反馈通知）。

用标准库 smtplib，不引第三方依赖 —— 全站就这一处发信需求，
为它装一套 SDK 不划算。

设计原则：**发信失败绝不能影响主流程**。
调用方先把数据落库，再调这里；这里只返回成功与否，不抛异常。
"""

from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from email.header import Header
from email.mime.text import MIMEText
from email.utils import formataddr, formatdate

from app.core.config import settings

log = logging.getLogger("ladder.mail")


def _send_sync(to: str, subject: str, body: str) -> None:
    sender = settings.smtp_from or settings.smtp_user

    msg = MIMEText(body, "plain", "utf-8")
    msg["Subject"] = Header(subject, "utf-8")
    # formataddr + Header：中文发件人名不做编码会被服务端判为乱码或直接退信
    msg["From"] = formataddr((str(Header("阶梯计划", "utf-8")), sender))
    msg["To"] = to
    msg["Date"] = formatdate(localtime=True)

    if settings.smtp_ssl:
        with smtplib.SMTP_SSL(
            settings.smtp_host, settings.smtp_port, timeout=15, context=ssl.create_default_context()
        ) as s:
            s.login(settings.smtp_user, settings.smtp_password)
            s.sendmail(sender, [to], msg.as_string())
    else:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as s:
            s.starttls(context=ssl.create_default_context())
            s.login(settings.smtp_user, settings.smtp_password)
            s.sendmail(sender, [to], msg.as_string())


async def send_mail(to: str, subject: str, body: str) -> tuple[bool, str]:
    """发一封纯文本邮件。返回 (是否成功, 失败原因)。

    smtplib 是同步阻塞的，丢进线程池，别把事件循环卡住 ——
    QQ 邮箱偶尔要几秒才响应，卡住的话整个服务的其他请求都得等。
    """
    if not settings.smtp_ready:
        return False, "SMTP 未配置"
    if not to:
        return False, "收件人为空"
    try:
        await asyncio.to_thread(_send_sync, to, subject, body)
        return True, ""
    except Exception as exc:  # noqa: BLE001 —— 发信失败不该冒泡到主流程
        log.warning("邮件发送失败：%s", exc)
        return False, f"{type(exc).__name__}: {exc}"[:500]
