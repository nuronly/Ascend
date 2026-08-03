"""Token 计价（PLAN §4.1：ai_calls 加 cost_usd 字段，直接算钱）。

价格随时会变，这里只做量级估算，用途是让用量看板有个可比的数字，
以及给预算闸做参考。真实账单以供应商为准。
单位：美元 / 1M tokens。
"""

from __future__ import annotations

# (输入价, 输出价)
_PRICES: dict[str, tuple[float, float]] = {
    # 旗舰
    "qwen3.8-max": (1.60, 6.40),
    "qwen3.7-max": (1.60, 6.40),
    "qwen3-max": (1.20, 6.00),
    "deepseek-v4-pro": (0.55, 2.19),
    # 中档
    "qwen3.7-plus": (0.28, 1.12),
    "qwen3.6-plus": (0.28, 1.12),
    "qwen-plus": (0.11, 0.28),
    "deepseek-chat": (0.27, 1.10),
    "deepseek-v4-flash": (0.14, 0.55),
    # 小模型
    "qwen3.7-flash": (0.05, 0.20),
    "qwen3.6-flash": (0.05, 0.20),
    "qwen-flash": (0.02, 0.08),
    "qwen-turbo": (0.02, 0.08),
    # 向量
    "qwen3.7-text-embedding": (0.02, 0.0),
}

_DEFAULT = (0.30, 1.20)


def price_of(model: str) -> tuple[float, float]:
    if model in _PRICES:
        return _PRICES[model]
    # 带日期后缀的变体：qwen3.7-flash-2026-07-15 → qwen3.7-flash
    for known, price in _PRICES.items():
        if model.startswith(known):
            return price
    return _DEFAULT


def estimate_cost(model: str, prompt_tokens: int, completion_tokens: int) -> float:
    pin, pout = price_of(model)
    return round((prompt_tokens * pin + completion_tokens * pout) / 1_000_000, 8)
