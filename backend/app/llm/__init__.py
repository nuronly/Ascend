"""LLM 层。业务代码只从这里 import，不碰具体供应商实现。"""

from app.llm.base import (
    BudgetExceeded,
    LLMError,
    LLMResult,
    Message,
    StreamChunk,
    Usage,
)
from app.llm.router import (
    JsonArrayStream,
    ThinkingBuffer,
    chat,
    chat_json,
    check_budget,
    embed,
    extract_json,
    repair_truncated_json,
    stream_chat,
    usage_today,
)

__all__ = [
    "BudgetExceeded",
    "JsonArrayStream",
    "LLMError",
    "LLMResult",
    "Message",
    "StreamChunk",
    "ThinkingBuffer",
    "Usage",
    "chat",
    "chat_json",
    "check_budget",
    "embed",
    "extract_json",
    "repair_truncated_json",
    "stream_chat",
    "usage_today",
]
