"""FastAPI 依赖注入。"""

from __future__ import annotations

from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import get_session
from app.core.scope import UserScope
from app.core.security import TOKEN_ACCESS, decode_token
from app.models.user import User

ACCESS_COOKIE = "ladder_at"
REFRESH_COOKIE = "ladder_rt"


def _unauthorized(detail: str = "未登录或登录已过期") -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail)


def _read_token(request: Request) -> str | None:
    """优先 httpOnly cookie；Bearer 头仅为方便脚本调试而保留。"""
    if tok := request.cookies.get(ACCESS_COOKIE):
        return tok
    auth = request.headers.get("Authorization", "")
    if auth.lower().startswith("bearer "):
        return auth[7:].strip()
    return None


async def get_current_user(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> User:
    token = _read_token(request)
    if not token:
        raise _unauthorized()
    payload = decode_token(token, expect=TOKEN_ACCESS)
    if not payload:
        raise _unauthorized()
    user = await session.get(User, payload.get("sub"))
    if user is None:
        raise _unauthorized("账号不存在")
    return user


async def get_optional_user(
    request: Request,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> User | None:
    try:
        return await get_current_user(request, session)
    except HTTPException:
        return None


async def get_scope(
    session: Annotated[AsyncSession, Depends(get_session)],
    user: Annotated[User, Depends(get_current_user)],
) -> UserScope:
    """业务层拿到的数据访问句柄 —— 天然锁定在当前用户。"""
    return UserScope(session, user.id)


def user_quota(user: User) -> int:
    raw = (user.settings or {}).get("daily_token_quota")
    try:
        return int(raw) if raw is not None else settings.daily_token_quota
    except (TypeError, ValueError):
        return settings.daily_token_quota


CurrentUser = Annotated[User, Depends(get_current_user)]
OptionalUser = Annotated[User | None, Depends(get_optional_user)]
Scope = Annotated[UserScope, Depends(get_scope)]
Db = Annotated[AsyncSession, Depends(get_session)]
