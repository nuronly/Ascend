"""学习边界校准（取代难度等级）。

★ 为什么不再问「入门 / 进阶 / 深入」

  那是个谁也答不准的问题。写了十年后端的人学 Transformer 该选哪个？他对
  梯度和矩阵乘法的底子远超一个刚学完线代的学生，但对注意力一无所知 ——
  同一个标签，两人的起点毫无共同之处。**等级丢掉的信息是「已知边界的形状」**，
  而那恰恰是唯一可执行的信息。

  对模型也一样：「深入」它只能理解成多写公式、多写术语，于是 advanced 的产出
  常常是同样的内容加更多黑话，而不是真的更深。

  所以这里把「一个形容词」换成「三个集合 + 一个目标」：

    known    → 直接引用，不铺垫（也不许再开一节讲）
    shaky    → 一句话回顾即可
    unknown  → 每个都必须有小节讲清
    goal     → 决定课程的**上界**（能读懂论文 ≠ 能自己实现）

  它可执行，而且事后**可机械检查**（unknown 是否都被铺到），
  「advanced」永远没法这样验。

★ 交互形态：勾选，不是考试

  点「开始学习」的那一秒是整个产品最珍贵的资源，先甩 10 道题等于在用户最有
  动力的时刻制造挫败感 —— 答不出来的人得到的第一个反馈是「我很差」。
  所以主体是**一屏 12~16 个概念的三态勾选**（熟悉 / 听过 / 没接触）：
  零挫败、20 秒完成，而且自评「我知道这个词」其实比答对一道题更可靠地
  表示「可以直接引用它」。

  开放校验题只是补丁，用来防自评虚高，而且**只降级不升级**（见 verify_claims）。
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from collections.abc import AsyncIterator
from typing import Any

from app.core.config import TIER_SMALL, TIER_STANDARD
from app.core.types import utcnow
from app.llm import (
    JsonArrayStream,
    Message,
    ThinkingBuffer,
    chat_json,
    extract_json,
    repair_truncated_json,
    stream_chat,
)
from app.llm.cache import cache_get, cache_key, cache_put
from app.models.user import User
from app.services import prompts

log = logging.getLogger(__name__)

# 勾选要能在 30 秒内做完 —— 再多就变成表单填写了
CONCEPT_LIMIT = 16
GOAL_LIMIT = 4
# 每次最多问 2 个校验题：它的作用是抽查，不是全面测评
PROBE_LIMIT = 2
# 跨课继承的已知边界上限。超了丢最早的 —— 学习者的边界本来就在移动，
# 三年前勾过的「熟悉」不该永久生效
KNOWN_CAP = 400

_STATES = ("known", "shaky", "unknown")


_TOTAL_PROBE = re.compile(r'"total"\s*:\s*(\d+)')


def norm(name: str) -> str:
    """概念名的比对键。展示一律用原文，只有比对走这里。"""
    return " ".join(str(name or "").split()).lower()


# ─────────────────────────────────────────────────────────────
# 流式概念地图（刷题式校准）
# ─────────────────────────────────────────────────────────────
def _shape_concept(raw: Any, already: set[str], seen: set[str]) -> dict | None:
    """把模型给的一条概念规整成前端要的形状；重复或无名的丢掉。"""
    if not isinstance(raw, dict):
        return None
    name = str(raw.get("name") or "").strip()[:80]
    key = norm(name)
    if not name or key in seen:
        return None
    seen.add(key)
    depth = raw.get("depth")
    return {
        "name": name,
        "gloss": str(raw.get("gloss") or "").strip()[:120],
        # 档位不可信时归到中间档：宁可位置不准，也不能因为一个坏字段丢掉概念
        "depth": depth if depth in (1, 2, 3) else 2,
        "probe": str(raw.get("probe") or "").strip()[:200],
        # 预勾：上次学过的东西不该再问一遍
        "preset": "known" if key in already else "",
    }


def _shape_goals(raw: Any) -> list[dict]:
    goals: list[dict] = []
    kinds: set[str] = set()
    for g in raw or []:
        if not isinstance(g, dict):
            continue
        kind = str(g.get("kind") or "").strip()[:40]
        label = str(g.get("label") or "").strip()[:120]
        if not label or kind in kinds:
            continue
        kinds.add(kind)
        goals.append({"kind": kind or "apply", "label": label})
        if len(goals) >= GOAL_LIMIT:
            break
    return goals


def _map_key(topic: str, extra: str) -> str:
    return cache_key("calibmap", topic.strip().lower(), extra.strip().lower())


async def _quick_batch(*, user: User, topic: str, quota: int | None) -> list[dict]:
    """快批：小模型秒出 5 个最外围的前置概念，先让用户有题可答。

    ★ 这一批的存在理由就是**时间**。慢批（完整地图）实测能想 100 秒以上，
      哪怕思考过程全程可见，让人等一百秒才答第一道题也是不可接受的 ——
      而「学这个主题需要什么通识底子」本来就不需要深思。
    """
    data = await chat_json(
        [
            Message(role="system", content=prompts.CALIBRATE_QUICK_SYSTEM),
            Message(role="user", content=prompts.calibrate_quick_user(topic)),
        ],
        scene="calibrate_quick",
        tier=TIER_SMALL,
        user_id=user.id,
        temperature=0.2,
        max_tokens=1200,
        use_cache=True,  # 同一主题所有人共用
        quota=quota,
    )
    return [c for c in (data.get("concepts") or []) if isinstance(c, dict)][:6]


async def _deep_batch(
    *, user: User, topic: str, extra: str, quota: int | None, out: asyncio.Queue
) -> None:
    """慢批：完整概念地图（含最深档与目标候选），边生成边往队列里放。"""
    think = ThinkingBuffer()
    objects = JsonArrayStream("concepts")
    buf: list[str] = []
    total_seen = 0
    try:
        async for chunk in stream_chat(
            [
                Message(role="system", content=prompts.CALIBRATE_SYSTEM),
                Message(role="user", content=prompts.calibrate_user(topic, extra)),
            ],
            scene="calibrate",
            tier=TIER_STANDARD,
            user_id=user.id,
            temperature=0.3,  # 概念地图要稳定可缓存，不需要创造力
            # 与大纲一致：思维链也吃这份额度，8000 曾被「Transformer 注意力机制」
            # 整个吃光（零产出后靠重试救回来，等于白烧一次调用）
            max_tokens=16000,
            json_mode=True,
            quota=quota,
        ):
            if chunk.done:
                break
            if chunk.reasoning:
                if pending := think.add(chunk.reasoning):
                    await out.put(pending)
                continue
            if pending := think.flush():  # 开始吐 JSON 了，思考阶段收尾
                await out.put(pending)
            if not chunk.delta:
                continue
            buf.append(chunk.delta)

            if not total_seen and (m := _TOTAL_PROBE.search("".join(buf))):
                total_seen = int(m.group(1))
                await out.put({"event": "total", "data": {"total": min(total_seen, CONCEPT_LIMIT)}})

            for raw in objects.feed(chunk.delta):
                await out.put({"event": "_concept", "data": raw})
    finally:
        # 目标候选与缓存都靠这一步收尾，所以放 finally：即便中途断了，
        # 已经拿到的那部分也要尽力解析出来
        raw_text = "".join(buf)
        goals: list[dict] = []
        try:
            try:
                data = extract_json(raw_text)
            except ValueError:
                repaired = repair_truncated_json(raw_text)
                data = json.loads(repaired) if repaired else {}
            goals = _shape_goals((data or {}).get("goals"))
            # 完整才写缓存，免得把半截地图存下来喂给下一个人
            if isinstance(data, dict) and data.get("concepts") and goals:
                await cache_put(
                    _map_key(topic, extra),
                    "calibrate",
                    "stream",
                    json.dumps(data, ensure_ascii=False),
                )
        except Exception as exc:  # noqa: BLE001
            log.warning("概念地图收尾解析失败（目标候选可能缺失）：%s", exc)
        await out.put({"event": "goals", "data": {"goals": goals}})


async def stream_concept_map(
    *, user: User, topic: str, extra: str = "", quota: int | None = None
) -> AsyncIterator[dict]:
    """流式产出概念地图：一道一道地出，边出边让人勾。

    ★ 三层手段合起来才让「等待」变成「已经在做事」

      1. **两批并行**。慢批（完整地图，含最深档概念与学习目标）实测要想 100 秒
         以上；快批用小模型几秒钟给出 5 个最外围的前置基础，用户立刻开始答。
         等他答完前几道，慢批的深层概念已经陆续到了。
         两批同时发起 —— 串起来跑就白费了快批的意义。
      2. **流式**。慢批的每个概念一闭合就推一条，不等整份 JSON 写完。
      3. **思维链可见**。长推理不是问题，看不见的长推理才是问题。

      缓存命中时整份瞬间回放：同一主题的第二个人几乎零等待。
      preset（预勾）不能进缓存 —— 那是每个人自己的已知边界，回放时才算。
    """
    already = {norm(c) for c in (user.known_concepts or [])}
    seen: set[str] = set()
    sent = 0

    # ── 缓存命中：秒回放，连快批都不用发 ──
    if cached := await cache_get(_map_key(topic, extra)):
        try:
            data = json.loads(cached)
        except json.JSONDecodeError:
            data = None
        if isinstance(data, dict):
            concepts = list(data.get("concepts") or [])[:CONCEPT_LIMIT]
            yield {"event": "total", "data": {"total": len(concepts), "cached": True}}
            for raw in concepts:
                if shaped := _shape_concept(raw, already, seen):
                    sent += 1
                    yield {"event": "concept", "data": {**shaped, "idx": sent}}
            yield {"event": "goals", "data": {"goals": _shape_goals(data.get("goals"))}}
            yield {"event": "done", "data": {"count": sent, "cached": True}}
            return

    queue: asyncio.Queue[dict] = asyncio.Queue()
    failed: list[str] = []

    async def quick() -> None:
        try:
            for raw in await _quick_batch(user=user, topic=topic, quota=quota):
                await queue.put({"event": "_concept", "data": raw})
        except Exception as exc:  # noqa: BLE001
            # 快批只是抢时间的，挂了不算失败 —— 慢批照样会给出完整地图
            log.warning("快批概念失败（%s）：%s", topic, exc)
        finally:
            await queue.put({"event": "_end", "data": {"who": "quick"}})

    async def deep() -> None:
        try:
            await _deep_batch(user=user, topic=topic, extra=extra, quota=quota, out=queue)
        except Exception as exc:  # noqa: BLE001
            log.warning("概念地图流式生成失败（%s）：%s", topic, exc)
            failed.append(str(exc)[:300])
        finally:
            await queue.put({"event": "_end", "data": {"who": "deep"}})

    tasks = [asyncio.create_task(quick()), asyncio.create_task(deep())]
    pending_ends = 2
    try:
        while pending_ends:
            ev = await queue.get()
            if ev["event"] == "_end":
                pending_ends -= 1
                continue
            if ev["event"] == "_concept":
                if sent >= CONCEPT_LIMIT:
                    continue
                if shaped := _shape_concept(ev["data"], already, seen):
                    sent += 1
                    # idx 由这里统一发号，两批混在一起也不会重号
                    yield {"event": "concept", "data": {**shaped, "idx": sent}}
                continue
            yield ev
    finally:
        # 客户端断开时这个生成器会被 close，两个任务必须跟着收掉，
        # 否则它们会继续往一个没人读的队列里塞，直到 SSE 超时
        for t in tasks:
            t.cancel()

    if failed:
        yield {"event": "error", "data": {"message": failed[0]}}
    # 失败也要给 done —— 前端据此走降级路，绝不卡在转圈上
    yield {"event": "done", "data": {"count": sent, "failed": bool(failed)}}


# 一次性版本（concept_map）已删除：它和流式版是两条会互相漂移的路，
# 而它唯一的优势「实现简单」抵不上让用户对着空白等 20 秒的代价。


def pick_probes(concepts: list[dict], states: dict[str, str]) -> list[dict]:
    """挑要抽查的概念：**只查最深档里自评「熟悉」的**。

    浅档不查 —— 一个人说自己会矩阵乘法，基本可信，为此出题只是徒增摩擦。
    虚高只发生在天花板附近（「听过」被当成「熟悉」），抽查就抽在那里。
    """
    pool = [
        c
        for c in concepts
        if states.get(norm(c["name"])) == "known" and c.get("probe")
    ]
    pool.sort(key=lambda c: -int(c.get("depth") or 2))
    return [
        {"concept": c["name"], "question": c["probe"], "depth": c["depth"]}
        for c in pool[:PROBE_LIMIT]
    ]


# ─────────────────────────────────────────────────────────────
# 自评校验
# ─────────────────────────────────────────────────────────────
async def verify_claims(
    *, user: User, items: list[dict], quota: int | None = None
) -> dict:
    """判断「熟悉」的自评是否属实，返回需要降级的概念。

    ★ 两条铁律：

      1. **只降级，不升级**。答得好只是维持自评，答得差就降成「半懂」。
         因为两种错误的代价差一个数量级：多回顾一句最多啰嗦，少回顾一句
         他会直接看不懂后面全部内容。

      2. **判定服务本身挂了，按自评走**，不做任何降级。
         保守原则针对的是「模型对答案拿不准」，不是「我们的调用失败了」——
         后者拿用户的自评去背锅毫无道理，而且效果等同于他跳过校验。
    """
    items = [it for it in items if str(it.get("answer") or "").strip()][:PROBE_LIMIT]
    if not items:
        return {"demoted": [], "notes": {}}

    try:
        data = await chat_json(
            [
                Message(role="system", content=prompts.VERIFY_SYSTEM),
                Message(role="user", content=prompts.verify_user(items)),
            ],
            scene="verify",
            tier=TIER_STANDARD,
            user_id=user.id,
            temperature=0.1,
            # 判定本身只要几十字，但推理模型会先想一大段，额度不能按输出长度给
            max_tokens=4000,
            quota=quota,
        )
    except Exception as exc:
        log.warning("自评校验失败，按自评走：%s", exc)
        return {"demoted": [], "notes": {}}

    judged: dict[str, dict] = {}
    for r in data.get("results") or []:
        if isinstance(r, dict) and r.get("concept"):
            judged[norm(str(r["concept"]))] = r

    demoted: list[str] = []
    notes: dict[str, str] = {}
    for it in items:
        name = str(it.get("concept") or "")
        r = judged.get(norm(name))
        if r is None:
            # 模型没给这一条的结论 —— 拿不准就当没通过（见 VERIFY_SYSTEM）
            demoted.append(name)
            continue
        if not bool(r.get("pass")):
            demoted.append(name)
            notes[name] = str(r.get("note") or "").strip()[:80]
    return {"demoted": demoted, "notes": notes}


# ─────────────────────────────────────────────────────────────
# 边界组装
# ─────────────────────────────────────────────────────────────
def build_boundary(
    states: dict[str, str],
    *,
    names: dict[str, str] | None = None,
    goal: str = "",
    goal_kind: str = "",
    demoted: list[str] | None = None,
) -> dict:
    """把三态勾选 + 校验结果合成一份学习契约。

    states 的键是归一化后的概念名（前端提交的原文在 names 里），
    这样大小写、多余空格不会让「Softmax」和「softmax」变成两个概念。
    """
    names = names or {}
    demote = {norm(d) for d in (demoted or [])}
    buckets: dict[str, list[str]] = {"known": [], "shaky": [], "unknown": []}

    for key, state in states.items():
        if state not in _STATES:
            continue
        display = names.get(key) or key
        # 抽查没过的从「熟悉」落到「半懂」：不是判错，只是多带他回顾一句
        if state == "known" and key in demote:
            state = "shaky"
        buckets[state].append(display)

    return {
        "known": buckets["known"],
        "shaky": buckets["shaky"],
        "unknown": buckets["unknown"],
        "goal": goal.strip()[:200],
        "goal_kind": goal_kind.strip()[:40],
        "demoted": [names.get(norm(d)) or d for d in (demoted or [])],
        "calibrated_at": utcnow().isoformat(),
    }


def derive_level(boundary: dict) -> str:
    """从边界反推一个 level，只为兼容旧展示（课程列表、导出）。

    ★ 方向是单向的：边界 → level。反过来推不出来，这也正是要换掉 level 的
      原因 —— 一个形容词丢掉了整张边界地图。
    """
    known = len(boundary.get("known") or [])
    shaky = len(boundary.get("shaky") or [])
    unknown = len(boundary.get("unknown") or [])
    total = known + shaky + unknown
    if total == 0:
        return "intermediate"
    ratio = unknown / total
    if ratio >= 0.6:
        return "beginner"
    # 未知不足两成才叫「深入」。四分之一是新的，那还是一门正常的进阶课
    if ratio < 0.2:
        return "advanced"
    return "intermediate"


# ─────────────────────────────────────────────────────────────
# 跨课继承：已知边界的演进
# ─────────────────────────────────────────────────────────────
def learn(user: User, names: list[str]) -> int:
    """把概念并入用户的已知边界。返回新增了几个。

    调用点：建课校准里勾了「熟悉」、以及学完一节后该节的 key_concepts。
    """
    current = [str(x) for x in (user.known_concepts or [])]
    have = {norm(x) for x in current}
    added = 0
    for name in names:
        name = str(name or "").strip()[:80]
        key = norm(name)
        if not name or key in have:
            continue
        have.add(key)
        current.append(name)
        added += 1
    if added:
        # 超上限丢最早的：边界是移动的，三年前勾的「熟悉」不该永久生效
        user.known_concepts = current[-KNOWN_CAP:]
    return added


def _mentions(text: str, name: str) -> bool:
    key = norm(name)
    if len(key) < 2:
        return False  # 单字概念误伤率太高（「熵」会命中「熵增的熵」以外一大堆）
    low = text.lower()
    if key.isascii():
        # 英文要卡词边界，否则 "go" 会命中 "google"
        return re.search(rf"(?<![a-z0-9]){re.escape(key)}(?![a-z0-9])", low) is not None
    return key in low


def forget(user: User, text: str) -> list[str]:
    """划词追问命中了某个「已知」概念 → 把它移出已知边界。

    ★ 这是整套设计里最强的信号：他**真的**在这个词上卡住了。
      行为信号 > 自评，所以这里无条件覆盖当初的勾选结果。
    """
    current = [str(x) for x in (user.known_concepts or [])]
    if not current or not (text or "").strip():
        return []
    hit = [c for c in current if _mentions(text, c)]
    if hit:
        drop = {norm(c) for c in hit}
        user.known_concepts = [c for c in current if norm(c) not in drop]
    return hit


def coverage_gap(boundary: dict, covered: list[str]) -> list[str]:
    """检查 unknown 里有哪些概念在大纲里根本没被提到。

    ★ 这是「集合约束」换掉「形容词约束」带来的直接好处：约束可验证。
      拿 advanced 是没法做这件事的 —— 你无法机械检查一份大纲「够不够深入」，
      但完全可以检查「他说不会的这 6 个词，是不是每个都有地方讲」。
    """
    blob = norm(" \n ".join(covered))
    gap: list[str] = []
    for name in boundary.get("unknown") or []:
        if not _mentions(blob, str(name)):
            gap.append(str(name))
    return gap


def as_any(boundary: Any) -> dict:
    """老课程的 boundary 可能是 None / 坏值，统一成 dict 再用。"""
    return boundary if isinstance(boundary, dict) else {}
