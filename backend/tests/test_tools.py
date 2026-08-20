"""工具调用链路。

最容易静默出错的是**流式 tool_calls 的分片累积**：协议里首片带 id 与函数名，
后续片只带 index 和 arguments 的一小段（实测是逐 token 的，`{`、`"`、`city`
各自一片），而且模型可以并行发起多个调用。拼错的表现不是报错，
而是「参数变成一段截断的 JSON」——工具收到空参数，静默什么都没查到。

其次是**失败路径**：搜索挂了必须让模型基于已有知识继续，而不是让整场生成
崩掉，更不能让它编一个来源出来。学习场景里编造来源比不给来源糟得多。

没装 pytest 也能跑：python tests/test_tools.py
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

from app.llm.base import Message, ToolCall  # noqa: E402
from app.llm.openai_compat import OpenAICompatProvider  # noqa: E402
from app.llm.tools import ToolResult, tool_specs  # noqa: E402
from app.llm.tools.search import WebSearch, _rank, authority, resource_kind  # noqa: E402


def _sse(*chunks: dict) -> bytes:
    body = "".join(f"data: {json.dumps(c, ensure_ascii=False)}\n\n" for c in chunks)
    return (body + "data: [DONE]\n\n").encode()


def _provider(payload: bytes) -> OpenAICompatProvider:
    p = OpenAICompatProvider("test", "http://x/v1", "k")
    p._client = httpx.AsyncClient(  # type: ignore[assignment]
        transport=httpx.MockTransport(lambda _req: httpx.Response(200, content=payload)),
        base_url="http://x/v1",
    )
    return p


async def _collect(p: OpenAICompatProvider):
    return [c async for c in p.stream([Message(role="user", content="hi")], model="m")]


def _delta(tool_calls: list[dict], finish: str | None = None) -> dict:
    ch: dict = {"index": 0, "delta": {"tool_calls": tool_calls}}
    if finish:
        ch["finish_reason"] = finish
    return {"choices": [ch]}


class Test流式工具调用的分片累积:
    async def test_逐片拼回完整的参数(self):
        p = _provider(
            _sse(
                _delta([{"index": 0, "id": "call_1", "type": "function",
                         "function": {"name": "web_search", "arguments": ""}}]),
                _delta([{"index": 0, "function": {"arguments": '{"qu'}}]),
                _delta([{"index": 0, "function": {"arguments": 'ery": "注意力'}}]),
                _delta([{"index": 0, "function": {"arguments": '机制"}'}}]),
                _delta([], "tool_calls"),
            )
        )
        calls = [c for c in await _collect(p) if c.tool_calls]
        assert len(calls) == 1
        got = calls[0].tool_calls
        assert len(got) == 1
        assert got[0].id == "call_1"
        assert got[0].name == "web_search"
        # 拼错的典型表现就是这里拿到一段截断的 JSON，args() 静默变成 {}
        assert got[0].args() == {"query": "注意力机制"}

    async def test_并行的多个调用按_index_分开拼(self):
        p = _provider(
            _sse(
                _delta([{"index": 0, "id": "c0", "type": "function",
                         "function": {"name": "web_search", "arguments": ""}}]),
                _delta([{"index": 0, "function": {"arguments": '{"query":"a"}'}}]),
                _delta([{"index": 1, "id": "c1", "type": "function",
                         "function": {"name": "web_search", "arguments": ""}}]),
                _delta([{"index": 1, "function": {"arguments": '{"query":"b"}'}}]),
                _delta([], "tool_calls"),
            )
        )
        got = [c for c in await _collect(p) if c.tool_calls][0].tool_calls
        assert [g.id for g in got] == ["c0", "c1"]
        assert [g.args()["query"] for g in got] == ["a", "b"]

    async def test_没有工具调用时不产生额外的_chunk(self):
        p = _provider({"choices": [{"delta": {"content": "正文"}}]} and _sse(
            {"choices": [{"delta": {"content": "正文"}}]},
            {"choices": [{"delta": {}, "finish_reason": "stop"}]},
        ))
        chunks = await _collect(p)
        assert not any(c.tool_calls for c in chunks)
        assert "".join(c.delta for c in chunks) == "正文"

    async def test_思维链不混进正文(self):
        p = _provider(
            _sse(
                {"choices": [{"delta": {"reasoning_content": "先想想"}}]},
                {"choices": [{"delta": {"content": "答案"}}]},
                {"choices": [{"delta": {}, "finish_reason": "stop"}]},
            )
        )
        chunks = await _collect(p)
        assert "".join(c.delta for c in chunks) == "答案"
        assert "".join(c.reasoning for c in chunks) == "先想想"


class Test参数容错:
    def test_不合法的_json_返回空字典而不是抛错(self):
        # 一个参数写坏了不该让整场生成失败
        assert ToolCall(id="1", name="t", arguments='{"a": ').args() == {}

    def test_非对象的_json_也当空处理(self):
        assert ToolCall(id="1", name="t", arguments="[1,2]").args() == {}

    def test_空参数(self):
        assert ToolCall(id="1", name="t").args() == {}

    def test_消息序列化带上工具调用与回执(self):
        m = Message(
            role="assistant",
            content="",
            tool_calls=[ToolCall(id="c1", name="web_search", arguments='{"query":"x"}')],
        )
        d = m.as_dict()
        assert d["tool_calls"][0]["function"]["name"] == "web_search"
        assert d["tool_calls"][0]["type"] == "function"
        # 回执必须带 tool_call_id，否则模型对不上是哪次调用
        r = Message(role="tool", content="结果", tool_call_id="c1").as_dict()
        assert r["tool_call_id"] == "c1"
        assert "tool_calls" not in r


class Test来源判定:
    def test_一手来源判为权威(self):
        for u in (
            "https://arxiv.org/abs/1706.03762",
            "https://docs.python.org/3/library/asyncio.html",
            "https://ocw.mit.edu/courses/x",
            "https://www.nature.com/articles/x",
            "https://cs.stanford.edu/notes",  # .edu 后缀
        ):
            assert authority(u) == 2, u

    def test_二手但稳定的判为可信(self):
        assert authority("https://en.wikipedia.org/wiki/Attention") == 1
        assert authority("https://stackoverflow.com/questions/1") == 1

    def test_普通站点不加权(self):
        assert authority("https://some-content-farm.xyz/p/1") == 0

    def test_类型判定(self):
        assert resource_kind("https://arxiv.org/abs/1") == "paper"
        assert resource_kind("https://www.bilibili.com/video/BV1") == "video"
        assert resource_kind("https://docs.rs/serde") == "doc"
        assert resource_kind("https://blog.example.com/post") == "article"

    def test_权威来源排在前面(self):
        ranked = _rank(
            [
                {"url": "https://farm.xyz/a", "title": "农场", "content": "x", "score": 0.99},
                {"url": "https://arxiv.org/abs/1", "title": "论文", "content": "y", "score": 0.10},
            ],
            5,
        )
        # 相关性再高也压不过一手来源：学习场景里来源可靠性优先
        assert ranked[0]["source"] == "arxiv.org"
        assert ranked[0]["authority"] == 2
        assert ranked[1]["authority"] == 0


class Test搜索失败不拖垮生成:
    async def test_网络错误时返回提示而不是抛异常(self):
        from app.core.config import settings

        old = settings.tavily_api_key
        settings.tavily_api_key = "k"  # 让它走到真正的请求
        try:
            # 没有 mock，请求会直接失败（DNS/网络），正好验证兜底
            r = await WebSearch().run(query="__不存在的查询__", kind="any")
        finally:
            settings.tavily_api_key = old
        assert isinstance(r, ToolResult)
        # 必须明确告诉模型「别编造」，否则它会自己造一个 url 出来
        assert "不要编造" in r.content

    async def test_空检索词直接短路(self):
        r = await WebSearch().run(query="   ")
        assert "检索词为空" in r.summary


class Test工具描述:
    def test_转成_openai_tools_参数(self):
        specs = tool_specs([WebSearch()])
        assert specs[0]["type"] == "function"
        fn = specs[0]["function"]
        assert fn["name"] == "web_search"
        assert "query" in fn["parameters"]["properties"]
        assert fn["parameters"]["required"] == ["query"]
        # 描述里必须说清「不要为了搜而搜」，否则它每次都会调一遍
        assert "只在确实需要" in fn["description"]


def _独立运行() -> int:
    import inspect
    import traceback

    ok = bad = 0
    for cls in (
        Test流式工具调用的分片累积,
        Test参数容错,
        Test来源判定,
        Test搜索失败不拖垮生成,
        Test工具描述,
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
    sys.exit(_独立运行())
