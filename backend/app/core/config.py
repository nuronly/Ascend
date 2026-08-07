"""应用配置。所有密钥只在服务端，前端永不直连 LLM（PLAN §4.1）。"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=BACKEND_DIR / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ── 应用 ──
    app_env: str = "dev"
    app_host: str = "127.0.0.1"
    app_port: int = 8788
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    # 生产环境的公开地址，用于 cookie 域与自检提示
    public_url: str = ""

    # ── ★ 准入控制（上线的第一道闸）──
    # 多用户 + 云 API = 别人用你的 key 花你的钱。
    # 公开上线时必须关闭自由注册，或者设置邀请码。
    allow_registration: bool = True
    invite_code: str = ""
    # 全站用户数上限，0 = 不限
    max_users: int = 0
    # 游客模式：登录页提供免密入口，所有人共享同一个 guest 账号。
    # 面向比赛/演示场景 —— 数据互通是特性不是缺陷，但意味着任何游客
    # 都能看到其他游客产生的内容，且额度是所有人共烧一份。
    guest_enabled: bool = True
    # 游客账号的每日 token 额度（共享账号，烧的是所有人的份）
    guest_daily_token_quota: int = 200_000

    # ── 意见反馈 ──
    # 收件人。反馈一律先落库，邮件只是通知手段
    feedback_email: str = "3391442399@qq.com"
    # SMTP 不配也不影响功能：反馈照常落库，只是不发邮件
    # （QQ 邮箱：smtp.qq.com:465，密码填「授权码」而不是登录密码）
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_user: str = ""
    smtp_password: str = ""
    # 发件地址，留空则用 smtp_user
    smtp_from: str = ""
    smtp_ssl: bool = True

    @property
    def smtp_ready(self) -> bool:
        return bool(self.smtp_host and self.smtp_user and self.smtp_password)

    # ── 静态前端（单体部署时由后端直接提供）──
    serve_frontend: bool = False
    frontend_dist: str = ""

    # ── 速率限制（每 IP）──
    rate_limit_enabled: bool = False
    # 认证类端点：防撞库
    rate_auth_per_minute: int = 10
    # AI 类端点：防刷额度
    rate_ai_per_minute: int = 20

    # ── 鉴权 ──
    jwt_secret: str = "dev-only-secret-please-change-me"
    jwt_algorithm: str = "HS256"
    access_token_minutes: int = 15
    refresh_token_days: int = 30
    cookie_secure: bool = False
    cookie_samesite: str = "lax"

    # ── 数据库 ──
    database_url: str = "sqlite+aiosqlite:///./data/ladder.db"

    # ── LLM Provider ──
    maas_api_key: str = ""
    maas_base_url: str = ""
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"

    # ── 分级路由 ──
    model_flagship: str = "maas:qwen3.8-max"
    model_standard: str = "maas:qwen3.7-plus"
    model_small: str = "maas:qwen3.7-flash"
    model_embedding: str = "maas:qwen3.7-text-embedding"
    model_image: str = "maas:qwen-image-2.0-pro"
    embedding_dim: int = 1024
    model_fallbacks: str = ""
    # 场景级精确覆盖，优先级高于档位。格式：scene=provider:model,scene=provider:model
    model_overrides: str = ""

    # ── 成本 ──
    daily_token_quota: int = 2_000_000
    llm_timeout_seconds: float = 180.0
    llm_first_token_timeout: float = 45.0
    llm_max_retries: int = 3

    # ── 派生属性 ──
    @field_validator("cookie_samesite")
    @classmethod
    def _check_samesite(cls, v: str) -> str:
        v = v.lower()
        if v not in {"lax", "strict", "none"}:
            raise ValueError("cookie_samesite 必须是 lax / strict / none")
        return v

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def fallback_list(self) -> list[str]:
        return [m.strip() for m in self.model_fallbacks.split(",") if m.strip()]

    @property
    def override_map(self) -> dict[str, str]:
        """场景 → 模型规格。

        档位（旗舰/中档/小模型）是粗粒度的，但 PLAN §4.1 的表格里
        有 7 个场景，它们对「质量 vs 延迟」的取舍并不一致 ——
        比如小节正文和卡片问答同属中档，前者要质量、后者要快。
        这一层让每个场景都能单独指定，而不必增加档位概念。
        """
        out: dict[str, str] = {}
        for pair in self.model_overrides.split(","):
            pair = pair.strip()
            if "=" not in pair:
                continue
            scene, spec = pair.split("=", 1)
            if scene.strip() and spec.strip():
                out[scene.strip()] = spec.strip()
        return out

    @property
    def is_sqlite(self) -> bool:
        return self.database_url.startswith("sqlite")

    @property
    def is_postgres(self) -> bool:
        return "postgres" in self.database_url

    @property
    def is_dev(self) -> bool:
        return self.app_env == "dev"

    @property
    def data_dir(self) -> Path:
        d = BACKEND_DIR / "data"
        d.mkdir(parents=True, exist_ok=True)
        return d

    @property
    def resolved_database_url(self) -> str:
        """把 SQLite 的相对路径解析为基于 backend/ 目录的绝对路径。

        ⚠️ 不这么做有个很隐蔽的坑：`sqlite+aiosqlite:///./data/ladder.db`
        里的 `./` 是相对**启动时的工作目录**。从 backend/ 启动是一个库，
        从仓库根目录启动就会在根目录新建一个空库 —— 换个目录启动，
        数据就"消失了"。一律解析成绝对路径，行为与启动位置无关。
        """
        url = self.database_url
        prefix = "sqlite+aiosqlite:///"
        if url.startswith(prefix):
            rel = url[len(prefix) :]
            if rel and not rel.startswith("/"):
                return prefix + str((BACKEND_DIR / rel).resolve())
        return url

    @property
    def is_prod(self) -> bool:
        return self.app_env in ("prod", "production")

    @property
    def dist_path(self) -> Path | None:
        if not self.serve_frontend:
            return None
        p = (
            Path(self.frontend_dist)
            if self.frontend_dist
            else BACKEND_DIR.parent / "frontend" / "dist"
        )
        return p if (p / "index.html").exists() else None

    def production_warnings(self) -> list[str]:
        """上线自检。启动时打印，把容易漏的坑摆到眼前。"""
        w: list[str] = []
        if not self.is_prod:
            return w
        if self.jwt_secret in ("", "dev-only-secret-please-change-me") or len(self.jwt_secret) < 32:
            w.append("JWT_SECRET 仍是默认值或过短 —— 任何人都能伪造登录态")
        if not self.cookie_secure:
            w.append("COOKIE_SECURE=false —— HTTPS 下应设为 true，否则 cookie 会明文传输")
        if self.allow_registration and not self.invite_code and not self.max_users:
            w.append(
                "注册完全开放且无邀请码 —— 别人注册后会消耗你的 LLM 额度，"
                "建议设置 INVITE_CODE 或 MAX_USERS"
            )
        if self.daily_token_quota <= 0:
            w.append("DAILY_TOKEN_QUOTA=0（不限额）—— 单个用户就能刷爆你的账单")
        if not self.rate_limit_enabled:
            w.append("未开启速率限制 —— 建议 RATE_LIMIT_ENABLED=true")
        if self.is_sqlite:
            w.append("使用 SQLite —— 单进程可用；若要多 worker 请切换到 PostgreSQL")
        return w


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if s.is_sqlite:
        s.data_dir  # noqa: B018 — 确保 SQLite 目录存在
    return s


settings = get_settings()

# 分级路由档位常量，供 ai_calls.tier 记录（PLAN §5）
TIER_FLAGSHIP = "flagship"
TIER_STANDARD = "standard"
TIER_SMALL = "small"
TIER_EMBEDDING = "embedding"
TIER_IMAGE = "image"

TIER_TO_MODEL: dict[str, str] = {
    TIER_FLAGSHIP: settings.model_flagship,
    TIER_STANDARD: settings.model_standard,
    TIER_SMALL: settings.model_small,
    TIER_EMBEDDING: settings.model_embedding,
    TIER_IMAGE: settings.model_image,
}
