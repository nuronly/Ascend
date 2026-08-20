"""LLM 路由器 —— 业务层调用 AI 的唯一入口。

把 PLAN §4.1 要求的全部工程防护收敛在这一层，业务代码不必重复实现：

  分级路由 · 指数退避重试 · 多供应商降级链 · 内容 hash 缓存
  · ai_calls 成本日志 · 每用户每日预算闸 · 流式首 token 超时

业务侧只需说明「这是什么场景、要哪个档位」，其余全部由本模块负责。
"""

from __future__ import annotations

import asyncio
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
    ToolCall,
    ToolEvent,
    Usage,
)
from app.llm.cache import cache_get, cache_key, cache_put
from app.llm.pricing import estimate_cost
from app.llm.registry import resolve
from app.llm.tools import Tool, tool_specs
from app.models.system import AICall

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
def _conv_key(scene: str, model: str, messages: list[Message], extra: str = "") -> str:
    parts = [scene, model]
    for m in messages:
        parts += [m.role, m.content]
    parts.append(extra)
    return cache_key(*parts)


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


class ThinkingBuffer:
    """把思维链攒成一段一段推给前端。

    ★ 只报「已推理 N 字」是不够的：那只证明进程还活着，用户还是不知道模型在
      想什么，等待照样难熬。真正让人安心的是看见推理本身。所以思维链原文要
      推出去 —— 长推理不是问题，**看不见的长推理**才是问题。

      但不能逐 chunk 直推：思维链是逐 token 来的，一次生成能有几千个 chunk，
      原样直推等于让前端 setState 几千次，肉眼可见地卡。攒到 _CHUNK 个字符发
      一段，既保留原文又把事件数压到几十个，读起来还更像「一句一句在想」。

    大纲、小节正文、边界校准三处共用 —— 留在业务层就会有三份拷贝。
    """

    _CHUNK = 48

    __slots__ = ("total", "_buf", "_len")

    def __init__(self) -> None:
        self.total = 0
        self._buf: list[str] = []
        self._len = 0

    def add(self, text: str) -> dict | None:
        """吃一片思维链；攒够一段就返回待发的 SSE 事件，否则 None。"""
        self.total += len(text)
        self._buf.append(text)
        self._len += len(text)
        return self.flush() if self._len >= self._CHUNK else None

    def flush(self) -> dict | None:
        """把没攒满的尾巴吐出来。

        切去调工具、或开始吐正文之前必须调一次，否则最后那半句思考会一直卡在
        缓冲里，等下一段思维链才露出来 —— 时序就乱了。
        """
        if not self._buf:
            return None
        text = "".join(self._buf)
        self._buf.clear()
        self._len = 0
        return {"event": "thinking", "data": {"text": text, "chars": self.total}}


