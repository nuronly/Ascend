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
from app.llm.base import LLMError, Message, StreamChunk, ToolCall, ToolEvent  # noqa: E402
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


# ── 4. 泄漏探测与拦截 ──────────────────────────────────────────
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

    def test_弱特征只认开头(self):
        """讲 function calling 的课，正文里就会拿 <tool_call> 当例子 ——
        中间出现不算泄漏，否则会把正常讲解掐掉。"""
        assert not router._tool_leak("模型有时会输出 <tool_call> 这种东西，那是协议标记。")

    def test_强特征任何位置都算(self):
        """★ 线上真实漏检的那一次：模型**先输出了一个列表序号**再吐标记，
        于是「开头必须是尖括号」这个判据完全不成立，一条日志都没记下来。"""
        body = "1\n解释注意力机制为何被引入以解决长程依赖问题\n<｜｜DSML｜｜tool_calls>"
        assert router._tool_leak(body) == "<\uff5c"


class Test泄漏闸门:
    """流式拦截。要点是必须在**推给用户之前**掐掉 —— 事后告警来不及。"""

    def test_正常内容原样放行_一个字不丢(self):
        gate = router._LeakGate()
        src = "你记的是缩放点积注意力，除以根号 d_k 是为了防止内积过大让 softmax 饱和。"
        out = "".join(gate.feed(c) for c in src) + gate.flush()
        assert out == src
        assert not gate.tripped

    def test_flush_必须调_否则吃掉尾部(self):
        """尾部留了窗口防标记跨片，不 flush 就真的丢了。"""
        gate = router._LeakGate()
        src = "短短一句话"
        assert gate.feed(src) == ""  # 还在窗口里，一个字都没放行
        assert gate.flush() == src

    def test_掐断标记及其后面_保住前半段(self):
        gate = router._LeakGate()
        good = "你关于注意力学过这些：\n1. 缩放点积注意力。\n"
        bad = '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="read_note">'
        out = gate.feed(good + bad) + gate.flush()
        assert out == good, "标记之前的内容是模型正经说的话，不该丢"
        assert gate.tripped
        assert gate.hit == "<\uff5c"

    def test_标记跨_chunk_分片也要检出(self):
        """★ 标记是逐 token 来的：`<`、`｜`、`｜DSML` 各自一片
        （和流式 tool_calls 的分片累积同一个道理）。
        不留尾部窗口的话跨边界就漏检 —— 这种漏检是概率性的，最难查。"""
        gate = router._LeakGate()
        pieces = ["答案正文。", "<", "\uff5c", "\uff5cDSML", "\uff5c\uff5ctool_calls>"]
        out = "".join(gate.feed(p) for p in pieces) + gate.flush()
        assert gate.tripped
        assert out == "答案正文。"

    def test_掐断之后不再放行任何内容(self):
        gate = router._LeakGate()
        gate.feed("正文<\uff5c\uff5cDSML\uff5c\uff5ctool_calls>")
        assert gate.feed("后面还有一堆草稿") == ""
        assert gate.flush() == ""

    def test_长正文不会卡在窗口里(self):
        """窗口只留尾部，前面的必须持续往外流 —— 否则就不是流式了。"""
        gate = router._LeakGate()
        got = "".join(gate.feed("一" * 30) for _ in range(4))
        assert len(got) >= 90, "正文应当边生成边放行，只滞后一个窗口"
        assert (got + gate.flush()) == "一" * 120

    def test_弱特征在开头才掐(self):
        gate = router._LeakGate()
        src = "讲一下 <tool_call> 这个标记的作用。"
        assert (gate.feed(src) + gate.flush()) == src
        assert not gate.tripped

        gate2 = router._LeakGate()
        gate2.feed('<tool_call>{"name":"t"}')
        assert gate2.tripped


# ── 5. 闸门在 stream_chat 里的接线 ─────────────────────────────
_GOOD = "你关于注意力学过这些：缩放点积注意力，除以根号 d_k 防止 softmax 饱和。"
_BAD = '<\uff5c\uff5cDSML\uff5c\uff5ctool_calls><\uff5c\uff5cDSML\uff5c\uff5cinvoke name="read_note">'


