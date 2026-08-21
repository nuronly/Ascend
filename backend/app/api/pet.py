"""桌宠 API。

只有一个端点：**此刻该说什么**。

桌宠不接新的 AI 链路 —— 它要「聊」就转给第二大脑（/brain/ask，带引用可溯源）。
理由写在 services/pet.py 的模块头：一旦桌宠能用通用知识兜底，
用户就分不清哪句话是从自己的学习记录里来的，第二大脑最贵的资产当场作废。
"""

from __future__ import annotations

from fastapi import APIRouter

from app.api.deps import Scope
from app.services import pet as svc

router = APIRouter(prefix="/pet", tags=["pet"])


@router.get("/nudge")
async def nudge(scope: Scope) -> dict:
    """挑此刻最该提起的一件事。轻查询，不调模型 —— 桌宠常驻，不能一冒泡就花钱。"""
    return await svc.nudge(scope)
