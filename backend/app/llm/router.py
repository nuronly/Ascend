"""LLM 路由器 —— 业务层调用 AI 的唯一入口。

把 PLAN §4.1 要求的全部工程防护收敛在这一层，业务代码不必重复实现：

  分级路由 · 指数退避重试 · 多供应商降级链 · 内容 hash 缓存
  · ai_calls 成本日志 · 每用户每日预算闸 · 流式首 token 超时

业务侧只需说明「这是什么场景、要哪个档位」，其余全部由本模块负责。
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import random
import re
import time
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any

from sqlalchemy import Integer, func, select

from app.core.config import (
    TIER_EMBEDDING,
    TIER_FLAGSHIP,
    TIER_SMALL,
    TIER_STANDARD,
    settings,
)
from app.core.db import SessionLocal
from app.core.types import new_id, utcnow
from app.llm.base import (
    BudgetExceeded,
    LLMError,
    LLMResult,
    Message,
    StreamChunk,
    Usage,
)
from app.llm.pricing import estimate_cost
from app.llm.registry import resolve
from app.models.system import AICall, LLMCache

log = logging.getLogger(__name__)

_TIER_SPEC = {
    TIER_FLAGSHIP: lambda: settings.model_flagship,
    TIER_STANDARD: lambda: settings.model_standard,
    TIER_SMALL: lambda: settings.model_small,
    TIER_EMBEDDING: lambda: settings.model_embedding,
}


# ─────────────────────────────────────────────────────────────
# 辅助
# ─────────────────────────────────────────────────────────────
def _cache_key(scene: str, model: str, messages: list[Message], extra: str = "") -> str:
    h = hashlib.sha256()
    h.update(scene.encode())
    h.update(b"\x00")
    h.update(model.encode())
    h.update(b"\x00")
    for m in messages:
        h.update(m.role.encode())
        h.update(b"\x01")
        h.update(m.content.encode())
        h.update(b"\x02")
    h.update(extra.encode())
    return h.hexdigest()


_JSON_FENCE = re.compile(r"```(?:json)?\s*(.*?)```", re.S)


def extract_json(text: str) -> Any:
    """从 LLM 输出里稳妥地取出 JSON。

    即便开了 json_mode，仍有模型会裹一层 ``` 或在前后加寒暄。
    PLAN §4 要求"所有 AI 输出结构化，别做正则解析"——
    这里的正则只用于剥壳，不用于解析结构本身。
    """
    text = (text or "").strip()
    if not text:
        raise ValueError("LLM 返回空内容")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    if m := _JSON_FENCE.search(text):
        try:
            return json.loads(m.group(1).strip())
        except json.JSONDecodeError:
            pass
    # 退而求其次：取第一个 { 到最后一个 } / 第一个 [ 到最后一个 ]
    for lo, hi in (("{", "}"), ("[", "]")):
        i, j = text.find(lo), text.rfind(hi)
        if i != -1 and j > i:
            try:
                return json.loads(text[i : j + 1])
            except json.JSONDecodeError:
                continue
    raise ValueError(f"无法从 LLM 输出中解析 JSON：{text[:300]}")


def repair_truncated_json(text: str) -> str | None:
    """把被 max_tokens 截断的 JSON 补完整，救不回来则返回 None。

    长输出（尤其是大纲）经常在最后一节写到一半就没了 token。整份丢掉太可惜 ——
    砍掉那截残缺的尾巴，把前面完整的部分闭合回去，至少能保住大部分章节。

    做法：扫描时维护括号栈，并记录每一层"最后一个完整元素结束"的位置
    （遇到 , 或子容器闭合）。截断时从最内层往外找第一个有记录的层，
    在那里下刀，再按栈把外层依次闭合。

    注意这是有损修复，调用方必须让用户知道内容不完整 —— 悄悄接受残缺数据
    比直接报错更糟。
    """
    stack: list[str] = []  # 待闭合的括号
    cut_at: dict[int, int] = {}  # 层深 -> 该层最后一个完整元素的结束位置
    in_str = esc = False

    for i, ch in enumerate(text):
        if esc:
            esc = False
        elif in_str and ch == "\\":
            esc = True
        elif ch == '"':
            in_str = not in_str
        elif in_str:
            continue
        elif ch in "{[":
            stack.append("}" if ch == "{" else "]")
        elif ch in "}]":
            if not stack or stack[-1] != ch:
                return None  # 括号都对不上，不是"截断"而是坏数据
            stack.pop()
            cut_at[len(stack)] = i + 1
        elif ch == ",":
            cut_at[len(stack)] = i

    if not stack:
        return None  # 本来就闭合完整，问题不在截断

    for depth in range(len(stack), -1, -1):
        if depth in cut_at:
            return text[: cut_at[depth]] + "".join(reversed(stack[:depth]))
    return None


# ─────────────────────────────────────────────────────────────
# 预算闸
# ─────────────────────────────────────────────────────────────
async def check_budget(user_id: str | None, quota: int | None = None) -> None:
    """多用户 + 云 API = 别人用你的 key 花你的钱（PLAN §4.2）。"""
    if not user_id:
        return
    limit = quota if quota is not None else settings.daily_token_quota
    if not limit or limit <= 0:
        return
    since = utcnow() - timedelta(days=1)
    async with SessionLocal() as s:
        used = await s.scalar(
            select(
                func.coalesce(
                    func.sum(AICall.prompt_tokens + AICall.completion_tokens), 0
                )
            ).where(
                AICall.user_id == user_id,
                AICall.created_at >= since,
                AICall.cache_hit.is_(False),
            )
        )
    if (used or 0) >= limit:
        raise BudgetExceeded(
            f"今日 AI 用量已达上限（{used:,} / {limit:,} tokens），明天再来，"
            f"或在设置里调高配额。"
        )


async def usage_today(user_id: str) -> dict[str, Any]:
    since = utcnow() - timedelta(days=1)
    async with SessionLocal() as s:
        row = (
            await s.execute(
                select(
                    func.coalesce(func.sum(AICall.prompt_tokens), 0),
                    func.coalesce(func.sum(AICall.completion_tokens), 0),
                    func.coalesce(func.sum(AICall.cost_usd), 0.0),
                    func.count(AICall.id),
                    func.coalesce(func.sum(func.cast(AICall.cache_hit, Integer)), 0),
                ).where(AICall.user_id == user_id, AICall.created_at >= since)
            )
        ).one()
    pt, ct, cost, calls, hits = row
    return {
        "prompt_tokens": int(pt),
        "completion_tokens": int(ct),
        "total_tokens": int(pt) + int(ct),
        "cost_usd": round(float(cost), 6),
        "calls": int(calls),
        "cache_hits": int(hits),
        "quota": settings.daily_token_quota,
    }


# ─────────────────────────────────────────────────────────────
# 日志
# ─────────────────────────────────────────────────────────────
async def _log_call(
    *,
    user_id: str | None,
    scene: str,
    provider: str,
    model: str,
    tier: str,
    usage: Usage,
    cache_hit: bool,
    latency_ms: int,
    success: bool,
    error: str | None = None,
    fallback_hop: int = 0,
) -> None:
    """日志失败绝不能影响主流程，所以整段吞异常。"""
    try:
        async with SessionLocal() as s:
            s.add(
                AICall(
                    id=new_id(),
                    user_id=user_id,
                    scene=scene,
                    provider=provider,
                    model=model,
                    tier=tier,
                    prompt_tokens=usage.prompt_tokens,
                    completion_tokens=usage.completion_tokens,
                    cost_usd=estimate_cost(model, usage.prompt_tokens, usage.completion_tokens),
                    cache_hit=cache_hit,
                    latency_ms=latency_ms,
                    success=success,
                    error=(error or "")[:2000] or None,
                    fallback_hop=fallback_hop,
                    created_at=utcnow(),
                )
            )
            await s.commit()
    except Exception:
        log.exception("写入 ai_calls 失败（已忽略，不影响主流程）")


# ─────────────────────────────────────────────────────────────
# 缓存
# ─────────────────────────────────────────────────────────────
async def _cache_get(key: str) -> str | None:
    try:
        async with SessionLocal() as s:
            row = await s.get(LLMCache, key)
            if row is None:
                return None
            row.hits += 1
            await s.commit()
            return row.value
    except Exception:
        log.exception("读取 LLM 缓存失败（已忽略）")
        return None


async def _cache_put(key: str, scene: str, model: str, value: str, meta: dict | None = None) -> None:
    try:
        async with SessionLocal() as s:
            if await s.get(LLMCache, key) is None:
                s.add(
                    LLMCache(
                        key=key,
                        scene=scene,
                        model=model,
                        value=value,
                        meta=meta or {},
                        created_at=utcnow(),
                    )
                )
                await s.commit()
    except Exception:
        log.exception("写入 LLM 缓存失败（已忽略）")


# ─────────────────────────────────────────────────────────────
# 降级链
# ─────────────────────────────────────────────────────────────
def _chain(tier: str, override: str | None, scene: str = "") -> list[str]:
    """决定这次调用依次尝试哪些模型。

    优先级：显式 override > 场景级配置 > 档位默认值，
    后面再接上全局降级链。
    """
    primary = (
        override
        or settings.override_map.get(scene)
        or _TIER_SPEC.get(tier, lambda: settings.model_standard)()
    )
    chain = [primary]
    for spec in settings.fallback_list:
        if spec not in chain:
            chain.append(spec)
    return chain


async def _backoff(attempt: int) -> None:
    """指数退避 + 抖动。抖动是必须的，否则并发请求会同步重试形成尖峰。"""
    delay = min(2.0 ** attempt, 12.0) * (0.6 + random.random() * 0.8)
    await asyncio.sleep(delay)


# ─────────────────────────────────────────────────────────────
# 主入口
# ─────────────────────────────────────────────────────────────
async def chat(
    messages: list[Message],
    *,
    scene: str,
    tier: str = TIER_STANDARD,
    user_id: str | None = None,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    json_mode: bool = False,
    use_cache: bool = False,
    model_override: str | None = None,
    quota: int | None = None,
) -> LLMResult:
    chain = _chain(tier, model_override, scene)
    cache_key = None
    if use_cache:
        cache_key = _cache_key(scene, chain[0], messages, f"{temperature}|{json_mode}")
        if cached := await _cache_get(cache_key):
            await _log_call(
                user_id=user_id, scene=scene, provider="cache", model=chain[0], tier=tier,
                usage=Usage(), cache_hit=True, latency_ms=0, success=True,
            )
            return LLMResult(text=cached, model=chain[0], provider="cache")

    await check_budget(user_id, quota)

    last_err: Exception | None = None
    for hop, spec in enumerate(chain):
        try:
            provider, model = resolve(spec)
        except LLMError as exc:
            last_err = exc
            continue

        for attempt in range(settings.llm_max_retries):
            t0 = time.perf_counter()
            try:
                result = await provider.complete(
                    messages,
                    model=model,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    json_mode=json_mode,
                )
                await _log_call(
                    user_id=user_id, scene=scene, provider=provider.name, model=result.model,
                    tier=tier, usage=result.usage, cache_hit=False,
                    latency_ms=int((time.perf_counter() - t0) * 1000),
                    success=True, fallback_hop=hop,
                )
                if cache_key and result.text:
                    await _cache_put(cache_key, scene, model, result.text)
                return result
            except LLMError as exc:
                last_err = exc
                await _log_call(
                    user_id=user_id, scene=scene, provider=provider.name, model=model, tier=tier,
                    usage=Usage(), cache_hit=False,
                    latency_ms=int((time.perf_counter() - t0) * 1000),
                    success=False, error=str(exc), fallback_hop=hop,
                )
                if not exc.retryable:
                    break  # 400 之类重试无意义，直接换下一家
                if attempt < settings.llm_max_retries - 1:
                    log.warning("LLM 重试 %s/%s：%s", attempt + 1, settings.llm_max_retries, exc)
                    await _backoff(attempt)

    # 都不行就明确报错，绝不静默编造内容（PLAN §4.1 降级策略）
    raise LLMError(f"全部模型均调用失败（{scene}）：{last_err}")


async def chat_json(
    messages: list[Message],
    *,
    scene: str,
    tier: str = TIER_STANDARD,
    user_id: str | None = None,
    temperature: float = 0.3,
    max_tokens: int | None = None,
    use_cache: bool = False,
    retries: int = 2,
    quota: int | None = None,
) -> Any:
    """要求结构化输出，并保证返回可用的 Python 对象。

    解析失败时把错误回喂给模型再要一次 —— 比抛错给用户体验好得多。
    """
    msgs = list(messages)
    last_text = ""
    for i in range(retries + 1):
        result = await chat(
            msgs, scene=scene, tier=tier, user_id=user_id, temperature=temperature,
            max_tokens=max_tokens, json_mode=True,
            use_cache=use_cache and i == 0, quota=quota,
        )
        last_text = result.text
        try:
            return extract_json(result.text)
        except ValueError as exc:
            log.warning("结构化输出解析失败（第 %s 次）：%s", i + 1, exc)
            if i < retries:
                msgs = [
                    *messages,
                    Message(role="assistant", content=result.text[:2000]),
                    Message(
                        role="user",
                        content="上面的输出不是合法 JSON。请只输出一个 JSON 对象，"
                        "不要任何解释文字、不要 markdown 代码块围栏。",
                    ),
                ]
    raise LLMError(f"结构化输出连续解析失败（{scene}）：{last_text[:300]}")


async def stream_chat(
    messages: list[Message],
    *,
    scene: str,
    tier: str = TIER_STANDARD,
    user_id: str | None = None,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    quota: int | None = None,
) -> AsyncIterator[StreamChunk]:
    """流式输出。等 30 秒白屏必流失（PLAN §3.1）。

    降级有个硬约束：**一旦已经吐出内容就不能再换模型**，
    否则用户会看到两段拼在一起的答案。所以只在零产出时降级。
    """
    await check_budget(user_id, quota)
    chain = _chain(tier, None, scene)
    last_err: Exception | None = None

    for hop, spec in enumerate(chain):
        try:
            provider, model = resolve(spec)
        except LLMError as exc:
            last_err = exc
            continue

        t0 = time.perf_counter()
        produced = False
        usage = Usage()
        actual_model = model
        try:
            async for chunk in provider.stream(
                messages, model=model, temperature=temperature, max_tokens=max_tokens
            ):
                if chunk.done:
                    usage = chunk.usage or usage
                    actual_model = chunk.model or actual_model
                    break
                if chunk.delta:
                    produced = True
                    yield chunk
        except LLMError as exc:
            last_err = exc
            await _log_call(
                user_id=user_id, scene=scene, provider=provider.name, model=model, tier=tier,
                usage=usage, cache_hit=False,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                success=False, error=str(exc), fallback_hop=hop,
            )
            if produced:
                raise  # 已有产出，不能重来
            continue

        await _log_call(
            user_id=user_id, scene=scene, provider=provider.name, model=actual_model, tier=tier,
            usage=usage, cache_hit=False,
            latency_ms=int((time.perf_counter() - t0) * 1000),
            success=True, fallback_hop=hop,
        )
        yield StreamChunk(done=True, usage=usage, model=actual_model, provider=provider.name)
        return

    raise LLMError(f"全部模型流式调用均失败（{scene}）：{last_err}")


async def embed(
    texts: list[str], *, user_id: str | None = None, scene: str = "embed"
) -> list[list[float]]:
    """向量化。逐条按内容 hash 缓存 —— 同一段文本永不重复付费。"""
    if not texts:
        return []
    provider, model = resolve(settings.model_embedding)

    results: list[list[float] | None] = [None] * len(texts)
    misses: list[int] = []
    keys: list[str] = []
    for i, t in enumerate(texts):
        k = hashlib.sha256(f"emb|{model}|{t}".encode()).hexdigest()
        keys.append(k)
        if cached := await _cache_get(k):
            try:
                results[i] = json.loads(cached)
                continue
            except json.JSONDecodeError:
                pass
        misses.append(i)

    if misses:
        t0 = time.perf_counter()
        # 批量上限保守设 16，避免长文本撑爆单请求体积
        for start in range(0, len(misses), 16):
            batch_idx = misses[start : start + 16]
            batch = [texts[i] for i in batch_idx]
            try:
                vectors = await provider.embed(batch, model=model)
            except LLMError as exc:
                await _log_call(
                    user_id=user_id, scene=scene, provider=provider.name, model=model,
                    tier=TIER_EMBEDDING, usage=Usage(), cache_hit=False,
                    latency_ms=int((time.perf_counter() - t0) * 1000),
                    success=False, error=str(exc),
                )
                raise
            for i, vec in zip(batch_idx, vectors, strict=False):
                results[i] = vec
                await _cache_put(keys[i], scene, model, json.dumps(vec))

        approx_tokens = sum(len(texts[i]) for i in misses) // 2
        await _log_call(
            user_id=user_id, scene=scene, provider=provider.name, model=model,
            tier=TIER_EMBEDDING, usage=Usage(prompt_tokens=approx_tokens), cache_hit=False,
            latency_ms=int((time.perf_counter() - t0) * 1000), success=True,
        )

    return [r or [] for r in results]