class Test闸门的接线:
    """闸门本身对了，接线仍可能错 —— 而且错法是**静默少字**。

    两条收尾路径必须都覆盖：
      A 正常收尾会发 done → 尾部窗口靠 done 之前那次 flush
      B 去调工具的那一轮 _stream_round 直接 return，**不发 done**
        → 尾部只能靠轮末那次 flush。漏了的话每轮末尾静默少 24 个字，
          而且只在带工具的场景出现，肉眼几乎发现不了
    """

    def _run(self, script: list[list[StreamChunk]], with_tools: bool) -> str:
        it = iter(script)
        self.trips = 0  # 模型往返次数，用来确认「没白多跑一轮」

        async def fake_round(convo, sink, **kw):
            self.trips += 1
            try:
                chunks = next(it)
            except StopIteration:
                yield StreamChunk(done=True)
                return
            for c in chunks:
                if c.tool_calls:
                    sink["calls"] = c.tool_calls
                    return  # ★ 照做真身：去调工具的那一轮不发 done
                yield c

        async def fake_run_tool(call, _tools, **_kw):
            return "工具结果", ToolEvent(phase="result", name=call.name, detail="ok")

        async def noop(*_a, **_kw):
            return None

        real = (router._stream_round, router._run_tool, router.check_budget)
        router._stream_round = fake_round  # type: ignore[assignment]
        router._run_tool = fake_run_tool  # type: ignore[assignment]
        router.check_budget = noop  # type: ignore[assignment]

        async def go() -> str:
            out = ""
            async for ch in router.stream_chat(
                [Message(role="user", content="hi")],
                scene="verify",
                tools=[_T()] if with_tools else None,
                max_rounds=1,
            ):
                out += ch.delta
            return out

        try:
            return asyncio.run(go())
        finally:
            router._stream_round, router._run_tool, router.check_budget = real  # type: ignore[assignment]

    def test_A_正常收尾一个字不丢(self):
        got = self._run([[StreamChunk(delta=_GOOD), StreamChunk(done=True)]], False)
        assert got == _GOOD

    def test_A_逐字流式一个字不丢(self):
        got = self._run(
            [[*(StreamChunk(delta=c) for c in _GOOD), StreamChunk(done=True)]], False
        )
        assert got == _GOOD

    def test_B_调工具那一轮的尾部不能被吃掉(self):
        """★ 这一轮不发 done，尾部只能靠轮末 flush。回归了就每轮少 24 个字。"""
        got = self._run(
            [
                [
                    StreamChunk(delta="先想一下。"),
                    StreamChunk(tool_calls=[ToolCall(id="c1", name="t", arguments="{}")]),
                ],
                [StreamChunk(delta=_GOOD), StreamChunk(done=True)],
            ],
            True,
        )
        assert got == "先想一下。" + _GOOD

    def test_掐断泄漏保住前半段(self):
        got = self._run(
            [[StreamChunk(delta=_GOOD), StreamChunk(delta=_BAD), StreamChunk(done=True)]],
            False,
        )
        assert got == _GOOD

    def test_标记跨_chunk_分片也掐得住(self):
        got = self._run(
            [[
                StreamChunk(delta=_GOOD),
                *(StreamChunk(delta=p)
                  for p in ("<", "\uff5c", "\uff5cDSML", "\uff5c\uff5ctool_calls>")),
                StreamChunk(done=True),
            ]],
            False,
        )
        assert got == _GOOD

    def test_线上那个形状_正文中间开始泄漏(self):
        """模型先输出一个列表序号再吐标记 —— 老判据（开头必须是尖括号）
        对这个形状完全失效，既没拦住也没告警。"""
        shape = "1\n解释注意力机制为何被引入以解决长程依赖问题\n"
        got = self._run([[StreamChunk(delta=shape + _BAD), StreamChunk(done=True)]], False)
        assert got == shape
        assert self.trips == 1, "还有正文放行过，就不该白花一轮去补救"


