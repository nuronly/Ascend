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
