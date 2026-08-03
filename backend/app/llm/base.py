"""LLM Provider 抽象层的核心契约（PLAN §4.1）。

业务代码只依赖本模块的类型与 `LLMProvider` 协议，
永远不 import 任何具体供应商的 SDK。这不是过度设计——
它直接决定了能不能做分级路由和降级链。
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any, Literal, Protocol, runtime_checkable

Role = Literal["system", "user", "assistant"]


@dataclass(slots=True)
class Message:
    role: Role
    content: str

    def as_dict(self) -> dict[str, str]:
        return {"role": self.role, "content": self.content}


@dataclass(slots=True)
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0

    @property
    def total(self) -> int:
        return self.prompt_tokens + self.completion_tokens


@dataclass(slots=True)
class LLMResult:
    text: str
    usage: Usage = field(default_factory=Usage)
    model: str = ""
    provider: str = ""
    finish_reason: str = ""
    raw: dict[str, Any] | None = None


@dataclass(slots=True)
class StreamChunk:
    """流式增量。done=True 的那一条携带最终 usage。"""

    delta: str = ""
    done: bool = False
    usage: Usage | None = None
    model: str = ""
    provider: str = ""


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
        timeout: float | None = None,
    ) -> LLMResult: ...

    async def stream(
        self,
        messages: list[Message],
        *,
        model: str,
        temperature: float = 0.7,
        max_tokens: int | None = None,
        timeout: float | None = None,
    ) -> AsyncIterator[StreamChunk]: ...

    async def embed(
        self, texts: list[str], *, model: str, timeout: float | None = None
    ) -> list[list[float]]: ...