class Test泄漏把正文吃光时的补救:
    """★ 空白比乱码更糟。

    线上撞到的形状：最后一轮（tool_choice=none）模型仍然想读 5 份笔记，
    于是整整 195 字**全是** DSML —— 掐完一个字都不剩。事件流长这样：
    43 个 thinking、10 个 tool_call、1 个 done、**0 个 delta**。
    用户看到引用卡片下面一片空白，只会以为产品坏了。

    「掐断能保住前半段」这句话在前半段为空时不成立 —— 我原先只在注释里
    写了它就把这个边界放过去了。
    """

    def _run(self, script: list[list[StreamChunk]]) -> tuple[str, int]:
        it = iter(script)
        trips = {"n": 0}
        seen_specs: list[bool] = []

        async def fake_round(convo, sink, **kw):
            trips["n"] += 1
            seen_specs.append(bool(kw.get("specs")))
            try:
                chunks = next(it)
            except StopIteration:
                yield StreamChunk(done=True)
                return
            for c in chunks:
                if c.tool_calls:
                    sink["calls"] = c.tool_calls
                    return
                yield c

        async def noop(*_a, **_kw):
            return None

        real = (router._stream_round, router.check_budget)
        router._stream_round = fake_round  # type: ignore[assignment]
        router.check_budget = noop  # type: ignore[assignment]

        async def go() -> str:
            out = ""
            async for ch in router.stream_chat(
                [Message(role="user", content="hi")], scene="verify", tools=[_T()],
                max_rounds=1,
            ):
                out += ch.delta
            return out

        try:
            got = asyncio.run(go())
        finally:
            router._stream_round, router.check_budget = real  # type: ignore[assignment]
        self.specs = seen_specs
        return got, trips["n"]

    def test_掐光之后追加一轮_用户拿到回答(self):
        got, trips = self._run([
            [StreamChunk(delta=_BAD), StreamChunk(done=True)],          # 整段泄漏
            [StreamChunk(delta="你有 5 份笔记。"), StreamChunk(done=True)],  # 补救轮
        ])
        assert got == "你有 5 份笔记。"
        assert trips == 2

    def test_补救轮连工具定义都不给(self):
        """比 tool_choice=none 更硬一档：连「工具存在」都不告诉它。
        none 只是「请别用」，而它刚刚已经证明自己不听。"""
        self._run([
            [StreamChunk(delta=_BAD), StreamChunk(done=True)],
            [StreamChunk(delta="回答。"), StreamChunk(done=True)],
        ])
        assert self.specs == [True, False]

    def test_补救轮也收不住就报错_不给空白(self):
        """用户看到「出错了」至少知道发生了什么；看到空白只会以为产品坏了。"""
        try:
            self._run([
                [StreamChunk(delta=_BAD), StreamChunk(done=True)],
                [StreamChunk(delta=_BAD), StreamChunk(done=True)],
            ])
        except LLMError as exc:
            assert "无法收敛" in str(exc)
        else:
            raise AssertionError("补救轮也空的时候必须报错，不能静默返回空回答")

    def test_还想调工具时走原来的忽略路径_不触发补救(self):
        """最后一轮发的是**原生** tool_calls（不是文本泄漏）—— 那条路已经有
        「忽略并收尾」的处理，不该被补救逻辑抢走。"""
        got, trips = self._run([
            [StreamChunk(delta="先说一句。"),
             StreamChunk(tool_calls=[ToolCall(id="c1", name="t", arguments="{}")])],
            [StreamChunk(tool_calls=[ToolCall(id="c2", name="t", arguments="{}")])],
        ])
        assert got == "先说一句。"
        assert trips == 2, "两轮跑完就该收尾，不追加补救轮"


