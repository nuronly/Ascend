"""课程 API（PLAN §3.1）。"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select

from app.api.deps import CurrentUser, Scope, user_quota
from app.api.sse import sse_response
from app.core.types import new_id, utcnow
from app.models.card import Card, STATE_ARCHIVED
from app.models.course import (
    COURSE_DRAFT,
    COURSE_OUTLINING,
    COURSE_READY,
    SECTION_READY,
    Chapter,
    Course,
    Section,
)
from app.services import course as svc

router = APIRouter(prefix="/courses", tags=["courses"])


# ─────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────
class CreateCourseIn(BaseModel):
    topic: str = Field(min_length=2, max_length=200)
    level: str = Field(default="intermediate", pattern="^(beginner|intermediate|advanced)$")
    extra: str = Field(default="", max_length=1000)


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


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_course(body: CreateCourseIn, scope: Scope) -> dict:
    """建课。**立即返回**，大纲由随后的 SSE 端点流式生成。

    旗舰模型设计一门课的大纲要两分钟以上，同步等 = 白屏两分半 = 必然流失。
    所以这里只落一条 outlining 状态的记录，前端拿到 id 就能进页面等，
    等待过程中逐章看到大纲长出来。
    """
    course = Course(
        id=new_id(),
        user_id=scope.user_id,
        topic=body.topic.strip(),
        title=body.topic.strip(),
        level=body.level,
        status=COURSE_OUTLINING,
        meta={"extra": body.extra.strip()} if body.extra.strip() else {},
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

    return await sse_response(
        svc.stream_outline(scope, course, quota=user_quota(user)), request
    )


@router.get("/{course_id}")
async def get_course(course_id: str, scope: Scope) -> CourseOut:
    course = await scope.require(Course, course_id, "课程")
    return await _course_full(scope, course)




@router.delete("/{course_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_course(course_id: str, scope: Scope) -> None:
    course = await scope.require(Course, course_id, "课程")
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

    return await sse_response(
        svc.stream_section_content(
            scope, section_id, adjust=adjust, force=force, quota=user_quota(user)
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
async def complete_section(course_id: str, section_id: str, scope: Scope) -> dict:
    section = await scope.require_section(section_id)
    section.completed_at = None if section.completed_at else utcnow()
    await scope.commit()
    return {"completed": section.completed_at is not None}


@router.get("/meta/suggestions")
async def topic_suggestions(scope: Scope, seed: str = Query("", max_length=100)) -> dict:
    return {"topics": await svc.suggest_topics(scope, seed)}


__all__ = ["router", "COURSE_DRAFT", "COURSE_READY", "SECTION_READY"]