class JsonArrayStream:
    """从**还没写完**的 JSON 里，把某个数组里已经闭合的对象一个个取出来。

    ★ 为什么需要它：一次性等模型把 15 个概念全部生成完，用户要干等半分钟，
      而其中每一个概念在生成出来的那一刻就已经可以让人开始勾选了。
      这个类把「等全部」变成「来一个用一个」—— 校准页就从「读进度条」
      变成了「刷题」。

    做法与 repair_truncated_json 同族：扫描时维护括号栈与字符串状态，
    只在**数组内层深为 1 的对象闭合**时产出一条。字符串里的括号和转义引号
    不能干扰配对，否则一个带 `{` 的解释文字就能把整个流搞乱。

    用法：喂增量分片，每次取回这一片里新完成的对象。
    """

    __slots__ = (
        "_key", "_buf", "_pos", "_depth", "_start", "_in_str", "_esc", "_armed", "_done",
    )

    def __init__(self, key: str) -> None:
        self._key = f'"{key}"'
        self._buf = ""
        self._pos = 0  # 已扫描到哪
        self._depth = 0  # 相对数组内部的对象层深
        self._start = -1  # 当前对象的起始位置
        self._in_str = False
        self._esc = False
        self._armed = False  # 是否已经进入目标数组
        # 数组闭合后必须彻底停手。忘了这一步的话，后面的 goals 会被当成概念
        # 一起吐出来 —— 自测按 2 字符分片时立刻抓到了这个 bug
        self._done = False

    def feed(self, chunk: str) -> list[Any]:
        """吃一段增量，返回其中新闭合的对象（按出现顺序）。"""
        if self._done:
            return []
        self._buf += chunk
        out: list[Any] = []

        # 还没找到目标数组：等 `"concepts": [` 出现
        if not self._armed:
            k = self._buf.find(self._key)
            if k == -1:
                return out
            lb = self._buf.find("[", k + len(self._key))
            if lb == -1:
                return out
            self._armed = True
            self._pos = lb + 1

        i = self._pos
        while i < len(self._buf):
            ch = self._buf[i]
            if self._esc:
                self._esc = False
            elif self._in_str:
                if ch == "\\":
                    self._esc = True
                elif ch == '"':
                    self._in_str = False
            elif ch == '"':
                self._in_str = True
            elif ch == "{":
                if self._depth == 0:
                    self._start = i
                self._depth += 1
            elif ch == "}":
                self._depth -= 1
                if self._depth == 0 and self._start >= 0:
                    raw = self._buf[self._start : i + 1]
                    try:
                        out.append(json.loads(raw))
                    except json.JSONDecodeError:
                        log.debug("流式 JSON 对象解析失败，跳过：%s", raw[:120])
                    self._start = -1
            elif ch == "]" and self._depth == 0:
                # 数组结束。后面的内容（goals 等）不属于我们，交给最终的整体解析
                self._done = True
                self._buf = ""  # 也别继续攒了，白占内存
                return out
            i += 1

        self._pos = i
        return out


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
    # 工具调用不按 token 计价（按次/按 credit），直接给定金额
    cost_override: float | None = None,
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
                    cost_usd=(
                        cost_override
                        if cost_override is not None
                        else estimate_cost(model, usage.prompt_tokens, usage.completion_tokens)
                    ),
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
# 工具执行
# ─────────────────────────────────────────────────────────────
async def _run_tool(
    call: ToolCall, tools: list[Tool], *, user_id: str | None, scene: str
) -> tuple[str, ToolEvent]:
    """执行一次工具调用，返回（喂回模型的文本, 给前端的事件）。

    工具失败**不抛异常**：把失败如实写回给模型，它会基于已有知识继续，
    而不是让整场生成崩掉。对学习场景来说，「搜不到就别编」比「直接失败」
    和「编个来源」都好。
    """
    impl = next((t for t in tools if t.name == call.name), None)
    t0 = time.perf_counter()

    if impl is None:
        detail = f"未知工具 {call.name}"
        log.warning("模型调用了不存在的工具：%s", call.name)
        return (
            f"工具 {call.name} 不存在，请不要再调用它。",
            ToolEvent(phase="error", name=call.name, detail=detail),
        )

    args = call.args()
    try:
        result = await impl.run(**args)
    except Exception as exc:  # 工具自己没兜住的意外
        log.exception("工具 %s 执行异常", call.name)
        return (
            f"工具 {call.name} 执行失败：{exc}。请基于已有知识继续，不要编造。",
            ToolEvent(
                phase="error",
                name=call.name,
                detail=str(exc)[:120],
                ms=int((time.perf_counter() - t0) * 1000),
            ),
        )

    ms = int((time.perf_counter() - t0) * 1000)
    # 工具也花钱，记一条进 ai_calls，否则成本看板会缺一块
    await _log_call(
        user_id=user_id,
        scene=f"{scene}:{call.name}",
        provider="tool",
        model=call.name,
        tier="tool",
        usage=Usage(),
        cache_hit=False,
        latency_ms=ms,
        success=True,
        cost_override=result.cost_usd,
    )
    return (
        result.content,
        ToolEvent(
            phase="result",
            name=call.name,
            detail=result.summary,
            payload=result.display,
            ms=ms,
        ),
    )


def _call_detail(call: ToolCall) -> str:
    """给用户看的一句话：正在搜什么。"""
    a = call.args()
    q = str(a.get("query") or "").strip()
    kind = str(a.get("kind") or "")
    label = {"paper": "论文", "video": "视频", "tutorial": "教程"}.get(kind, "")
    if q:
        return f"{q}（{label}）" if label else q
    return call.name


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
    # 局部名刻意不叫 cache_key —— 那是导入进来的函数名
    ckey = None
    if use_cache:
        ckey = _conv_key(scene, chain[0], messages, f"{temperature}|{json_mode}")
        if cached := await cache_get(ckey):
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
                # ★ 空产出 + finish_reason=length = 思维链把 max_tokens 吃光了。
                #   这个坑踩过两次（大纲、概念地图），两次都表现成一句莫名的
                #   「LLM 返回空内容」，得从头查一遍才知道是预算问题。
                #   非流式路径原来完全没报过 finish_reason，这里补上：
                #   下次一眼就知道该加额度，而不是去怀疑 prompt 或网关。
                if not result.text.strip() and result.finish_reason == "length":
                    log.warning(
                        "[%s/%s] %s 零产出：思维链吃光了 max_tokens=%s，调大它",
                        provider.name, model, scene, max_tokens,
                    )
                if ckey and result.text:
                    await cache_put(ckey, scene, model, result.text)
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


