# ─────────────────────────────────────────────────────────────
#  阶梯 · 生产镜像（单体：后端直接提供前端静态文件）
#
#  这样部署最省事 —— 一个容器、一个域名、零 CORS、零跨域 cookie 问题。
# ─────────────────────────────────────────────────────────────

# ── 阶段 1：构建前端 ──
FROM node:22-slim AS web

WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./
RUN npm run build


# ── 阶段 2：Python 依赖 ──
FROM python:3.12-slim AS deps

ENV PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy

COPY --from=ghcr.io/astral-sh/uv:latest /uv /usr/local/bin/uv

WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
# 只装依赖，不装项目本身 —— 这一层能被 Docker 缓存复用
RUN uv sync --frozen --no-dev --no-install-project


# ── 阶段 3：运行时 ──
FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PATH="/app/.venv/bin:$PATH" \
    APP_ENV=prod \
    SERVE_FRONTEND=true \
    FRONTEND_DIST=/app/web \
    TZ=Asia/Shanghai

# pdfplumber 需要的图形库；curl 供健康检查
RUN apt-get update && apt-get install -y --no-install-recommends \
        libjpeg62-turbo zlib1g curl tzdata \
    && rm -rf /var/lib/apt/lists/*

# 不用 root 跑
RUN useradd -m -u 10001 ladder

WORKDIR /app
COPY --from=deps /app/.venv /app/.venv
COPY backend/app ./app
COPY backend/scripts ./scripts
COPY backend/pyproject.toml ./
COPY --from=web /web/dist /app/web

# jieba 首次分词要加载词典（约 1 秒），提前烤进镜像，避免第一个用户等
RUN python -c "import jieba; jieba.setLogLevel(60); jieba.initialize()" \
    && mkdir -p /app/data /app/logs \
    && chown -R ladder:ladder /app

USER ladder
VOLUME ["/app/data"]
EXPOSE 8788

HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8788/api/health || exit 1

# ⚠️ 单 worker：SQLite 多进程写会锁竞争。
#    要上多 worker 请先切到 PostgreSQL（改 DATABASE_URL 一行即可）。
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8788", \
     "--proxy-headers", "--forwarded-allow-ips", "*", \
     "--timeout-keep-alive", "75"]
