"""OpenAI 兼容协议的 Provider 实现。

私有 MaaS 网关与 DeepSeek 官方平台都走这套协议，一份实现即可覆盖。
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

import httpx

from app.core.config import settings
from app.llm.base import LLMError, LLMResult, Message, StreamChunk, ToolCall, Usage

log = logging.getLogger(__name__)

# 这些状态码重试有意义：限流与服务端抖动
_RETRYABLE_STATUS = {408, 409, 425, 429, 500, 502, 503, 504}


class OpenAICompatProvider:
    def __init__(self, name: str, base_url: str, api_key: str) -> None:
        self.name = name
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self._client: httpx.AsyncClient | None = None

    @property
    def available(self) -> bool:
        return bool(self.api_key and self.base_url)

    def _get_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                headers={
                    "Authorization": f"Bearer {self.api_key}",
                    "Content-Type": "application/json",
                },
                timeout=httpx.Timeout(
                    settings.llm_timeout_seconds,
                    connect=15.0,
                    read=settings.llm_timeout_seconds,
                ),
                limits=httpx.Limits(max_connections=32, max_keepalive_connections=16),
            )
        return self._client

    async def aclose(self) -> None:
        if self._client and not self._client.is_closed:
            await self._client.aclose()

    # ── 内部 ──
    def _raise_for(self, resp: httpx.Response, model: str) -> None:
        detail = resp.text[:600]
        raise LLMError(
            f"[{self.name}/{model}] HTTP {resp.status_code}: {detail}",
            retryable=resp.status_code in _RETRYABLE_STATUS,
            status=resp.status_code,
            provider=self.name,
            model=model,
        )

    def _payload(
        self,
        messages: list[Message],
        model: str,
        temperature: float,
        max_tokens: int | None,
        json_mode: bool,
        tools: list[dict[str, Any]] | None = None,
    ) -> dict:
        body: dict = {
            "model": model,
            "messages": [m.as_dict() for m in messages],
            "temperature": temperature,
        }
        if max_tokens:
            body["max_tokens"] = max_tokens
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        if tools:
            body["tools"] = tools
            # auto 而不是 required：让模型自己判断要不要查。
            # 强制它每次都调一遍工具，它就会为了交差硬编一个查询词。
            body["tool_choice"] = "auto"
        return body

    @staticmethod
    def _parse_calls(raw: list[dict] | None) -> list[ToolCall]:
        out: list[ToolCall] = []
        for c in raw or []:
            fn = c.get("function") or {}
            out.append(
                ToolCall(
                    id=str(c.get("id") or ""),
                    name=str(fn.get("name") or ""),
                    arguments=str(fn.get("arguments") or ""),
                )
            )
        return out

    # ── 非流式 ──
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
    ) -> LLMResult:
        body = self._payload(messages, model, temperature, max_tokens, json_mode, tools)
        try:
            resp = await self._get_client().post(
                "/chat/completions", json=body, timeout=timeout or settings.llm_timeout_seconds
            )
        except httpx.TimeoutException as exc:
            raise LLMError(
                f"[{self.name}/{model}] 请求超时", retryable=True, provider=self.name, model=model
            ) from exc
        except httpx.HTTPError as exc:
            raise LLMError(
                f"[{self.name}/{model}] 网络错误: {exc}",
                retryable=True,
                provider=self.name,
                model=model,
            ) from exc

        if resp.status_code >= 400:
            self._raise_for(resp, model)

        data = resp.json()
        choice = (data.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        usage_raw = data.get("usage") or {}
        return LLMResult(
            # 发起工具调用时 content 是空字符串，这是正常的，不是失败
            text=msg.get("content") or "",
            usage=Usage(
                prompt_tokens=usage_raw.get("prompt_tokens", 0),
                completion_tokens=usage_raw.get("completion_tokens", 0),
            ),
            model=data.get("model") or model,
            provider=self.name,
            finish_reason=choice.get("finish_reason") or "",
            tool_calls=self._parse_calls(msg.get("tool_calls")),
            raw=data,
        )

    # ── 流式 ──
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
    ) -> AsyncIterator[StreamChunk]:
        body = self._payload(messages, model, temperature, max_tokens, json_mode, tools)
        body["stream"] = True
        # 有些兼容网关默认不回 usage，显式索要
        body["stream_options"] = {"include_usage": True}

        usage = Usage()
        actual_model = model
        client = self._get_client()
        # 流式协议里 tool_calls 是逐字符分片的：首片带 id 与函数名，
        # 后续片只带 index 和 arguments 的一小段，要按 index 自己拼回去。
        # 而且模型可以并行发起多个调用（实测同一次响应里出现过 index 0 和 1）。
        tool_acc: dict[int, dict[str, str]] = {}

        # 流式场景用「首 token 超时」而非总超时（PLAN §4.1）：
        # 长文生成的总时长本来就长，用总超时会误杀正常请求。
        read_timeout = timeout or settings.llm_timeout_seconds
        tmo = httpx.Timeout(read_timeout, connect=15.0, read=settings.llm_first_token_timeout)

        try:
            async with client.stream(
                "POST", "/chat/completions", json=body, timeout=tmo
            ) as resp:
                if resp.status_code >= 400:
                    await resp.aread()
                    self._raise_for(resp, model)

                first_token_seen = False
                finish_reason = ""
                async for line in resp.aiter_lines():
                    if not line or not line.startswith("data:"):
                        continue
                    payload = line[5:].strip()
                    if payload == "[DONE]":
                        break
                    try:
                        chunk = json.loads(payload)
                    except json.JSONDecodeError:
                        continue

                    if chunk.get("model"):
                        actual_model = chunk["model"]
                    if u := chunk.get("usage"):
                        usage = Usage(
                            prompt_tokens=u.get("prompt_tokens", 0),
                            completion_tokens=u.get("completion_tokens", 0),
                        )

                    for ch in chunk.get("choices") or []:
                        if ch.get("finish_reason"):
                            finish_reason = ch["finish_reason"]
                        d = ch.get("delta") or {}
                        # 推理模型的思维链：独立透出，绝不混入 delta（正文）
                        if reasoning := d.get("reasoning_content"):
                            yield StreamChunk(
                                reasoning=reasoning, model=actual_model, provider=self.name
                            )
                        for tc in d.get("tool_calls") or []:
                            slot = tool_acc.setdefault(
                                int(tc.get("index") or 0),
                                {"id": "", "name": "", "arguments": ""},
                            )
                            if tc.get("id"):
                                slot["id"] = str(tc["id"])
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] = str(fn["name"])
                            if fn.get("arguments"):
                                slot["arguments"] += str(fn["arguments"])
                        if delta := d.get("content"):
                            if not first_token_seen:
                                first_token_seen = True
                                # 首 token 已到，放宽读超时给后续内容
                                resp.request.extensions["timeout"] = {"read": read_timeout}
                            yield StreamChunk(
                                delta=delta, model=actual_model, provider=self.name
                            )

                # 思维链把 max_tokens 吃光会导致正文零产出（finish_reason=length），
                # 留个日志，下次不用猜
                if finish_reason == "length":
                    log.warning(
                        "[%s/%s] 输出被 max_tokens 截断（finish_reason=length）", self.name, model
                    )

                # 工具调用拼装完成后整条给出。放在 done 之前，
                # 让 router 的 tool loop 先拿到它再决定要不要继续
                if tool_acc:
                    yield StreamChunk(
                        tool_calls=[
                            ToolCall(id=s["id"], name=s["name"], arguments=s["arguments"])
                            for _, s in sorted(tool_acc.items())
                        ],
                        model=actual_model,
                        provider=self.name,
                    )
        except httpx.TimeoutException as exc:
            raise LLMError(
                f"[{self.name}/{model}] 流式超时", retryable=True, provider=self.name, model=model
            ) from exc
        except httpx.HTTPError as exc:
            raise LLMError(
                f"[{self.name}/{model}] 流式网络错误: {exc}",
                retryable=True,
                provider=self.name,
                model=model,
            ) from exc

        yield StreamChunk(done=True, usage=usage, model=actual_model, provider=self.name)

    # ── 向量 ──
    async def embed(
        self, texts: list[str], *, model: str, timeout: float | None = None
    ) -> list[list[float]]:
        if not texts:
            return []
        try:
            resp = await self._get_client().post(
                "/embeddings",
                json={"model": model, "input": texts},
                timeout=timeout or settings.llm_timeout_seconds,
            )
        except httpx.HTTPError as exc:
            raise LLMError(
                f"[{self.name}/{model}] embedding 网络错误: {exc}",
                retryable=True,
                provider=self.name,
                model=model,
            ) from exc

        if resp.status_code >= 400:
            self._raise_for(resp, model)

        data = resp.json()
        items = sorted(data.get("data") or [], key=lambda d: d.get("index", 0))
        return [it["embedding"] for it in items]
