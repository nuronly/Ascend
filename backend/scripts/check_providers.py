"""供应商体检。

逐路实测当前配置里的每一个模型，包括降级链的每一跳。

    python scripts/check_providers.py            # 只测文本链路（很便宜）
    python scripts/check_providers.py --image    # 连生图一起测（较贵较慢）

用途：
  · 换配置后确认路由落点正确
  · 充值后确认额度恢复
  · 排查「AI 不可用」时定位是哪一路断了
"""

from __future__ import annotations

import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.core.config import settings  # noqa: E402
from app.llm.base import LLMError, Message  # noqa: E402
from app.llm.registry import resolve  # noqa: E402

G, R, Y, D, X = "\033[32m", "\033[31m", "\033[33m", "\033[2m", "\033[0m"


async def probe(spec: str) -> tuple[bool, str, float]:
    """打一次最小请求，返回 (是否可用, 说明, 耗时秒)。"""
    t0 = time.perf_counter()
    try:
        provider, model = resolve(spec)
    except LLMError as exc:
        return False, f"未配置：{exc}", 0.0
    try:
        r = await provider.complete(
            [Message(role="user", content="hi")],
            model=model,
            max_tokens=4,
            temperature=0,
            timeout=45,
        )
        return True, f"{r.usage.total} tokens", time.perf_counter() - t0
    except LLMError as exc:
        msg = str(exc)
        if "Unpurchased" in msg or "AccessDenied" in msg:
            hint = "余额不足 / 该模型未开通"
        elif "401" in msg or "Authentication" in msg:
            hint = "API key 无效"
        elif "429" in msg:
            hint = "被限流"
        elif "超时" in msg:
            hint = "超时"
        else:
            hint = msg.split(": ", 1)[-1][:64]
        return False, hint, time.perf_counter() - t0


async def probe_embedding(spec: str) -> tuple[bool, str, float]:
    t0 = time.perf_counter()
    try:
        provider, model = resolve(spec)
        vecs = await provider.embed(["测试"], model=model, timeout=45)
        dim = len(vecs[0]) if vecs and vecs[0] else 0
        if dim != settings.embedding_dim:
            return False, f"维度 {dim} ≠ 配置的 {settings.embedding_dim}", time.perf_counter() - t0
        return True, f"{dim} 维", time.perf_counter() - t0
    except Exception as exc:
        msg = str(exc)
        hint = "余额不足 / 未开通" if "Unpurchased" in msg else msg[:64]
        return False, hint, time.perf_counter() - t0


async def probe_image(spec: str) -> tuple[bool, str, float]:
    from app.llm.image import generate_image

    t0 = time.perf_counter()
    url = await generate_image("一个极简的圆形几何图案", scene="healthcheck")
    dt = time.perf_counter() - t0
    return (True, url or "", dt) if url else (False, "生成失败（勋章会用兜底图案）", dt)


def line(label: str, spec: str, ok: bool, note: str, dt: float, critical: bool) -> None:
    mark = f"{G}✓{X}" if ok else (f"{R}✗{X}" if critical else f"{Y}!{X}")
    t = f"{dt:.1f}s" if dt else "—"
    print(f"  {mark} {label:<14}{spec:<34}{t:>7}  {D}{note}{X}")


async def main() -> int:
    print(f"\n\033[1m阶梯 · 供应商体检\033[0m  {D}环境 {settings.app_env}{X}\n")

    from app.llm.registry import available_providers

    print(f"已配置 Provider：{', '.join(available_providers()) or '（无）'}\n")

    failures_critical = 0
    failures_soft = 0

    # ── 主链路 ──
    print("\033[1m主链路\033[0m")
    for label, spec in (
        ("旗舰", settings.model_flagship),
        ("中档", settings.model_standard),
        ("小模型", settings.model_small),
    ):
        ok, note, dt = await probe(spec)
        line(label, spec, ok, note, dt, True)
        if not ok:
            failures_critical += 1

    # ── 场景覆盖 ──
    if overrides := settings.override_map:
        print("\n\033[1m场景覆盖\033[0m")
        seen: set[str] = set()
        for scene, spec in overrides.items():
            if spec in seen:
                line(scene, spec, True, "同上，跳过", 0, False)
                continue
            seen.add(spec)
            ok, note, dt = await probe(spec)
            line(scene, spec, ok, note, dt, True)
            if not ok:
                failures_critical += 1

    # ── 专用能力（DeepSeek 官方没有，只能走网关）──
    print("\n\033[1m专用能力\033[0m")
    ok, note, dt = await probe_embedding(settings.model_embedding)
    line("向量", settings.model_embedding, ok, note, dt, False)
    if not ok:
        failures_soft += 1
        print(f"      {D}→ 第二大脑的向量召回会失效，但全文/图扩散/结构加权三路照常{X}")

    if "--image" in sys.argv:
        ok, note, dt = await probe_image(settings.model_image)
        line("生图", settings.model_image, ok, note, dt, False)
        if not ok:
            failures_soft += 1
    else:
        line("生图", settings.model_image, True, "跳过，加 --image 实测", 0, False)

    # ── 降级链 ──
    print("\n\033[1m降级链\033[0m  " + f"{D}主模型失败时按顺序尝试{X}")
    if not settings.fallback_list:
        print(f"  {Y}!{X} 未配置降级链 —— 主供应商故障时全站 AI 不可用")
        failures_soft += 1
    else:
        alive = 0
        for i, spec in enumerate(settings.fallback_list, 1):
            ok, note, dt = await probe(spec)
            line(f"第 {i} 跳", spec, ok, note, dt, False)
            if ok:
                alive += 1
            else:
                failures_soft += 1
        if alive == 0:
            print(f"      {D}→ 备用全部不可用，主供应商一旦故障就没有兜底{X}")

    # ── 结论 ──
    print("\n" + "─" * 72)
    if failures_critical:
        print(f"{R}主链路有 {failures_critical} 处不可用 —— 核心功能会报错。{X}")
    elif failures_soft:
        print(f"{Y}主链路正常，但有 {failures_soft} 处降级/专用能力不可用。{X}")
        print(f"{D}产品可正常使用，只是失去了冗余（或部分增强功能）。{X}")
    else:
        print(f"{G}全部可用。{X}")
    return 1 if failures_critical else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
