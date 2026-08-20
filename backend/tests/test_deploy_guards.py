"""部署形态相关的两道防线。

这两处的共同点是：配错了不会报错、不会有任何日志，只会静默失效 ——
所以必须有测试把行为钉死。

  · 限流按谁的 IP 算。单体部署（uvicorn 直接对外）时若还信任
    X-Forwarded-For，伪造一个 header 就换一个桶，撞库与刷额度的
    防护全部作废；反过来，反代部署时若不信任它，所有人会被算成
    反代那一个 IP，一个人触发限流就把全站挡在门外。两个方向都是坏的。
  · 请求体上限。反代模式由 Nginx 的 client_max_body_size 兜住，
    单体部署没有那道闸 —— multipart 在解析阶段就把数据落到临时文件，
    等执行到路由里的大小判断，磁盘已经被写满了。

没装 pytest 也能跑：python tests/test_deploy_guards.py
"""

from __future__ import annotations

import sys
from pathlib import Path

# 直接 `python tests/test_deploy_guards.py` 时 backend/ 不在 sys.path 里；
# 走 `python -m pytest` 时 cwd 已经在路径中，这几行是幂等的。
_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from contextlib import contextmanager  # noqa: E402

import httpx  # noqa: E402
from starlette.requests import Request  # noqa: E402
from starlette.responses import PlainTextResponse  # noqa: E402

from app.core import ratelimit  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.main import BodySizeLimitMiddleware  # noqa: E402


@contextmanager
def 临时配置(**kw):
    """改 settings 并保证还原，顺带清空限流桶（它是模块级全局状态）。

    刻意不用 pytest 的 monkeypatch —— 这样这个文件在没装 pytest 的
    环境里也能直接跑，部署机上排查问题时很有用。
    """
    old = {k: getattr(settings, k) for k in kw}
    for k, v in kw.items():
        setattr(settings, k, v)
    ratelimit._buckets.clear()
    try:
        yield
    finally:
        for k, v in old.items():
            setattr(settings, k, v)
        ratelimit._buckets.clear()


def _请求(path: str, *, 来源: str, 转发头: str | None = None, method: str = "GET") -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if 转发头 is not None:
        headers.append((b"x-forwarded-for", 转发头.encode()))
    return Request(
        {
            "type": "http",
            "method": method,
            "path": path,
            "raw_path": path.encode(),
            "headers": headers,
            "client": (来源, 54321),
            "query_string": b"",
            "scheme": "http",
            "server": ("testserver", 80),
        }
    )


async def _放行(_: Request) -> PlainTextResponse:
    return PlainTextResponse("ok")


class Test取来源IP:
    def test_不信任反代时无视伪造的转发头(self):
        with 临时配置(trust_proxy_headers=False):
            req = _请求("/api/x", 来源="203.0.113.9", 转发头="1.1.1.1")
            assert ratelimit._client_ip(req) == "203.0.113.9"

    def test_信任反代时取转发链的第一跳(self):
        with 临时配置(trust_proxy_headers=True):
            req = _请求("/api/x", 来源="10.0.0.1", 转发头="1.1.1.1, 10.0.0.1")
            assert ratelimit._client_ip(req) == "1.1.1.1"

    def test_信任反代但没有转发头时退回连接来源(self):
        # Nginx 配置漏了 proxy_set_header 时会走到这里，不该崩
        with 临时配置(trust_proxy_headers=True):
            assert ratelimit._client_ip(_请求("/api/x", 来源="10.0.0.1")) == "10.0.0.1"