class Test结束信号必须最后发:
    """★ 这一条守的是让上面所有补救逻辑**整体失效**的那个错。

    下游一律这么消费：

        async for chunk in stream_chat(...):
            if chunk.done:
                break

    而 `break` 会 aclose() 这个 async generator —— 于是 stream_chat 里
    写在 `yield done` **之后**的代码一行都不会执行。

    我就是这么栽的：闸门确实把泄漏拦住了（320 字全掐掉），但 log.error 没打、
    补救没触发，用户拿到一片空白，而且**日志里一条记录都没有** ——
    查的时候先怀疑日志没落盘、再怀疑 logger 没配 handler、又怀疑 max_tokens
    被吃光，绕了三圈才发现是「收尾写在了通知结束之后」。

    所以这里刻意用**真实消费者的姿势**测（见 done 就 break），
    而不是把 chunk 全收下来 —— 后者恰好测不出这个错。
    """

    def _consume_like_downstream(self, script: list[list[StreamChunk]]) -> str:
        """照 brain.answer_stream 的样子消费：见 done 就 break。"""
        it = iter(script)

        async def fake_round(convo, sink, **kw):
            try:
                chunks = next(it)
            except StopIteration:
                yield StreamChunk(done=True)
                return
            for c in chunks:
                if c.tool_calls:
                    sink["calls"] = c.tool_calls
                    return
                yield c

        async def noop(*_a, **_kw):
            return None

        real = (router._stream_round, router.check_budget)
        router._stream_round = fake_round  # type: ignore[assignment]
        router.check_budget = noop  # type: ignore[assignment]

        async def go() -> str:
            out = ""
            async for ch in router.stream_chat(
                [Message(role="user", content="hi")], scene="verify",
                tools=[_T()], max_rounds=1,
            ):
                if ch.done:
                    break  # ★ 真实下游就是这么写的
                out += ch.delta
            return out

        try:
            return asyncio.run(go())
        finally:
            router._stream_round, router.check_budget = real  # type: ignore[assignment]

    def test_下游见_done_就_break_时补救仍然生效(self):
        """把 done 当场 yield 的那一版，这里会拿到空字符串。"""
        got = self._consume_like_downstream([
            [StreamChunk(delta=_BAD), StreamChunk(done=True)],
            [StreamChunk(delta="补救之后的回答。"), StreamChunk(done=True)],
        ])
        assert got == "补救之后的回答。", "done 被提前 yield，补救逻辑就被 break 掉了"

    def test_下游见_done_就_break_时正常回答也完整(self):
        """扣住 done 不能反过来把正常路径的尾部弄丢。"""
        got = self._consume_like_downstream([
            [StreamChunk(delta=_GOOD), StreamChunk(done=True)],
        ])
        assert got == _GOOD

    def test_done_是最后一个_chunk(self):
        """全收下来的姿势：done 之后不该再有任何东西。"""
        it = iter([
            [StreamChunk(delta=_BAD), StreamChunk(done=True)],
            [StreamChunk(delta="补救。"), StreamChunk(done=True)],
        ])

        async def fake_round(convo, sink, **kw):
            try:
                chunks = next(it)
            except StopIteration:
                yield StreamChunk(done=True)
                return
            for c in chunks:
                yield c

        async def noop(*_a, **_kw):
            return None

        real = (router._stream_round, router.check_budget)
        router._stream_round = fake_round  # type: ignore[assignment]
        router.check_budget = noop  # type: ignore[assignment]

        async def go() -> list[StreamChunk]:
            return [
                ch
                async for ch in router.stream_chat(
                    [Message(role="user", content="hi")], scene="verify",
                    tools=[_T()], max_rounds=1,
                )
            ]

        try:
            got = asyncio.run(go())
        finally:
            router._stream_round, router.check_budget = real  # type: ignore[assignment]

        dones = [i for i, c in enumerate(got) if c.done]
        assert dones, "总得有一个结束信号"
        assert dones[-1] == len(got) - 1, "done 之后还有 chunk —— 下游会漏掉它们"
        assert "".join(c.delta for c in got) == "补救。"


def _独立运行() -> int:
    import inspect
    import traceback

    ok = bad = 0
    for cls in (
        Test关思考的参数名,
        Test降级跨供应商,
        Test最后一轮的收敛,
        Test工具标记泄漏探测,
        Test泄漏闸门,
        Test闸门的接线,
        Test泄漏把正文吃光时的补救,
        Test结束信号必须最后发,
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
