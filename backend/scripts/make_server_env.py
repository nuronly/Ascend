"""生成可直接粘贴到服务器的生产配置。

读取本地 backend/.env 里的 API key，拼出一份完整的 .env.prod 内容
打印到终端。密钥只在本地和服务器之间流转，不会进入 git。

用法：
    python scripts/make_server_env.py
    python scripts/make_server_env.py --domain learn.example.com   # 有备案域名时
"""

from __future__ import annotations

import re
import secrets
import sys
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]


def read_local_env() -> dict[str, str]:
    out: dict[str, str] = {}
    p = BACKEND / ".env"
    if not p.exists():
        sys.exit("本地 backend/.env 不存在")
    for line in p.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def main() -> None:
    domain = ""
    if "--domain" in sys.argv:
        i = sys.argv.index("--domain")
        if i + 1 < len(sys.argv):
            domain = sys.argv[i + 1]

    env = read_local_env()
    maas_key = env.get("MAAS_API_KEY", "")
    maas_url = env.get("MAAS_BASE_URL", "")
    ds_key = env.get("DEEPSEEK_API_KEY", "")
    ds_url = env.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
    jwt_secret = secrets.token_urlsafe(48)

    site = domain or ":80"
    cors = f"https://{domain}" if domain else ""
    secure = "true" if domain else "false"

    print(f"""# ══════════════════════════════════════════════════════════
#  阶梯 · 生产配置（由 make_server_env.py 生成）
#  粘贴到服务器的 backend/.env
# ══════════════════════════════════════════════════════════

APP_ENV=prod
SERVE_FRONTEND=true
PUBLIC_URL={cors}
CORS_ORIGINS={cors}

# ── 鉴权 ──
JWT_SECRET={jwt_secret}
ACCESS_TOKEN_MINUTES=15
REFRESH_TOKEN_DAYS=30
COOKIE_SECURE={secure}
COOKIE_SAMESITE=lax

# ── 准入控制（参赛演示：评委可自由注册，上限兜底）──
ALLOW_REGISTRATION=true
INVITE_CODE=
MAX_USERS=50

# ── 速率限制 ──
RATE_LIMIT_ENABLED=true
RATE_AUTH_PER_MINUTE=10
RATE_AI_PER_MINUTE=40

# ── 预算闸（单人每日，100 万约等于连学 50 节课）──
DAILY_TOKEN_QUOTA=1000000

# ── 数据库（SQLite 单文件，裸机部署在 backend/data/ 下）──
DATABASE_URL=sqlite+aiosqlite:///./data/ladder.db

# ── 访问地址 ──
SITE_ADDRESS={site}

# ── LLM ──
DEEPSEEK_API_KEY={ds_key}
DEEPSEEK_BASE_URL={ds_url}
MAAS_API_KEY={maas_key}
MAAS_BASE_URL={maas_url}

MODEL_FLAGSHIP=deepseek:deepseek-v4-pro
MODEL_STANDARD=deepseek:deepseek-v4-pro
MODEL_SMALL=deepseek:deepseek-v4-flash
MODEL_EMBEDDING=maas:qwen3.7-text-embedding
EMBEDDING_DIM=1024
MODEL_IMAGE=maas:qwen-image-2.0-pro
MODEL_OVERRIDES=card_chat=deepseek:deepseek-v4-flash,suggest=deepseek:deepseek-v4-flash,translate=deepseek:deepseek-v4-flash
MODEL_FALLBACKS=maas:deepseek-v4-pro,maas:qwen3.8-max

LLM_TIMEOUT_SECONDS=180
LLM_FIRST_TOKEN_TIMEOUT=45
LLM_MAX_RETRIES=3
""", end="")

    print("# ── 以上由本地 backend/.env 提取生成 ──", file=sys.stderr)
    if not maas_key:
        print("# ⚠️ 本地 .env 里 MAAS_API_KEY 为空，embedding 和生图会不可用", file=sys.stderr)
    if not ds_key:
        print("# ⚠️ 本地 .env 里 DEEPSEEK_API_KEY 为空，主模型不可用", file=sys.stderr)


if __name__ == "__main__":
    main()
