#!/usr/bin/env bash
# 验证降级链：把主供应商的 key 改坏，确认能自动切到备用网关。
# 备用供应商存在的意义就在这里 —— 没验证过的降级等于没有。
set -u
cd "$(dirname "$0")/.."

pkill -f "port 8797" 2>/dev/null; sleep 1

# 故意给一个无效的 DeepSeek key，主供应商必然失败
DEEPSEEK_API_KEY=sk-invalid-key-for-fallback-test \
nohup .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port 8797 \
  > /tmp/fallback.log 2>&1 &

sleep 7

.venv/bin/python - <<'PY'
import asyncio, httpx, uuid, json
B = "http://127.0.0.1:8797/api"

async def main():
    tag = uuid.uuid4().hex[:6]
    async with httpx.AsyncClient(base_url=B, timeout=180) as c:
        await c.post("/auth/register", json={
            "email": f"fb{tag}@example.com", "name": "FB", "password": "test-pass-1234"})

        print("主供应商 key 已置为无效，发起一次真实 AI 调用…")
        r = await c.get("/courses/meta/suggestions")
        ok = r.status_code == 200 and r.json().get("topics")
        print(f"  结果: [{r.status_code}] {'✓ 仍然拿到内容' if ok else '✗ 失败'}")
        if ok:
            print(f"  内容: {r.json()['topics'][:3]}")

        u = (await c.get("/auth/usage")).json()
        print(f"  调用记录: {u['calls']} 次")

asyncio.run(main())
PY

echo
echo "=== 降级轨迹（ai_calls 表）==="
.venv/bin/python - <<'PY'
import asyncio
from sqlalchemy import select
from app.core.db import SessionLocal
from app.models.system import AICall

async def m():
    async with SessionLocal() as s:
        rows = (await s.execute(
            select(AICall.scene, AICall.provider, AICall.model, AICall.success,
                   AICall.fallback_hop, AICall.error)
            .order_by(AICall.created_at.desc()).limit(6))).all()
        for sc, pv, mo, okk, hop, err in reversed(rows):
            mark = "✓" if okk else "✗"
            tail = f"  {err[:52]}" if err else ""
            print(f"  {mark} 第{hop}跳  {pv:<9} {mo:<20}{tail}")
asyncio.run(m())
PY

pkill -f "port 8797" 2>/dev/null
