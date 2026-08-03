"""勋章 API（PLAN §3.7）。"""

from __future__ import annotations

from fastapi import APIRouter, BackgroundTasks, HTTPException, status
from fastapi.responses import FileResponse

from app.api.deps import CurrentUser, Scope
from app.models.learning import Badge
from app.services import badge as svc

router = APIRouter(prefix="/badges", tags=["badges"])


def _dict(b: Badge, stats: dict) -> dict:
    d = svc.BADGE_BY_CODE.get(b.code)
    return {
        "id": b.id,
        "code": b.code,
        "kind": b.kind,
        "kind_label": svc.KIND_LABEL.get(b.kind, b.kind),
        "title": b.title,
        "description": b.description,
        "image_url": b.image_url,
        "image_status": b.image_status,
        "earned_at": b.earned_at.isoformat(),
        "criteria": b.criteria or {},
        "motif": d.motif if d else "",
        "progress": svc.progress_of(b.code, stats),
    }


@router.get("")
async def list_badges(scope: Scope, tasks: BackgroundTasks) -> dict:
    """勋章墙。

    每次打开顺手评估一次 —— 达成条件的即刻发放，图片走后台生成。
    这样用户永远不需要手动"领取"。
    """
    fresh, stats = await svc.evaluate(scope)

    # 新勋章 + 之前生图失败的，都排进后台重试
    earned = await scope.all(scope.select(Badge).order_by(Badge.earned_at.desc()))
    for b in earned:
        if b.image_status in ("pending", "failed") and (
            b in fresh or b.image_status == "pending"
        ):
            tasks.add_task(svc.render_image, scope.user_id, b.id)

    owned_codes = {b.code for b in earned}
    locked = [
        {
            "code": d.code,
            "kind": d.kind,
            "kind_label": svc.KIND_LABEL.get(d.kind, d.kind),
            "title": d.title,
            "description": d.description,
            "progress": svc.progress_of(d.code, stats),
        }
        for d in svc.BADGES
        if d.code not in owned_codes
    ]
    # 快达成的排前面，给一点"就差一点"的推力
    locked.sort(key=lambda x: -x["progress"]["ratio"])

    return {
        "earned": [_dict(b, stats) for b in earned],
        "locked": locked,
        "fresh": [b.code for b in fresh],
        "stats": stats,
        "total": len(svc.BADGES),
    }


@router.post("/{badge_id}/retry-image")
async def retry_image(badge_id: str, scope: Scope, tasks: BackgroundTasks) -> dict:
    """手动重试生图。生图有失败率，给用户一个重来的按钮。"""
    b = await scope.require(Badge, badge_id, "勋章")
    if b.image_status == "generating":
        raise HTTPException(status.HTTP_409_CONFLICT, "正在生成中，稍等一下")
    b.image_status = "pending"
    await scope.commit()
    tasks.add_task(svc.render_image, scope.user_id, b.id)
    return {"ok": True}


@router.get("/stats")
async def stats(scope: Scope) -> dict:
    return await svc.collect_stats(scope)


@router.get("/media/{filename}")
async def media(filename: str, user: CurrentUser) -> FileResponse:
    """勋章图片。

    生图接口返回的是带 Expires 的签名 URL，几天后就失效，
    所以图片一律下载到本地再由这里提供。
    """
    from app.llm.image import local_path

    p = local_path(filename)
    if p is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "图片不存在")
    return FileResponse(p, media_type="image/png", headers={"Cache-Control": "public, max-age=604800"})