class Test限流不能被伪造的转发头绕过:
    async def test_单体模式下换多少个伪造IP都照样被挡(self):
        """这是最关键的一条：修复前每次伪造一个新 IP 就开一个新桶，
        限额形同虚设 —— 6 次请求会全部返回 200。"""
        with 临时配置(
            trust_proxy_headers=False, rate_limit_enabled=True, rate_auth_per_minute=3
        ):
            codes = []
            for i in range(6):
                req = _请求(
                    "/api/auth/login", 来源="203.0.113.9", 转发头=f"9.9.9.{i}", method="POST"
                )
                codes.append((await ratelimit.rate_limit_middleware(req, _放行)).status_code)
            assert codes == [200, 200, 200, 429, 429, 429]

    async def test_反代模式下不同真实用户互不连坐(self):
        with 临时配置(
            trust_proxy_headers=True, rate_limit_enabled=True, rate_auth_per_minute=3
        ):
            async def 打一次(xff: str) -> int:
                req = _请求("/api/auth/login", 来源="10.0.0.1", 转发头=xff, method="POST")
                return (await ratelimit.rate_limit_middleware(req, _放行)).status_code

            assert [await 打一次("1.1.1.1") for _ in range(3)] == [200, 200, 200]
            assert await 打一次("1.1.1.1") == 429
            # 另一个真实用户不该被前一个人的行为牵连
            assert await 打一次("2.2.2.2") == 200

    async def test_关掉限流时一律放行(self):
        with 临时配置(rate_limit_enabled=False, rate_auth_per_minute=1):
            for _ in range(5):
                req = _请求("/api/auth/login", 来源="203.0.113.9", method="POST")
                assert (await ratelimit.rate_limit_middleware(req, _放行)).status_code == 200


class Test请求体上限:
    @staticmethod
    def _客户端(max_bytes: int) -> httpx.AsyncClient:
        async def 回显长度(scope, receive, send) -> None:
            body = b""
            while True:
                msg = await receive()
                body += msg.get("body", b"")
                if not msg.get("more_body"):
                    break
            await send(
                {
                    "type": "http.response.start",
                    "status": 200,
                    "headers": [(b"content-type", b"text/plain")],
                }
            )
            await send({"type": "http.response.body", "body": str(len(body)).encode()})

        app = BodySizeLimitMiddleware(回显长度, max_bytes=max_bytes)
        return httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://testserver"
        )

    async def test_声明了过大的_content_length_一个字节都不收就拒绝(self):
        async with self._客户端(1024) as c:
            r = await c.post("/api/documents/upload", content=b"x" * 4096)
        assert r.status_code == 413
        assert r.json()["code"] == "payload_too_large"

    async def test_不声明长度的分块传输也会被掐掉(self):
        """真正危险的是这一种：没有 Content-Length，只能边收边数。
        修复前它能绕过任何基于头部的检查，一路把磁盘写满。"""

        async def 源源不断():
            for _ in range(20):
                yield b"y" * 512

        async with self._客户端(1024) as c:
            r = await c.post("/api/documents/upload", content=源源不断())
        assert r.status_code == 413

    async def test_正常大小的请求体不受影响(self):
        async with self._客户端(1024) as c:
            r = await c.post("/api/x", content=b"z" * 100)
        assert r.status_code == 200
        assert r.text == "100"

    async def test_恰好等于上限的请求体放行(self):
        # 边界不能反向踩：正好 1024 应该过，1025 才拦
        async with self._客户端(1024) as c:
            assert (await c.post("/api/x", content=b"z" * 1024)).status_code == 200
            assert (await c.post("/api/x", content=b"z" * 1025)).status_code == 413

    async def test_读操作不做检查(self):
        async with self._客户端(1024) as c:
            assert (await c.get("/api/health")).status_code == 200


def _独立运行() -> int:
    """没装 pytest 时的最小 runner。"""
    import asyncio
    import inspect
    import traceback

    ok = bad = 0
    for cls in (Test取来源IP, Test限流不能被伪造的转发头绕过, Test请求体上限):
        print(f"\n{cls.__name__}")
        inst = cls()
        for name in sorted(n for n in dir(inst) if n.startswith("test")):
            try:
                got = getattr(inst, name)()
                if inspect.iscoroutine(got):
                    asyncio.run(got)
                ok += 1
                print(f"  ✓ {name}")
            except Exception:
                bad += 1
                print(f"  ✗ {name}")
                traceback.print_exc()
    print(f"\n{'─' * 60}\n通过 {ok} · 失败 {bad}\n")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(_独立运行())
