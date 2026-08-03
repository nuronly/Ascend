"""鉴权 API（PLAN §4.2）。"""

from __future__ import annotations

from datetime import timedelta

from fastapi import APIRouter, HTTPException, Request, Response, status
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import func, select, update

from app.api.deps import ACCESS_COOKIE, REFRESH_COOKIE, CurrentUser, Db
from app.core.config import settings
from app.core.security import (
    create_access_token,
    hash_password,
    hash_refresh_token,
    needs_rehash,
    new_refresh_token,
    verify_password,
)
from app.core.types import new_id, utcnow
from app.models.user import RefreshToken, User

router = APIRouter(prefix="/auth", tags=["auth"])


# ─────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────
class RegisterIn(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=60)
    password: str = Field(min_length=8, max_length=128)
    invite_code: str = Field(default="", max_length=100)


class LoginIn(BaseModel):
    email: EmailStr
    password: str


class UserOut(BaseModel):
    id: str
    email: str
    name: str
    settings: dict = {}

    @classmethod
    def of(cls, u: User) -> UserOut:
        return cls(id=u.id, email=u.email, name=u.name, settings=u.settings or {})


class SettingsIn(BaseModel):
    theme: str | None = Field(default=None, pattern="^(light|dark|system)$")
    daily_token_quota: int | None = Field(default=None, ge=0)
    default_pomodoro_minutes: int | None = Field(default=None, ge=5, le=120)


class PasswordIn(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=128)


# ─────────────────────────────────────────────────────────────
# Cookie 工具
# ─────────────────────────────────────────────────────────────
def _set_auth_cookies(resp: Response, access: str, refresh: str) -> None:
    common = {
        "httponly": True,  # JS 读不到 —— XSS 偷不走
        "secure": settings.cookie_secure,
        "samesite": settings.cookie_samesite,
        "path": "/",
    }
    resp.set_cookie(
        ACCESS_COOKIE, access, max_age=settings.access_token_minutes * 60, **common
    )
    resp.set_cookie(
        REFRESH_COOKIE,
        refresh,
        max_age=settings.refresh_token_days * 86400,
        # refresh 只在刷新与登出两个端点用得到，缩小暴露面
        **{**common, "path": "/api/auth"},
    )


def _clear_auth_cookies(resp: Response) -> None:
    resp.delete_cookie(ACCESS_COOKIE, path="/")
    resp.delete_cookie(REFRESH_COOKIE, path="/api/auth")


async def _issue_refresh(db: Db, user_id: str, request: Request) -> str:
    raw, hashed = new_refresh_token()
    db.add(
        RefreshToken(
            id=new_id(),
            user_id=user_id,
            token_hash=hashed,
            expires_at=utcnow() + timedelta(days=settings.refresh_token_days),
            user_agent=(request.headers.get("user-agent") or "")[:400],
            ip=(request.client.host if request.client else None),
            created_at=utcnow(),
        )
    )
    return raw


# ─────────────────────────────────────────────────────────────
# 端点
# ─────────────────────────────────────────────────────────────
@router.get("/config")
async def auth_config() -> dict:
    """给登录页用：是否开放注册、要不要邀请码。"""
    return {
        "allow_registration": settings.allow_registration,
        "invite_required": bool(settings.invite_code),
    }


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def register(body: RegisterIn, request: Request, response: Response, db: Db) -> UserOut:
    # ★ 准入控制：多用户 + 云 API = 别人用你的 key 花你的钱（PLAN §4.2）
    if not settings.allow_registration:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "本站暂未开放注册")
    if settings.invite_code and body.invite_code.strip() != settings.invite_code:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "邀请码不正确")
    if settings.max_users:
        total = await db.scalar(select(func.count(User.id))) or 0
        if total >= settings.max_users:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "名额已满")

    email = body.email.lower().strip()
    exists = await db.scalar(select(User.id).where(User.email == email))
    if exists:
        raise HTTPException(status.HTTP_409_CONFLICT, "该邮箱已注册")

    user = User(
        id=new_id(),
        email=email,
        name=body.name.strip(),
        password_hash=hash_password(body.password),
        email_verified=False,
        settings={"theme": "system", "default_pomodoro_minutes": 25},
        created_at=utcnow(),
    )
    db.add(user)
    # 必须先 flush：refresh_tokens 有指向 users 的外键，
    # 而两者之间没有 relationship，SQLAlchemy 推断不出插入顺序
    await db.flush()
    refresh = await _issue_refresh(db, user.id, request)
    await db.commit()

    _set_auth_cookies(response, create_access_token(user.id), refresh)
    return UserOut.of(user)


@router.post("/login", response_model=UserOut)
async def login(body: LoginIn, request: Request, response: Response, db: Db) -> UserOut:
    email = body.email.lower().strip()
    user = await db.scalar(select(User).where(User.email == email))

    # 邮箱不存在时也走一次哈希验证，抹平时间差，避免用户枚举
    if not verify_password(body.password, user.password_hash if user else None) or not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "邮箱或密码不正确")

    if user.password_hash and needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)

    refresh = await _issue_refresh(db, user.id, request)
    await db.commit()
    _set_auth_cookies(response, create_access_token(user.id), refresh)
    return UserOut.of(user)


@router.post("/refresh", response_model=UserOut)
async def refresh_token(request: Request, response: Response, db: Db) -> UserOut:
    raw = request.cookies.get(REFRESH_COOKIE)
    if not raw:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "缺少刷新令牌")

    row = await db.scalar(
        select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(raw))
    )
    if row is None or not row.is_active:
        _clear_auth_cookies(response)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "刷新令牌无效或已过期")

    user = await db.get(User, row.user_id)
    if user is None:
        _clear_auth_cookies(response)
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "账号不存在")

    # 轮换：旧的立即作废。被盗用的旧 token 第二次使用即失效。
    row.revoked_at = utcnow()
    new_raw = await _issue_refresh(db, user.id, request)
    await db.commit()

    _set_auth_cookies(response, create_access_token(user.id), new_raw)
    return UserOut.of(user)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(request: Request, response: Response, db: Db) -> None:
    if raw := request.cookies.get(REFRESH_COOKIE):
        await db.execute(
            update(RefreshToken)
            .where(RefreshToken.token_hash == hash_refresh_token(raw))
            .values(revoked_at=utcnow())
        )
        await db.commit()
    _clear_auth_cookies(response)


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser) -> UserOut:
    return UserOut.of(user)


@router.patch("/me/settings", response_model=UserOut)
async def update_settings(body: SettingsIn, user: CurrentUser, db: Db) -> UserOut:
    merged = dict(user.settings or {})
    merged.update({k: v for k, v in body.model_dump().items() if v is not None})
    user.settings = merged
    await db.commit()
    return UserOut.of(user)


@router.post("/me/password", status_code=status.HTTP_204_NO_CONTENT)
async def change_password(
    body: PasswordIn, user: CurrentUser, db: Db, response: Response, request: Request
) -> None:
    if not verify_password(body.current_password, user.password_hash):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "当前密码不正确")
    user.password_hash = hash_password(body.new_password)
    # 改密后吊销全部会话，只保留当前这台设备
    await db.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )
    new_raw = await _issue_refresh(db, user.id, request)
    await db.commit()
    _set_auth_cookies(response, create_access_token(user.id), new_raw)


@router.get("/usage")
async def usage(user: CurrentUser) -> dict:
    """当日 AI 用量与成本（PLAN §4.2 成本归属）。"""
    from app.api.deps import user_quota
    from app.llm import usage_today

    data = await usage_today(user.id)
    data["quota"] = user_quota(user)
    return data