async def _stream_round(
    convo: list[Message],
    sink: dict[str, list[ToolCall]],
    *,
    scene: str,
    tier: str,
    user_id: str | None,
    temperature: float,
    max_tokens: int | None,
    json_mode: bool,
    specs: list[dict[str, Any]] | None,
) -> AsyncIterator[StreamChunk]:
    """一轮流式调用（含降级链）。

    模型这一轮决定调工具时，把 tool_calls 放进 sink 并**不**发 done ——
    那意味着还没说完，交回 tool loop 继续。

    降级有个硬约束：**一旦已经吐出内容就不能再换模型**，
    否则用户会看到两段拼在一起的答案。所以只在零产出时降级。
    """
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
        calls: list[ToolCall] = []
        usage = Usage()
        actual_model = model
        try:
            async for chunk in provider.stream(
                convo,
                model=model,
                temperature=temperature,
                max_tokens=max_tokens,
                json_mode=json_mode,
                tools=specs,
            ):
                if chunk.done:
                    usage = chunk.usage or usage
                    actual_model = chunk.model or actual_model
                    break
                if chunk.tool_calls:
                    # ★ 发起工具调用时 content 恰好是空的。必须把它算作「有产出」，
                    #   否则下面的零产出判断会误判失败、无谓地跳到备用模型 ——
                    #   装上工具后的第一个症状就是这个。
                    calls = chunk.tool_calls
                    produced = True
                    continue
                # 思维链（reasoning）透传给业务层展示「正在思考」，
                # 但不算正文产出 —— produced 只认 delta / tool_calls。这样
                # 「思维链跑完了、正文被 max_tokens 截断为空」仍会触发零产出降级。
                if chunk.delta:
                    produced = True
                if chunk.delta or chunk.reasoning:
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

        if not produced:
            # 流正常结束但零产出：模型返回了空内容（内容审查拦截 / 供应商瞬时故障）。
            # 一个字都没吐，换下一跳完全安全 —— 与「只在零产出时降级」的约束一致。
            # 不拦的话空字符串会流到业务层，报出误导性的「解析失败」，还白记一条 success。
            last_err = LLMError(
                f"[{provider.name}/{model}] 流式返回空内容",
                retryable=True,
                provider=provider.name,
                model=model,
            )
            log.warning("流式零产出，换下一跳：%s", last_err)
            await _log_call(
                user_id=user_id, scene=scene, provider=provider.name, model=actual_model, tier=tier,
                usage=usage, cache_hit=False,
                latency_ms=int((time.perf_counter() - t0) * 1000),
                success=False, error="流式返回空内容", fallback_hop=hop,
            )
            continue

        await _log_call(
            user_id=user_id, scene=scene, provider=provider.name, model=actual_model, tier=tier,
            usage=usage, cache_hit=False,
            latency_ms=int((time.perf_counter() - t0) * 1000),
            success=True, fallback_hop=hop,
        )
        if calls:
            sink["calls"] = calls
            return  # 还没说完，交回 tool loop
        yield StreamChunk(done=True, usage=usage, model=actual_model, provider=provider.name)
        return

    raise LLMError(f"全部模型流式调用均失败（{scene}）：{last_err}")


async def stream_chat(
    messages: list[Message],
    *,
    scene: str,
    tier: str = TIER_STANDARD,
    user_id: str | None = None,
    temperature: float = 0.7,
    max_tokens: int | None = None,
    quota: int | None = None,
    json_mode: bool = False,
    tools: list[Tool] | None = None,
) -> AsyncIterator[StreamChunk]:
    """流式输出。等 30 秒白屏必流失（PLAN §3.1）。

    带 tools 时跑 tool loop：模型可以先检索再作答，中间每一步都以 ToolEvent
    透出（正在搜什么 / 搜到了什么）。大纲本来就要一两分钟，中间再插一次
    静默的联网检索，等待就彻底不可预期了 —— 所以过程必须可见。
    """
    await check_budget(user_id, quota)
    specs = tool_specs(tools) if tools else None
    convo = list(messages)
    rounds = settings.tool_max_rounds if tools else 0

    for round_no in range(rounds + 1):
        # 最后一轮不再给工具：必须收敛到正文。留着工具的话，模型往往会
        # 「再搜一次看看」，把额度耗在检索上却始终不产出大纲
        last_round = round_no == rounds
        sink: dict[str, list[ToolCall]] = {}

        async for chunk in _stream_round(
            convo,
            sink,
            scene=scene,
            tier=tier,
            user_id=user_id,
            temperature=temperature,
            max_tokens=max_tokens,
            json_mode=json_mode,
            specs=None if last_round else specs,
        ):
            yield chunk

        calls = sink.get("calls") or []
        if not calls or not tools:
            return  # 本轮就是最终输出，done 已经由 _stream_round 发出

        # 预算每轮重查：一轮 loop 就是一次完整的模型往返，
        # 只在入口查一次的话长 loop 会悄悄超支
        await check_budget(user_id, quota)

        convo.append(Message(role="assistant", content="", tool_calls=calls))
        for c in calls:
            yield StreamChunk(
                tool_event=ToolEvent(phase="call", name=c.name, detail=_call_detail(c))
            )
            text, ev = await _run_tool(c, tools, user_id=user_id, scene=scene)
            yield StreamChunk(tool_event=ev)
            convo.append(Message(role="tool", content=text, tool_call_id=c.id))


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
        k = cache_key("emb", model, t)
        keys.append(k)
        if cached := await cache_get(k):
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
                await cache_put(keys[i], scene, model, json.dumps(vec))

        approx_tokens = sum(len(texts[i]) for i in misses) // 2
        await _log_call(
            user_id=user_id, scene=scene, provider=provider.name, model=model,
            tier=TIER_EMBEDDING, usage=Usage(prompt_tokens=approx_tokens), cache_hit=False,
            latency_ms=int((time.perf_counter() - t0) * 1000), success=True,
        )

    return [r or [] for r in results]
