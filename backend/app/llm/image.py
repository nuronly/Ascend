"""生图 Provider（PLAN §3.7 勋章墙）。

网关的 qwen-image 走 DashScope 的 multimodal-generation 端点，
而不是 OpenAI 兼容的 /images/generations（那条路在本网关上不通），
也不是 text2image 的异步接口（当前 key 没有异步调用权限）。

⚠️ 返回的图片 URL 带 Expires 签名，几天后就 404。
   所以必须**下载到本地**保存，否则勋章墙过一阵会变成一片碎图。
"""

from __future__ import annotations

import hashlib
import logging
import time
from pathlib import Path

import httpx

from app.core.config import TIER_IMAGE, settings
from app.llm.base import LLMError
from app.llm.registry import parse_spec

log = logging.getLogger(__name__)

BADGE_DIR = settings.data_dir / "badges"


def _endpoint(base_url: str) -> str:
    """从 OpenAI 兼容地址推出 DashScope 原生地址。"""
    root = base_url.split("/compatible-mode")[0].rstrip("/")
    return f"{root}/api/v1/services/aigc/multimodal-generation/generation"


async def generate_image(
    prompt: str,
    *,
    user_id: str | None = None,
    size: str = "1024*1024",
    scene: str = "badge_image",
) -> str | None:
    """生成一张图并落地到本地，返回可访问的相对路径。

    失败一律返回 None —— 调用方会退化到兜底图案。
    生图绝不能阻塞主流程（PLAN §7 风险 #9）。
    """
    provider_name, model = parse_spec(settings.model_image)
    if provider_name != "maas" or not settings.maas_api_key:
        log.warning("未配置生图 Provider，跳过")
        return None

    BADGE_DIR.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(f"{model}|{size}|{prompt}".encode()).hexdigest()[:24]
    target = BADGE_DIR / f"{digest}.png"
    if target.exists():
        return f"/api/badges/media/{target.name}"  # 同样的 prompt 不重复付费

    t0 = time.perf_counter()
    url = _endpoint(settings.maas_base_url)
    payload = {
        "model": model,
        "input": {"messages": [{"role": "user", "content": [{"text": prompt}]}]},
        "parameters": {"size": size, "n": 1},
    }

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(180.0, connect=15.0)) as client:
            resp = await client.post(
                url,
                json=payload,
                headers={
                    "Authorization": f"Bearer {settings.maas_api_key}",
                    "Content-Type": "application/json",
                },
            )
            if resp.status_code >= 400:
                raise LLMError(f"生图失败 HTTP {resp.status_code}: {resp.text[:300]}")

            data = resp.json()
            image_url = None
            for choice in (data.get("output") or {}).get("choices") or []:
                for part in (choice.get("message") or {}).get("content") or []:
                    if part.get("image"):
                        image_url = part["image"]
                        break
                if image_url:
                    break
            if not image_url:
                raise LLMError(f"响应里没有图片：{str(data)[:300]}")

            # 签名 URL 会过期，立刻抓下来存本地
            img = await client.get(image_url)
            img.raise_for_status()
            target.write_bytes(img.content)

    except Exception as exc:
        log.warning("生图失败（将使用兜底图案）：%s", exc)
        await _log_image_call(user_id, scene, model, 0, False, str(exc))
        return None

    await _log_image_call(
        user_id, scene, model, int((time.perf_counter() - t0) * 1000), True, None
    )
    log.info("勋章图已生成：%s（%.1fs）", target.name, time.perf_counter() - t0)
    return f"/api/badges/media/{target.name}"


async def _log_image_call(
    user_id: str | None, scene: str, model: str, latency_ms: int, success: bool, error: str | None
) -> None:
    try:
        from app.core.db import SessionLocal
        from app.core.types import new_id, utcnow
        from app.models.system import AICall

        async with SessionLocal() as s:
            s.add(
                AICall(
                    id=new_id(),
                    user_id=user_id,
                    scene=scene,
                    provider="maas",
                    model=model,
                    tier=TIER_IMAGE,
                    # 生图按张计费，折算成一个可比的数字方便看板汇总
                    cost_usd=0.03 if success else 0.0,
                    latency_ms=latency_ms,
                    success=success,
                    error=(error or "")[:2000] or None,
                    created_at=utcnow(),
                )
            )
            await s.commit()
    except Exception:
        log.exception("记录生图调用失败（已忽略）")


def local_path(rel: str) -> Path | None:
    """把 /media/badges/xxx.png 映射回磁盘路径，带目录穿越防护。"""
    name = Path(rel).name
    p = (BADGE_DIR / name).resolve()
    if not str(p).startswith(str(BADGE_DIR.resolve())):
        return None
    return p if p.exists() else None
