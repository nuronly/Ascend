#!/usr/bin/env bash
# 验证上线加固：邀请码准入 + 速率限制
set -u
cd "$(dirname "$0")/.."

pkill -f "port 8799" 2>/dev/null; sleep 1

ALLOW_REGISTRATION=true \
INVITE_CODE=secret-2026 \
MAX_USERS=3 \
RATE_LIMIT_ENABLED=true \
RATE_AUTH_PER_MINUTE=5 \
nohup .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8799 \
  > /tmp/gate.log 2>&1 &

sleep 6

.venv/bin/python - <<'PY'
import asyncio, httpx, uuid
B = "http://127.0.0.1:8799/api"

async def main():
    async with httpx.AsyncClient(base_url=B, timeout=30) as c:
        print("站点配置:", (await c.get("/auth/config")).json())
        t = uuid.uuid4().hex[:6]

        r = await c.post("/auth/register", json={
            "email": f"a{t}@example.com", "name": "A", "password": "test-pass-1234"})
        print(f"  无邀请码   → [{r.status_code}] {r.json().get('detail')}")

        r = await c.post("/auth/register", json={
            "email": f"b{t}@example.com", "name": "B", "password": "test-pass-1234",
            "invite_code": "wrong"})
        print(f"  错误邀请码 → [{r.status_code}] {r.json().get('detail')}")

        r = await c.post("/auth/register", json={
            "email": f"c{t}@example.com", "name": "C", "password": "test-pass-1234",
            "invite_code": "secret-2026"})
        print(f"  正确邀请码 → [{r.status_code}] {'注册成功' if r.status_code == 201 else r.text[:90]}")

        print("\n速率限制（认证端点 5 次/分钟）:")
        codes = []
        for _ in range(9):
            r = await c.post("/auth/login",
                             json={"email": "nobody@example.com", "password": "xxxxxxxx"})
            codes.append(r.status_code)
        print("  连续 9 次登录:", codes)
        print("  →", "✓ 超出后被 429 拦截" if 429 in codes else "✗ 未触发限流")

asyncio.run(main())
PY

pkill -f "port 8799" 2>/dev/null
echo "done"
