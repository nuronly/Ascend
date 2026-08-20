"""课程 API（PLAN §3.1）。"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from app.api.deps import CurrentUser, Scope, user_quota
from app.api.sse import sse_response
from app.core.scope import UserScope
from app.core.types import new_id, utcnow
from app.models.card import STATE_ARCHIVED, Card
from app.models.course import (
    COURSE_DRAFT,
    COURSE_OUTLINING,
    COURSE_READY,
    SECTION_READY,
    Chapter,
    Course,
    Section,
)
from app.services import calibrate
from app.services import course as svc
from app.services.runstream import cancel_run, outline_key, section_key, stream_run

log = logging.getLogger(__name__)

router = APIRouter(prefix="/courses", tags=["courses"])


# ─────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────
class CalibrateIn(BaseModel):
    topic: str = Field(min_length=2, max_length=200)
    extra: str = Field(default="", max_length=1000)


class ConceptStateIn(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    state: str = Field(pattern="^(known|shaky|unknown)$")


class ProbeAnswerIn(BaseModel):
    concept: str = Field(max_length=80)
    question: str = Field(default="", max_length=300)
    answer: str = Field(default="", max_length=1000)


class CalibrationIn(BaseModel):
    """建课时带上的学习边界。整块可以缺省 —— 用户永远有权跳过校准。"""

    concepts: list[ConceptStateIn] = Field(default_factory=list, max_length=40)
    goal: str = Field(default="", max_length=200)
    goal_kind: str = Field(default="", max_length=40)
    # 开放校验题的回答。空着就等于跳过，按自评走
    probes: list[ProbeAnswerIn] = Field(default_factory=list, max_length=4)


class CreateCourseIn(BaseModel):
    topic: str = Field(min_length=2, max_length=200)
    # level 只在跳过校准时还起作用；有 calibration 时由边界反推
    level: str = Field(default="intermediate", pattern="^(beginner|intermediate|advanced)$")
    extra: str = Field(default="", max_length=1000)
    calibration: CalibrationIn | None = None


class SectionOut(BaseModel):
    id: str
    idx: int
    title: str
    summary: str
    content_status: str
    key_concepts: list[Any] = []
    # 学习路径图的边：本节的前置小节 id。前端据此画出依赖，
    # 空数组表示这节没有前置，可以直接开始学
    prerequisite_ids: list[str] = []
    completed: bool = False
    card_count: int = 0


class ChapterOut(BaseModel):
    id: str
    idx: int
    title: str
    summary: str
    sections: list[SectionOut] = []


class CourseOut(BaseModel):
    id: str
    topic: str
    title: str
    description: str
    status: str
    level: str
    error: str | None = None
    created_at: str
    chapters: list[ChapterOut] = []
    stats: dict = {}
    # AI 联网检索后推荐的参考资料（已做过 url 白名单校验）
    resources: list[Any] = []
    # 学习边界（known / shaky / unknown / goal）。老课程是空对象
    boundary: dict = {}
    # 大纲没铺到的「未掌握」概念。有缺口就让用户自己决定要不要重生成
    coverage_gap: list[str] = []


class UpdateSectionIn(BaseModel):
    title: str | None = Field(default=None, max_length=500)
    summary: str | None = Field(default=None, max_length=2000)


# ─────────────────────────────────────────────────────────────
# 序列化
# ─────────────────────────────────────────────────────────────
def _course_brief(c: Course) -> dict:
    return {
        "id": c.id,
        "topic": c.topic,
        "title": c.title or c.topic,
        "description": c.description,
        "status": c.status,
        "level": c.level,
        "error": c.error,
        "created_at": c.created_at.isoformat(),
    }


async def _course_full(scope: Scope, c: Course) -> CourseOut:
    # 每节的卡片数：一次聚合查完，避免 N+1
    counts = dict(
        (await scope.session.execute(
            select(Card.source_section_id, func.count(Card.id))
            .where(Card.user_id == scope.user_id, Card.state != STATE_ARCHIVED)
            .group_by(Card.source_section_id)
        )).all()
    )

    chapters: list[ChapterOut] = []
    total = done = 0
    for ch in c.chapters:
        secs: list[SectionOut] = []
        for s in ch.sections:
            total += 1
            if s.completed_at:
                done += 1
            secs.append(
                SectionOut(
                    id=s.id,
                    idx=s.idx,
                    title=s.title,
                    summary=s.summary,
                    content_status=s.content_status,
                    key_concepts=list(s.key_concepts or []),
                    prerequisite_ids=[str(x) for x in (s.prerequisite_ids or [])],
                    completed=s.completed_at is not None,
                    card_count=int(counts.get(s.id, 0)),
                )
            )
        chapters.append(
            ChapterOut(id=ch.id, idx=ch.idx, title=ch.title, summary=ch.summary, sections=secs)
        )

    return CourseOut(
        **_course_brief(c),
        chapters=chapters,
        resources=list(c.resources or []),
        boundary=calibrate.as_any(c.boundary),
        coverage_gap=[str(x) for x in ((c.meta or {}).get("coverage_gap") or [])],
        stats={
            "sections": total,
            "completed": done,
            "cards": sum(counts.get(s.id, 0) for ch in c.chapters for s in ch.sections),
        },
    )


# ─────────────────────────────────────────────────────────────
# 端点
# ─────────────────────────────────────────────────────────────
@router.get("")
async def list_courses(scope: Scope, limit: int = Query(50, le=200)) -> list[dict]:
    rows = await scope.all(
        scope.select(Course).order_by(Course.created_at.desc()).limit(limit)
    )
    if not rows:
        return []

    ids = [c.id for c in rows]
    sec_stats = dict(
        (await scope.session.execute(
            select(Chapter.course_id, func.count(Section.id))
            .join(Section, Section.chapter_id == Chapter.id)
            .where(Chapter.course_id.in_(ids))
            .group_by(Chapter.course_id)
        )).all()
    )
    done_stats = dict(
        (await scope.session.execute(
            select(Chapter.course_id, func.count(Section.id))
            .join(Section, Section.chapter_id == Chapter.id)
            .where(Chapter.course_id.in_(ids), Section.completed_at.is_not(None))
            .group_by(Chapter.course_id)
        )).all()
    )

    out = []
    for c in rows:
        d = _course_brief(c)
        d["stats"] = {
            "sections": int(sec_stats.get(c.id, 0)),
            "completed": int(done_stats.get(c.id, 0)),
        }
        out.append(d)
    return out


@router.post("/calibrate")
async def calibrate_topic(body: CalibrateIn, scope: Scope, user: CurrentUser) -> dict:
    """开课前的边界校准：给出这个主题的概念地图与目标候选。

    ★ 这一步取代了「入门 / 进阶 / 深入」。理由见 services/calibrate.py：
      等级是个谁也答不准的问题，而且模型也无从执行「深入」。

    失败绝不能挡住建课 —— 那是这个产品最珍贵的一秒。所以出错时返回空地图，
    前端直接走「跳过校准」的路。
    """
    try:
        data = await calibrate.concept_map(
            user=user, topic=body.topic.strip(), extra=body.extra.strip(),
            quota=user_quota(user),
        )
    except Exception as exc:  # noqa: BLE001
        log.warning("概念地图生成失败（%s）：%s", body.topic, exc)
        return {"concepts": [], "goals": [], "degraded": True}
    return {**data, "degraded": not data["concepts"]}


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_course(body: CreateCourseIn, scope: Scope, user: CurrentUser) -> dict:
    """建课。**立即返回**，大纲由随后的 SSE 端点流式生成。

    旗舰模型设计一门课的大纲要两分钟以上，同步等 = 白屏两分半 = 必然流失。
    所以这里只落一条 outlining 状态的记录，前端拿到 id 就能进页面等，
    等待过程中逐章看到大纲长出来。

    唯一的例外是自评抽查（一次几百 token 的小调用，约两秒）：它必须在大纲
    开跑**之前**定下来，否则边界还没确定，大纲已经按错误的起点写下去了。
    """
    boundary: dict = {}
    level = body.level
    cal = body.calibration
    if cal and cal.concepts:
        # 归一化后再入桶：Softmax / softmax / " softmax " 是同一个概念
        states = {calibrate.norm(c.name): c.state for c in cal.concepts}
        names = {calibrate.norm(c.name): c.name.strip() for c in cal.concepts}
        verdict = await calibrate.verify_claims(
            user=user,
            items=[p.model_dump() for p in cal.probes],
            quota=user_quota(user),
        )
        boundary = calibrate.build_boundary(
            states,
            names=names,
            goal=cal.goal,
            goal_kind=cal.goal_kind,
            demoted=verdict["demoted"],
        )
        # level 只留给旧展示用，方向单向：边界 → level
        level = calibrate.derive_level(boundary)
        # 复利：勾了「熟悉」的进用户的已知边界，下一门课不用再勾一遍
        calibrate.learn(user, boundary["known"])

    course = Course(
        id=new_id(),
        user_id=scope.user_id,
        topic=body.topic.strip(),
        title=body.topic.strip(),
        level=level,
        status=COURSE_OUTLINING,
        meta={"extra": body.extra.strip()} if body.extra.strip() else {},
        boundary=boundary,
    )
    scope.add(course)
    await scope.commit()
    return _course_brief(course)


@router.get("/{course_id}/outline/stream")
async def stream_outline(
    course_id: str, request: Request, scope: Scope, user: CurrentUser, force: bool = False
):
    """SSE 流式生成大纲，逐章推送进度。"""
    course = await scope.require(Course, course_id, "课程")
    if course.status == COURSE_READY and course.chapters and not force:

        async def replay():
            yield {"event": "done", "data": {"course_id": course.id, "cached": True}}

        return await sse_response(replay(), request)

    if force or course.chapters:
        await scope.session.execute(delete(Chapter).where(Chapter.course_id == course.id))
    course.status = COURSE_OUTLINING
    course.error = None
    await scope.commit()

    quota = user_quota(user)

    async def gen(sc: UserScope):
        # 后台任务有自己的 session，ORM 对象必须在那边重新取 —— 复用请求这个
        # course 实例的话，它的改动落不进库（对象不属于新 session）
        c = await sc.require(Course, course_id, "课程")
        async for ev in svc.stream_outline(sc, c, quota=quota):
            yield ev

    # 建课后用户常常先切走。大纲要跑一两分钟，掐掉等于白烧一次旗舰模型
    return await sse_response(
        stream_run(outline_key(course_id), scope.user_id, gen, restart=force), request
    )


@router.get("/{course_id}")
async def get_course(course_id: str, scope: Scope) -> CourseOut:
    course = await scope.require(Course, course_id, "课程")
    return await _course_full(scope, course)




@router.delete("/{course_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_course(course_id: str, scope: Scope) -> None:
    course = await scope.require(Course, course_id, "课程")
    # 后台可能正在给这门课写大纲或正文。行都要没了，让它跑完只会写成孤儿数据
    cancel_run(outline_key(course_id))
    for sid in await scope.all(
        select(Section.id).join(Chapter, Chapter.id == Section.chapter_id)
        .where(Chapter.course_id == course_id)
    ):
        cancel_run(section_key(str(sid)))
    await scope.session.delete(course)
    await scope.commit()


@router.get("/{course_id}/sections/{section_id}")
async def get_section(course_id: str, section_id: str, scope: Scope) -> dict:
    section, chapter, course = await scope.section_course(section_id)
    if course.id != course_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "小节不属于该课程")

    # 上一节 / 下一节，用于讲解页底部导航
    rows = list(
        (await scope.session.execute(
            select(Section.id, Section.title, Chapter.idx, Section.idx)
            .join(Chapter, Chapter.id == Section.chapter_id)
            .where(Chapter.course_id == course.id)
            .order_by(Chapter.idx, Section.idx)
        )).all()
    )
    pos = next((i for i, r in enumerate(rows) if r[0] == section_id), -1)
    nav = {
        "prev": {"id": rows[pos - 1][0], "title": rows[pos - 1][1]} if pos > 0 else None,
        "next": (
            {"id": rows[pos + 1][0], "title": rows[pos + 1][1]}
            if 0 <= pos < len(rows) - 1
            else None
        ),
        "index": pos + 1,
        "total": len(rows),
    }

    return {
        "id": section.id,
        "title": section.title,
        "summary": section.summary,
        "content_md": section.content_md,
        "content_status": section.content_status,
        "key_concepts": list(section.key_concepts or []),
        "prerequisite_ids": [str(x) for x in (section.prerequisite_ids or [])],
        "resources": list(section.resources or []),
        "regenerate_count": section.regenerate_count,
        "completed": section.completed_at is not None,
        "chapter": {"id": chapter.id, "title": chapter.title, "idx": chapter.idx},
        "course": {"id": course.id, "title": course.title, "level": course.level},
        "nav": nav,
    }


@router.get("/{course_id}/sections/{section_id}/stream")
async def stream_section(
    course_id: str,
    section_id: str,
    request: Request,
    scope: Scope,
    user: CurrentUser,
    adjust: str = Query("", max_length=500),
    force: bool = Query(False),
):
    """SSE 流式生成小节正文。已缓存则直接回放，不重复烧钱。"""
    section, _, course = await scope.section_course(section_id)
    if course.id != course_id:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "小节不属于该课程")

    quota = user_quota(user)

    def gen(sc: UserScope):
        return svc.stream_section_content(
            sc, section_id, adjust=adjust, force=force, quota=quota
        )

    # ★ 切走再回来要能接着看，而不是从零重写。换难度（adjust）与重生成
    #   算另一次生成，得把在跑的那次顶掉，否则两份会抢着写同一行
    return await sse_response(
        stream_run(
            section_key(section_id),
            scope.user_id,
            gen,
            restart=force or bool(adjust),
        ),
        request,
    )


@router.patch("/{course_id}/sections/{section_id}")
async def update_section(
    course_id: str, section_id: str, body: UpdateSectionIn, scope: Scope
) -> dict:
    """大纲可编辑 —— AI 编课质量不稳定，得给用户方向盘（PLAN §7 风险 #7）。"""
    section = await scope.require_section(section_id)
    for k, v in body.model_dump(exclude_none=True).items():
        setattr(section, k, v)
    await scope.commit()
    return {"ok": True}


@router.post("/{course_id}/sections/{section_id}/complete")
async def complete_section(
    course_id: str, section_id: str, scope: Scope, user: CurrentUser
) -> dict:
    section = await scope.require_section(section_id)
    section.completed_at = None if section.completed_at else utcnow()
    learned = 0
    if section.completed_at:
        # ★ 边界的自然演进：学完一节，这节的核心概念进入已知边界，
        #   下一门课就不会再从头讲它。取消勾选不回退 —— 学过就是学过，
        #   真忘了会由「划词追问命中它」这个更强的信号把它撤下来（calibrate.forget）
        learned = calibrate.learn(user, [str(k) for k in (section.key_concepts or [])])
    await scope.commit()
    return {"completed": section.completed_at is not None, "learned": learned}


@router.get("/meta/suggestions")
async def topic_suggestions(scope: Scope, seed: str = Query("", max_length=100)) -> dict:
    return {"topics": await svc.suggest_topics(scope, seed)}


__all__ = ["router", "COURSE_DRAFT", "COURSE_READY", "SECTION_READY"]
