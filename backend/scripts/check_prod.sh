#!/usr/bin/env bash
# 验证生产单体模式：后端直接提供前端静态文件 + SPA fallback
set -u
cd "$(dirname "$0")/.."

if [ ! -f ../frontend/dist/index.html ]; then
  echo "缺少前端产物，请先执行：cd frontend && npm run build"
  exit 1
fi

pkill -f "port 8799" 2>/dev/null; sleep 1

APP_ENV=prod \
SERVE_FRONTEND=true \
COOKIE_SECURE=true \
RATE_LIMIT_ENABLED=true \
INVITE_CODE=demo \
MAX_USERS=20 \
DAILY_TOKEN_QUOTA=400000 \
JWT_SECRET="$(openssl rand -base64 48)" \
nohup .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8799 \
  > /tmp/prod.log 2>&1 &

sleep 7

ASSET=$(ls ../frontend/dist/assets 2>/dev/null | head -1)
echo "=== 生产单体模式 ==="
curl -s -m 5 -o /dev/null -w "  首页            %{http_code}\n" http://127.0.0.1:8799/
curl -s -m 5 -o /dev/null -w "  深层路由刷新     %{http_code}  (SPA fallback)\n" http://127.0.0.1:8799/vault
curl -s -m 5 -o /dev/null -w "  静态资源        %{http_code}\n" "http://127.0.0.1:8799/assets/$ASSET"
curl -s -m 5 -o /dev/null -w "  API             %{http_code}\n" http://127.0.0.1:8799/api/health
curl -s -m 5 -o /dev/null -w "  API 文档        %{http_code}  (生产应为 404)\n" http://127.0.0.1:8799/api/docs
curl -s -m 5 -o /dev/null -w "  不存在的 API     %{http_code}  (不该被 SPA 吞掉)\n" http://127.0.0.1:8799/api/nope

echo
echo "=== 启动自检 ==="
grep -E "自检|⚠️|静态前端" /tmp/prod.log | head -10

pkill -f "port 8799" 2>/dev/null
