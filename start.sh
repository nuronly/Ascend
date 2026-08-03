#!/usr/bin/env bash
# 阶梯 · 一键启动（开发模式）
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$(pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

c()  { printf "\033[36m%s\033[0m\n" "$1"; }
ok() { printf "\033[32m✓\033[0m %s\n" "$1"; }
er() { printf "\033[31m✗\033[0m %s\n" "$1"; }

cleanup() {
  echo
  c "正在停止…"
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "${WEB_PID:-}" ]] && kill "$WEB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  ok "已停止"
}
trap cleanup EXIT INT TERM

# ── 前置检查 ──────────────────────────────────────────────
command -v uv   >/dev/null || { er "缺少 uv，安装：curl -LsSf https://astral.sh/uv/install.sh | sh"; exit 1; }
command -v node >/dev/null || { er "缺少 Node.js（需要 18+）"; exit 1; }

if [[ ! -f "$BACKEND/.env" ]]; then
  er "缺少 backend/.env"
  echo "  请执行：cp backend/.env.example backend/.env  然后填入 API key"
  exit 1
fi

if ! grep -qE '^MAAS_API_KEY=.+' "$BACKEND/.env" && ! grep -qE '^DEEPSEEK_API_KEY=.+' "$BACKEND/.env"; then
  er "backend/.env 里没有配置任何 LLM API key"
  exit 1
fi

mkdir -p "$BACKEND/logs" "$BACKEND/data"

# ── 依赖 ──────────────────────────────────────────────────
c "检查后端依赖…"
(cd "$BACKEND" && uv sync --quiet)
ok "后端依赖就绪"

if [[ ! -d "$FRONTEND/node_modules" ]]; then
  c "安装前端依赖（首次会慢一点）…"
  (cd "$FRONTEND" && npm install --silent)
fi
ok "前端依赖就绪"

# ── 启动 ──────────────────────────────────────────────────
c "启动后端 http://127.0.0.1:8788 …"
(cd "$BACKEND" && exec .venv/bin/python -m uvicorn app.main:app \
   --host 127.0.0.1 --port 8788 --reload) > "$BACKEND/logs/server.log" 2>&1 &
API_PID=$!

for i in $(seq 1 40); do
  if curl -sf -m 2 http://127.0.0.1:8788/api/health >/dev/null 2>&1; then break; fi
  if ! kill -0 "$API_PID" 2>/dev/null; then
    er "后端启动失败，日志："
    tail -30 "$BACKEND/logs/server.log"
    exit 1
  fi
  sleep 0.5
done
ok "后端已就绪"

c "启动前端 http://localhost:5173 …"
(cd "$FRONTEND" && exec npm run dev) &
WEB_PID=$!

sleep 3
echo
printf "\033[1m  阶梯已启动\033[0m\n\n"
echo "    应用     http://localhost:5173"
echo "    API 文档  http://127.0.0.1:8788/api/docs"
echo "    后端日志  backend/logs/server.log"
echo
echo "  按 Ctrl+C 停止"
echo

wait
