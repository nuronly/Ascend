"""LLM Provider 抽象层的核心契约（PLAN §4.1）。

业务代码只依赖本模块的类型与 `LLMProvider` 协议，
永远不 import 任何具体供应商的 SDK。这不是过度设计——
它直接决定了能不能做分级路由和降级链。
"""

from __future__ import annotations

import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

Role = Literal["system", "user", "assistant", "tool"]


@dataclass(slots=True)
class ToolCall:
    """模型决定调用某个工具。

    arguments 保留模型给的**原始字符串**而不是解析后的 dict：
    模型偶尔会吐出不合法的 JSON，解析失败该由调用方决定怎么兜
    （通常是把错误回喂给模型让它重来），而不是在这里就炸掉。
    """

    id: str
    name: str
    arguments: str = ""

    def args(self) -> dict[str, Any]:
        """尽力解析参数。拿不到就返回空 dict —— 一个工具参数写坏了
        不该让整场生成失败。"""
        try:
            v = json.loads(self.arguments or "{}")
        except json.JSONDecodeError:
            return {}
        return v if isinstance(v, dict) else {}


@dataclass(slots=True)
class Message:
    role: Role
    content: str = ""
    #  assistant 发起工具调用时带上
    tool_calls: list[ToolCall] = field(default_factory=list)
    #  role="tool" 的回执必须带上它回答的那次调用的 id，否则模型对不上号
    tool_call_id: str = ""

    def as_dict(self) -> dict[str, Any]:
        d: dict[str, Any] = {"role": self.role, "content": self.content}
        if self.tool_calls:
            d["tool_calls"] = [
                {
                    "id": t.id,
                    "type": "function",
                    "function": {"name": t.name, "arguments": t.arguments},
                }
                for t in self.tool_calls
            ]
        if self.tool_call_id:
            d["tool_call_id"] = self.tool_call_id
        return d


@dataclass(slots=True)
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total(self) -> int:
        return self.prompt_tokens + self.completion_tokens


@dataclass(slots=True)
class ToolEvent:
    """工具的生命周期，用来向前端透出「AI 正在做什么」。

    等待期的空白是最劝退的东西 —— 大纲要跑一两分钟，中间还夹着联网检索。
    把「正在搜什么、搜到了什么」实时说出来，等待才是可预期的。
    """

    phase: Literal["call", "result", "error"]
    name: str
    #  一句给人看的话：call 阶段是查询词，result 阶段是简短结论
    detail: str = ""
    #  结构化载荷，前端按需渲染（比如资料列表）
    payload: dict[str, Any] = field(default_factory=dict)
    ms: int = 0


@dataclass(slots=True)
class LLMResult:
    text: str
    usage: Usage = field(default_factory=Usage)
    model: str = ""
    provider: str = ""
    finish_reason: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    raw: dict[str, Any] | None = None


@dataclass(slots=True)
class StreamChunk:
    """流式增量。done=True 的那一条携带最终 usage。

    delta 与 reasoning 严格分离：delta 是正式回答，reasoning 是推理模型
    （如 deepseek-v4-pro）的思维链。思维链只用于向前端透出「正在思考」，
    绝不能拼进正文 —— 否则会污染大纲 JSON / 小节正文。

    tool_calls 由 provider 在流结束时整条给出（流式协议里它是逐字符分片的，
    拼装在 provider 内部完成）；tool_event 则由 router 在 tool loop 里注入，
    provider 不产生它。
    """

    delta: str = ""
    reasoning: str = ""
    done: bool = False
    usage: Usage | None = None
    model: str = ""
    provider: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    tool_event: ToolEvent | None = None


class LLMError(RuntimeError):
    """LLM 调用失败。retryable 决定是否进入退避重试或降级链。"""

    def __init__(
        self,
        message: str,
        *,
        retryable: bool = False,
        status: int | None = None,
        provider: str = "",
        model: str = "",
    ) -> None:
        super().__init__(message)
        self.retryable = retryable
        self.status = status
        self.provider = provider
        self.model = model


class BudgetExceeded(RuntimeError):
    """用户当日 token 预算耗尽（PLAN §4.1 预算闸 / §4.2 成本归属）。"""


@runtime_checkable
class LLMProvider(Protocol):
    name: str

    async def complete(
        self,
        messages: list[Message],
        *,
        model: str,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        json_mode: bool = False,
        tools: list[dict[str, Any]] | None = None,
        timeout: float | None = None,
    ) -> LLMResult: ...

    async def stream(
        self,
        messages: list[Message],
        *,
        model: str,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        json_mode: bool = False,
        tools: list[dict[str, Any]] | None = None,
        timeout: float | None = None,
    ) -> AsyncIterator[StreamChunk]: ...

    async def embed(
        self, texts: list[str], *, model: str, timeout: float | None = None
    ) -> list[list[float]]: ...
