"""Provider 注册表与 "provider:model" 规格解析。"""

from __future__ import annotations

import logging
from functools import lru_cache

from app.core.config import settings
from app.llm.base import LLMError
from app.llm.openai_compat import OpenAICompatProvider

log = logging.getLogger(__name__)


@lru_cache
def _providers() -> dict[str, OpenAICompatProvider]:
    reg: dict[str, OpenAICompatProvider] = {}
    if settings.maas_api_key and settings.maas_base_url:
        reg["maas"] = OpenAICompatProvider("maas", settings.maas_base_url, settings.maas_api_key)
    if settings.deepseek_api_key:
        reg["deepseek"] = OpenAICompatProvider(
            "deepseek", settings.deepseek_base_url.rstrip("/") + "/v1", settings.deepseek_api_key
        )
    if not reg:
        log.warning("未配置任何 LLM Provider，AI 功能将不可用。请检查 backend/.env")
    return reg


def parse_spec(spec: str) -> tuple[str, str]:
    """`"maas:qwen3.8-max"` → `("maas", "qwen3.8-max")`。

    省略 provider 前缀时落到第一个可用 provider。
    注意模型名本身可能含冒号（如 `kimi/kimi-k3`），所以只 split 第一个。
    """
    spec = spec.strip()
    if ":" in spec:
        provider, model = spec.split(":", 1)
        provider = provider.strip()
        if provider in _providers():
            return provider, model.strip()
    available = list(_providers())
    if not available:
        raise LLMError("没有可用的 LLM Provider，请在 backend/.env 配置 API key")
    return available[0], spec


def get_provider(name: str) -> OpenAICompatProvider:
    reg = _providers()
    if name not in reg:
        raise LLMError(f"Provider `{name}` 未配置")
    return reg[name]


def resolve(spec: str) -> tuple[OpenAICompatProvider, str]:
    provider_name, model = parse_spec(spec)
    return get_provider(provider_name), model


def available_providers() -> list[str]:
    return list(_providers())


async def close_all() -> None:
    for p in _providers().values():
        await p.aclose()
