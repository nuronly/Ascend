"""密码哈希与 JWT（PLAN §4.2）。

两个关键决定：
1. argon2id 而非 bcrypt —— bcrypt 有 72 字节静默截断，且抗 GPU 能力弱。
2. token 一律走 httpOnly cookie，绝不存 localStorage。
   本产品要渲染大量 LLM 生成的 Markdown，XSS 面比普通应用大得多，
   localStorage 里的 token 一旦被 XSS 拿到就是全量沦陷。
"""

from __future__ import annotations

import hashlib
import secrets
from datetime import timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher

from app.core.config import settings
from app.core.types import utcnow

# 参数取 argon2 官方 RFC 9106 的第二推荐档：64MB 内存 / 3 轮
_hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4, hash_len=32, salt_len=16)

ALG = "HS256"
TOKEN_ACCESS = "access"
TOKEN_REFRESH = "refresh"


def hash_password(raw: str) -> str:
    return _hasher.hash(raw)


def verify_password(raw: str, hashed: str | None) -> bool:
    if not hashed:
        return False
    try:
        _hasher.verify(hashed, raw)
        return True
    except Exception:
        # 覆盖 VerifyMismatchError / InvalidHashError / 非法哈希串等全部情况，
        # 一律当作验证失败，不向调用方泄露具体原因
        return False


def needs_rehash(hashed: str) -> bool:
    try:
        return _hasher.check_needs_rehash(hashed)
    except Exception:
        return False


# ─────────────────────────────────────────────────────────────
# JWT
# ─────────────────────────────────────────────────────────────
def create_access_token(user_id: str, *, extra: dict[str, Any] | None = None) -> str:
    now = utcnow()
    payload = {
        "sub": user_id,
        "typ": TOKEN_ACCESS,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(minutes=settings.access_token_minutes)).timestamp()),
        "jti": secrets.token_urlsafe(12),
        **(extra or {}),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=ALG)


def decode_token(token: str, *, expect: str = TOKEN_ACCESS) -> dict[str, Any] | None:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[ALG])
    except jwt.PyJWTError:
        return None
    if payload.get("typ") != expect:
        return None
    return payload


# ─────────────────────────────────────────────────────────────
# Refresh token：随机串，只把哈希落库（可撤销）
# ─────────────────────────────────────────────────────────────
def new_refresh_token() -> tuple[str, str]:
    """返回 (明文, sha256)。明文只进 httpOnly cookie，库里只留哈希。"""
    raw = secrets.token_urlsafe(48)
    return raw, hash_refresh_token(raw)


def hash_refresh_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()
