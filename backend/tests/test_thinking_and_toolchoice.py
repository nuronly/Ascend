"""关思考链、工具收敛、标记泄漏 —— 三件事都会静默失效。

这一版修的是一个真实事故：第二大脑问一个问题，等 40 秒，等来的首字是
`<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="search_memory">…`
—— DeepSeek 的内部标记语言整段泄漏进答案。

诊断出来是三层叠加：

  1. brain_answer 漏传 max_rounds，吃全局的 3 轮（那个 3 是给大纲定的），
     模型一轮里并行发四五个调用，13 次工具 / 4 次完整往返
  2. 每轮都带着思考链。实测关掉之后首字 3420ms → 758ms（四五倍）
  3. 最后一轮「干脆不给工具」，可模型还想查 —— 没有原生通道，
     就把工具调用当正文吐出来

三条修法各自都有静默失效的方式，所以每条都要测：

  · 关思考的**参数名各家不同**。给错的那个不报错，只是被忽略；更糟的是
    实测 deepseek 收到 enable_thinking=false 后思维链照跑，342 字吃光
    max_tokens=200，正文零产出 —— 表现成「模型什么都没回答」
  · 参数名必须**逐跳重新取**，因为降级链跨供应商
  · tool_choice="none" 若退回成 specs=None，泄漏立刻回来，而且不报错

没装 pytest 也能跑：python tests/test_thinking_and_toolchoice.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import httpx  # noqa: E402

from app.llm import router  # noqa: E402
from app.llm.base import Message, StreamChunk, ToolCall, ToolEvent  # noqa: E402
from app.llm.openai_compat import OpenAICompatProvider  # noqa: E402
from app.llm.tools import ToolResult  # noqa: E402


# ── 替身 ────────────────────────────────────────────────────────
def _sse(*chunks: dict) -> bytes:
    body = "".join(f"data: {json.dumps(c, ensure_ascii=False)}\n\n" for c in chunks)
    return (body + "data: [DONE]\n\n").encode()


def _text(s: str) -> dict:
    return {"choices": [{"index": 0, "delta": {"content": s}}]}


def _recorder(name: str, payloads: list[dict], sse: bytes) -> OpenAICompatProvider:
    """会把每次请求体记下来的 provider —— 要验证的正是「发出去的 body 长什么样」。"""
    p = OpenAICompatProvider(name, "http://x/v1", "k")

    def handler(req: httpx.Request) -> httpx.Response:
        payloads.append(json.loads(req.content))
        return httpx.Response(200, content=sse)

    p._client = httpx.AsyncClient(  # type: ignore[assignment]
        transport=httpx.MockTransport(handler), base_url="http://x/v1"
    )
    return p


class _T:
    name = "t"
    description = "d"

    def schema(self) -> dict:
        return {"type": "object", "properties": {}}

    async def run(self, **_kw):
        return ToolResult(content="x")


# ── 1. 关思考：参数名按 provider 分发 ───────────────────────────
class Test关思考的参数名:
    def test_两家的参数名不一样(self):
        ds = OpenAICompatProvider("deepseek", "http://x/v1", "k")
        maas = OpenAICompatProvider("maas", "http://x/v1", "k")
        # 实测：deepseek 认 reasoning_effort（758ms），不认 enable_thinking（3449ms）
        assert ds.no_thinking_body() == {"reasoning_effort": "none"}
        # 实测：maas 的 qwen 认 enable_thinking（743ms）
        assert maas.no_thinking_body() == {"enable_thinking": False}

    def test_没见过的供应商返回空而不是瞎给一个(self):
        """★ 给错参数比不给更糟：deepseek 收到 enable_thinking=false 会静默忽略，
        思维链照跑并吃光 max_tokens，正文变成空的。所以宁可不关。"""
        unknown = OpenAICompatProvider("brand_new", "http://x/v1", "k")
        assert unknown.no_thinking_body() == {}

    def test_返回的是副本_改不坏那张表(self):
        ds = OpenAICompatProvider("deepseek", "http://x/v1", "k")
        got = ds.no_thinking_body()
        got["reasoning_effort"] = "被改坏了"
        assert ds.no_thinking_body() == {"reasoning_effort": "none"}

    async def test_thinking_False_时字段真的进了请求体(self):
        payloads: list[dict] = []
        p = _recorder("deepseek", payloads, _sse(_text("好")))
        async for _ in p.stream(
            [Message(role="user", content="hi")], model="m",
            extra_body=p.no_thinking_body(),
        ):
            pass
        assert payloads[0].get("reasoning_effort") == "none"

    async def test_默认不下发任何关思考字段(self):
        """正文与笔记要留着思考链 —— 那是产品特性（等待期看得见它在想什么）。"""
        payloads: list[dict] = []
        p = _recorder("deepseek", payloads, _sse(_text("好")))
        async for _ in p.stream([Message(role="user", content="hi")], model="m"):
            pass
        assert "reasoning_effort" not in payloads[0]
        assert "enable_thinking" not in payloads[0]


# ── 2. 降级跨供应商时参数名要跟着变 ────────────────────────────
class Test降级跨供应商:
    def test_逐跳重取参数名(self):
        """★ 这是「翻译放在 provider 层」的理由：降级链是 deepseek → maas，
        参数名写死在调用方的话，跳过去之后要么失效、要么反过来吃光额度。"""
        payloads_ds: list[dict] = []
        payloads_maas: list[dict] = []
        # 第一跳报 500（可重试），第二跳成功
        ds = OpenAICompatProvider("deepseek", "http://x/v1", "k")
        ds._client = httpx.AsyncClient(  # type: ignore[assignment]
            transport=httpx.MockTransport(
                lambda req: (
                    payloads_ds.append(json.loads(req.content)),
                    httpx.Response(500, content=b"boom"),
                )[1]
            ),
            base_url="http://x/v1",
        )
        maas = _recorder("maas", payloads_maas, _sse(_text("好")))

        real_resolve, real_chain, real_log, real_budget = (
            router.resolve, router._chain, router._log_call, router.check_budget
        )
        router._chain = lambda *_a, **_kw: ["deepseek:m1", "maas:m2"]  # type: ignore[assignment]
        router.resolve = lambda spec: (  # type: ignore[assignment]
            (ds, "m1") if spec.startswith("deepseek") else (maas, "m2")
        )

        async def noop(*_a, **_kw):
            return None

        router._log_call = noop  # type: ignore[assignment]
        router.check_budget = noop  # type: ignore[assignment]

        async def go():
            async for _ in router.stream_chat(
                [Message(role="user", content="hi")], scene="test", thinking=False
            ):
                pass

        try:
            asyncio.run(go())
        finally:
            (router.resolve, router._chain, router._log_call, router.check_budget) = (
                real_resolve, real_chain, real_log, real_budget
            )

        assert payloads_ds[0].get("reasoning_effort") == "none"
        # 跳到 maas 之后换成它认的那个名字，而不是继续发 deepseek 的
        assert payloads_maas[0].get("enable_thinking") is False
        assert "reasoning_effort" not in payloads_maas[0]


# ── 3. tool_choice：最后一轮的收敛方式 ─────────────────────────
class Test最后一轮的收敛:
    def _rounds(self, max_rounds: int | None) -> list[dict]:
        """跑一遍 tool loop，返回每一轮 _stream_round 收到的关键参数。"""
        seen: list[dict] = []

        async def fake_round(convo, sink, **kw):
            seen.append({"specs": kw.get("specs"), "tool_choice": kw.get("tool_choice")})
            if kw.get("tool_choice") != "none":
                sink["calls"] = [ToolCall(id=f"c{len(seen)}", name="t", arguments="{}")]
                return
            yield StreamChunk(done=True)

        async def fake_run_tool(call, _tools, **_kw):
            return "结果", ToolEvent(phase="result", name=call.name, detail="ok")

        async def noop(*_a, **_kw):
            return None

        real = (router._stream_round, router._run_tool, router.check_budget)
        router._stream_round = fake_round  # type: ignore[assignment]
        router._run_tool = fake_run_tool  # type: ignore[assignment]
        router.check_budget = noop  # type: ignore[assignment]

        async def go():
            async for _ in router.stream_chat(
                [Message(role="user", content="hi")], scene="test",
                tools=[_T()], max_rounds=max_rounds,
            ):
                pass

        try:
            asyncio.run(go())
        finally:
            router._stream_round, router._run_tool, router.check_budget = real  # type: ignore[assignment]
        return seen

    def test_最后一轮是禁用工具而不是不给工具(self):
        """★ 核心回归点。退回 specs=None 的话，还想查的模型没有原生通道，
        就把工具调用当正文吐出来 —— 线上真的发生过，用户看到一串 DSML 标记。"""
        seen = self._rounds(2)
        assert len(seen) == 3
        for r in seen[:-1]:
            assert r["tool_choice"] == "auto"
        last = seen[-1]
        assert last["tool_choice"] == "none"
        # 工具**仍然在请求里**，只是这一轮禁用
        assert last["specs"], "最后一轮不能把 tools 摘掉，那正是泄漏的成因"

    def test_每一轮都带着工具定义(self):
        for r in self._rounds(1):
            assert r["specs"]

    def test_最后一轮就算模型还发调用也不执行(self):
        """没有下一轮去消费结果，执行了就是白花一次调用 + 白等它的耗时。
        这是「最后一轮改成恒传 specs」带来的新边界。"""
        ran = {"n": 0}
        seen = {"n": 0}

        async def fake_round(convo, sink, **kw):
            seen["n"] += 1
            # 故意不听话：即使 tool_choice=none 也发起调用
            sink["calls"] = [ToolCall(id=f"c{seen['n']}", name="t", arguments="{}")]
            if False:  # 让它成为 async generator
                yield StreamChunk()

        async def fake_run_tool(call, _tools, **_kw):
            ran["n"] += 1
            return "结果", ToolEvent(phase="result", name=call.name, detail="ok")

        async def noop(*_a, **_kw):
            return None

        real = (router._stream_round, router._run_tool, router.check_budget)
        router._stream_round = fake_round  # type: ignore[assignment]
        router._run_tool = fake_run_tool  # type: ignore[assignment]
        router.check_budget = noop  # type: ignore[assignment]

        async def go():
            async for _ in router.stream_chat(
                [Message(role="user", content="hi")], scene="test",
                tools=[_T()], max_rounds=1,
            ):
                pass

        try:
            asyncio.run(go())
        finally:
            router._stream_round, router._run_tool, router.check_budget = real  # type: ignore[assignment]

        # 两轮往返（1 轮带工具 + 最后一轮禁用），但工具只在非最后一轮执行
        assert seen["n"] == 2
        assert ran["n"] == 1, "最后一轮的调用必须被忽略"

    async def test_没有工具时压根不设_tool_choice(self):
        payloads: list[dict] = []
        p = _recorder("maas", payloads, _sse(_text("好")))
        async for _ in p.stream([Message(role="user", content="hi")], model="m"):
            pass
        assert "tool_choice" not in payloads[0]
        assert "tools" not in payloads[0]

    async def test_有工具时默认_auto(self):
        """auto 而不是 required：强制每次都调，模型会为了交差硬编一个查询词。"""
        payloads: list[dict] = []
        p = _recorder("maas", payloads, _sse(_text("好")))
        async for _ in p.stream(
            [Message(role="user", content="hi")], model="m",
            tools=[{"type": "function", "function": {"name": "t"}}],
        ):
            pass
        assert payloads[0]["tool_choice"] == "auto"

    async def test_none_能真的发出去(self):
        payloads: list[dict] = []
        p = _recorder("maas", payloads, _sse(_text("好")))
        async for _ in p.stream(
            [Message(role="user", content="hi")], model="m",
            tools=[{"type": "function", "function": {"name": "t"}}],
            tool_choice="none",
        ):
            pass
        assert payloads[0]["tool_choice"] == "none"
        assert payloads[0]["tools"], "禁用不等于摘掉"


# ── 4. 泄漏探测 ────────────────────────────────────────────────
class Test工具标记泄漏探测:
    def test_认出_DeepSeek_的全角竖线(self):
        """⚠️ DSML 用的是全角竖线 U+FF5C，按 ASCII 的 | 去匹配是匹配不到的。"""
        head = '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="search_memory">'
        assert router._tool_leak(head)

    def test_认出其它几家的格式(self):
        for head in (
            "<tool_call>\n{\"name\": \"t\"}",
            "<｜tool▁calls▁begin｜>",
            "<function=search_memory>{}",
        ):
            assert router._tool_leak(head), head

    def test_正常回答不误杀(self):
        for head in (
            "你记的是缩放点积注意力，除以根号 d_k 是为了防止 softmax 饱和。",
            "",
            "   \n\n",
            # 正文里出现尖括号是正常的（比如讲 HTML 或泛型）
            "先看 `<div>` 这个标签的作用。",
            "泛型写成 List<String> 就行。",
        ):
            assert not router._tool_leak(head), head

    def test_只看开头_不扫全文(self):
        """答案正文里提到 `<tool_call>` 这个词不该被当成泄漏 ——
        泄漏的特征是**整段从标记开始**。"""
        head = "顺便说一下，模型有时会输出 <tool_call> 这种东西，那是协议层的标记。"
        assert not router._tool_leak(head)


def _独立运行() -> int:
    import inspect
    import traceback

    ok = bad = 0
    for cls in (
        Test关思考的参数名,
        Test降级跨供应商,
        Test最后一轮的收敛,
        Test工具标记泄漏探测,
    ):
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
    raise SystemExit(_独立运行())
