"""工具层。

契约刻意对齐 MCP 的数据模型（name / description / inputSchema / handler）：
将来想把这些工具暴露成 MCP server，或者反过来接入现成的 MCP 工具，
都只是加一个 adapter 的事，不用重构。现在不引入 mcp 运行时 ——
单体部署再多跑一个 server 进程不划算。

同理也没引入 LangChain：它自带一套重试、回调、缓存，会和 llm/router.py
已有的降级链、预算闸、ai_calls 记账正面重叠，最后变成两套记账、
成本数据互相对不上。这里需要的只是「schema + 执行」，200 行以内的事。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from app.core.config import settings


@dataclass(slots=True)
class ToolResult:
    """工具执行结果。

    content 是喂回模型的文本，**必须已经截断**：tool loop 每一轮都会把完整
    历史重发一遍，不控制长度的话 prompt token 会一轮比一轮胖，几轮就撑爆。

    display 是给前端的结构化数据（走 SSE 推给用户），summary 是一句给人看的
    话（"找到 5 篇 · arxiv.org、d2l.ai…"），cost_usd 进 ai_calls 记账 ——
    工具也花钱，成本看板不该有缺口。
    """

    content: str
    display: dict[str, Any] = field(default_factory=dict)
    summary: str = ""
    cost_usd: float = 0.0


@runtime_checkable
class Tool(Protocol):
    name: str
    description: str

    def schema(self) -> dict[str, Any]:
        """参数的 JSON Schema（对应 MCP 的 inputSchema）。"""
        ...

    async def run(self, **kwargs: Any) -> ToolResult: ...


def tool_specs(tools: list[Tool]) -> list[dict[str, Any]]:
    """转成 OpenAI 协议的 tools 参数。"""
    return [
        {
            "type": "function",
            "function": {
                "name": t.name,
                "description": t.description,
                "parameters": t.schema(),
            },
        }
        for t in tools
    ]


def available_tools() -> list[Tool]:
    """当前真正可用的工具。

    没配 key 的工具不进列表 —— 模型看不到它，就不会去调用一个注定失败的
    东西，也就不会为了「我搜一下」而白烧一轮对话。
    """
    from app.llm.tools.search import WebSearch

    out: list[Tool] = []
    if settings.search_enabled and settings.tavily_api_key:
        out.append(WebSearch())
    return out


def get_tool(name: str) -> Tool | None:
    for t in available_tools():
        if t.name == name:
            return t
    return None


__all__ = ["Tool", "ToolResult", "available_tools", "get_tool", "tool_specs"]
