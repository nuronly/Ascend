"""课程服务：主题 → 大纲 → 小节懒生成（PLAN §3.1）。"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import AsyncIterator

from sqlalchemy import select

from app.core.config import TIER_FLAGSHIP, TIER_STANDARD
from app.core.scope import UserScope
from app.core.types import new_id, utcnow
from app.llm import (
    Message,
    chat,
    chat_json,
    extract_json,
    repair_truncated_json,
    stream_chat,
)
from app.models.course import (
    COURSE_FAILED,
    COURSE_READY,
    SECTION_FAILED,
    SECTION_GENERATING,
    SECTION_READY,
    Chapter,
    Course,
    Section,
)
from app.models.graph import Concept, ConceptEdge
from app.services import prompts

log = logging.getLogger(__name__)

_CONCEPT_BLOCK = re.compile(
    re.escape(prompts.CONCEPT_OPEN) + r"(.*?)" + re.escape(prompts.CONCEPT_CLOSE),
    re.S,
)


def split_concepts(raw: str) -> tuple[str, dict]:
    """把正文与尾部概念块拆开。

    概念块解析失败是可以容忍的——正文照常显示，只是这一节暂时不进概念图。
    绝不能因为一个 JSON 括号写错就让用户看不到内容。
    """
    m = _CONCEPT_BLOCK.search(raw)
    if not m:
        return raw.strip(), {}
    body = _CONCEPT_BLOCK.sub("", raw).strip()
    try:
        return body, json.loads(m.group(1).strip())
    except json.JSONDecodeError:
        log.warning("小节概念块解析失败，正文照常返回")
        return body, {}


# ─────────────────────────────────────────────────────────────
# 大纲
# ─────────────────────────────────────────────────────────────
# 旗舰模型设计一门 6 章 24 节的大纲要 2 分钟以上。
# 同步等待 = 白屏两分半 = 必然流失，所以大纲同样走流式，
# 边生成边把已经定下来的章节标题推给前端，让等待可见、可预期。
_TITLE_PROBE = re.compile(r'"title"\s*:\s*"((?:[^"\\]|\\.)*)"')


async def stream_outline(
    scope: UserScope, course: Course, *, quota: int | None = None
) -> AsyncIterator[dict]:
    """流式生成大纲，逐步吐出已确定的章节标题作为进度。"""
    yield {"event": "start", "data": {"course_id": course.id, "topic": course.topic}}

    messages = [
        Message(role="system", content=prompts.OUTLINE_SYSTEM),
        Message(
            role="user",
            content=prompts.outline_user(
                course.topic, course.level, (course.meta or {}).get("extra", "")
            ),
        ),
    ]

    buf: list[str] = []
    seen_titles = 0
    thinking_chars = 0
    try:
        async for chunk in stream_chat(
            messages,
            scene="outline",
            tier=TIER_FLAGSHIP,  # 低频、一次性、质量决定整门课体验
            user_id=scope.user_id,
            temperature=0.6,
            # 推理模型的思维链要占额度：8000 曾被思维链整个吃光，正文零产出
            max_tokens=16000,
            quota=quota,
        ):
            if chunk.done:
                break
            # 思维链：只作为「正在思考」信号透出，不进 buf —— 混进正文会污染大纲 JSON
            if chunk.reasoning:
                thinking_chars += len(chunk.reasoning)
                yield {"event": "thinking", "data": {"chars": thinking_chars}}
                continue
            buf.append(chunk.delta)
            # 每冒出一个新标题就报一次进度 —— 用户看到大纲在长出来
            titles = _TITLE_PROBE.findall("".join(buf))
            if len(titles) > seen_titles:
                for t in titles[seen_titles:]:
                    yield {"event": "progress", "data": {"title": t, "count": len(titles)}}
                seen_titles = len(titles)
    except Exception as exc:
        course.status = COURSE_FAILED
        course.error = str(exc)[:1000]
        await scope.commit()
        yield {"event": "error", "data": {"message": str(exc)[:400]}}
        return

    raw = "".join(buf)
    truncated = False
    try:
        try:
            data = extract_json(raw)
        except ValueError:
            # 大纲动辄几十个小节，很容易在最后一节耗尽 token。
            # 整份丢掉太可惜 —— 砍掉残缺的尾巴，把前面完整的章节救回来。
            repaired = repair_truncated_json(raw)
            if repaired is None:
                raise  # 不是截断，是真的坏数据，照常报错
            data = json.loads(repaired)
            truncated = True
            log.warning("大纲输出被截断（%d 字符），已修复并保留前面的完整章节", len(raw))
        await _persist_outline(scope, course, data)
    except Exception as exc:
        course.status = COURSE_FAILED
        course.error = str(exc)[:1000]
        await scope.commit()
        log.exception("大纲解析失败")
        yield {"event": "error", "data": {"message": f"大纲解析失败：{str(exc)[:300]}"}}
        return

    # truncated 必须让用户知道：悄悄接受残缺大纲比直接报错更糟
    yield {
        "event": "done",
        "data": {"course_id": course.id, "title": course.title, "truncated": truncated},
    }


async def generate_outline(
    scope: UserScope, course: Course, *, quota: int | None = None
) -> Course:
    """非流式版本，供内部调用（如从图谱空白处生成强化课）。"""
    try:
        data = await chat_json(
            [
                Message(role="system", content=prompts.OUTLINE_SYSTEM),
                Message(
                    role="user",
                    content=prompts.outline_user(
                        course.topic, course.level, (course.meta or {}).get("extra", "")
                    ),
                ),
            ],
            scene="outline",
            tier=TIER_FLAGSHIP,
            user_id=scope.user_id,
            temperature=0.6,
            max_tokens=16000,  # 与流式版一致：给思维链留额度
            quota=quota,
        )
    except Exception as exc:
        course.status = COURSE_FAILED
        course.error = str(exc)[:1000]
        await scope.commit()
        raise
    await _persist_outline(scope, course, data)
    return course


async def _persist_outline(scope: UserScope, course: Course, data: dict) -> Course:
    course.title = (data.get("title") or course.topic).strip()[:500]
    course.description = (data.get("description") or "").strip()

    chapters_in = data.get("chapters") or []
    # 丢掉没有小节的空壳章。截断修复后最后一章常常只剩个标题，
    # 留着会在课程页显示成一个点不开的空章节。
    kept = [c for c in chapters_in if isinstance(c, dict) and (c.get("sections") or [])]
    if len(kept) != len(chapters_in):
        log.warning("丢弃 %d 个没有小节的空壳章节", len(chapters_in) - len(kept))
    chapters_in = kept

    if not chapters_in:
        course.status = COURSE_FAILED
        course.error = "模型没有返回任何章节"
        await scope.commit()
        raise ValueError(course.error)

    for ci, ch in enumerate(chapters_in):
        chapter = Chapter(
            id=new_id(),
            course_id=course.id,
            idx=ci,
            title=(ch.get("title") or f"第 {ci + 1} 章").strip()[:500],
            summary=(ch.get("summary") or "").strip(),
        )
        scope.add(chapter)
        # sections 有指向 chapters 的外键，先 flush 保证插入顺序
        await scope.flush()
        for si, sec in enumerate(ch.get("sections") or []):
            try:
                est = int(sec.get("est_minutes") or 25)
            except (TypeError, ValueError):
                est = 25
            scope.add(
                Section(
                    id=new_id(),
                    chapter_id=chapter.id,
                    idx=si,
                    title=(sec.get("title") or f"{ci + 1}.{si + 1}").strip()[:500],
                    summary=(sec.get("summary") or "").strip(),
                    est_minutes=max(5, min(est, 90)),
                    key_concepts=[str(k) for k in (sec.get("key_concepts") or [])][:8],
                    prerequisite_ids=[str(k) for k in (sec.get("prerequisite_ids") or [])][:8],
                )
            )

    course.status = COURSE_READY
    course.error = None
    await scope.commit()
    return course


# ─────────────────────────────────────────────────────────────
# 小节正文（懒生成 + 流式）
# ─────────────────────────────────────────────────────────────
async def _prev_section_titles(scope: UserScope, course_id: str, section: Section) -> list[str]:
    """取本节之前的全部小节标题，让模型知道讲过什么，避免重复。"""
    rows = await scope.session.execute(
        select(Chapter.idx, Section.idx, Section.title)
        .join(Section, Section.chapter_id == Chapter.id)
        .where(Chapter.course_id == course_id)
        .order_by(Chapter.idx, Section.idx)
    )
    cur_chapter = await scope.session.get(Chapter, section.chapter_id)
    cur_key = (cur_chapter.idx if cur_chapter else 0, section.idx)
    return [t for ci, si, t in rows if (ci, si) < cur_key]


async def stream_section_content(
    scope: UserScope,
    section_id: str,
    *,
    adjust: str = "",
    force: bool = False,
    quota: int | None = None,
) -> AsyncIterator[dict]:
    """流式生成小节正文，产出 SSE 事件字典。

    懒生成的核心（PLAN §3.1）：已有缓存直接回放，不重复调用模型。
    用户随手输一个主题就跑 30 次大模型 = 烧钱。
    """
    section, chapter, course = await scope.section_course(section_id)

    if section.content_status == SECTION_READY and section.content_md and not force:
        yield {"event": "cached", "data": {"section_id": section.id}}
        yield {"event": "delta", "data": {"text": section.content_md}}
        yield {
            "event": "done",
            "data": {"section_id": section.id, "cached": True, "length": len(section.content_md)},
        }
        return

    section.content_status = SECTION_GENERATING
    if force:
        section.regenerate_count += 1
    await scope.commit()

    prev = await _prev_section_titles(scope, course.id, section)
    user_msg = prompts.section_user(
        course_title=course.title,
        chapter_title=chapter.title,
        section_title=section.title,
        section_summary=section.summary,
        est_minutes=section.est_minutes,
        level=course.level,
        prev_titles=prev,
        key_concepts=list(section.key_concepts or []),
        adjust=prompts.ADJUST_HINT.get(adjust, adjust),
    )

    yield {"event": "start", "data": {"section_id": section.id, "title": section.title}}

    # 概念块是给机器看的，绝不能闪现在用户眼前。
    # 难点：`<!--LADDER_CONCEPTS` 很可能被切分在两个 chunk 中间，
    # 所以永远保留末尾一个哨兵长度的窗口不发出，直到确认它不是块开头。
    guard = len(prompts.CONCEPT_OPEN)
    buf: list[str] = []
    sent = 0
    halted = False
    thinking_chars = 0
    try:
        async for chunk in stream_chat(
            [
                Message(role="system", content=prompts.SECTION_SYSTEM),
                Message(role="user", content=user_msg),
            ],
            scene="section",
            tier=TIER_STANDARD,  # 量大、可接受略逊；不满意可重生成
            user_id=scope.user_id,
            temperature=0.7,
            max_tokens=16000,  # 推理模型思维链占额度，与大纲一致放宽
            quota=quota,
        ):
            if chunk.done:
                break
            # 思维链透出为思考信号，不进 buf —— 概念块过滤只管正文
            if chunk.reasoning:
                thinking_chars += len(chunk.reasoning)
                yield {"event": "thinking", "data": {"chars": thinking_chars}}
                continue
            buf.append(chunk.delta)
            if halted:
                continue
            full = "".join(buf)
            at = full.find(prompts.CONCEPT_OPEN)
            if at != -1:
                emit_to, halted = at, True
            else:
                emit_to = max(sent, len(full) - guard)
            if emit_to > sent:
                yield {"event": "delta", "data": {"text": full[sent:emit_to]}}
                sent = emit_to
    except Exception as exc:
        section.content_status = SECTION_FAILED
        await scope.commit()
        log.exception("小节生成失败")
        yield {"event": "error", "data": {"message": str(exc)[:500]}}
        return

    raw = "".join(buf)
    body, concept_data = split_concepts(raw)

    section.content_md = body
    section.content_status = SECTION_READY
    section.generated_at = utcnow()
    if names := [c.get("name") for c in (concept_data.get("concepts") or []) if c.get("name")]:
        section.key_concepts = names[:12]
    await scope.commit()

    if concept_data:
        try:
            await _persist_concepts(scope, course.id, section.id, concept_data)
        except Exception:
            log.exception("概念图写入失败（不影响正文）")

    # 正文里的概念块被过滤掉了，最后把干净全文发一次让前端对齐
    yield {"event": "content", "data": {"markdown": body}}
    yield {
        "event": "done",
        "data": {"section_id": section.id, "cached": False, "length": len(body)},
    }


async def _persist_concepts(
    scope: UserScope, course_id: str, section_id: str, data: dict
) -> None:
    """把抽取到的概念写入 AI 概念图（v0.2 叠加视图的底图）。"""
    existing = {
        c.norm_name: c
        for c in await scope.all(
            select(Concept).where(
                Concept.course_id == course_id, Concept.user_id == scope.user_id
            )
        )
    }

    for item in (data.get("concepts") or [])[:20]:
        name = str(item.get("name") or "").strip()
        if not name:
            continue
        key = name.lower()
        if key in existing:
            if desc := str(item.get("description") or "").strip():
                if not existing[key].description:
                    existing[key].description = desc
            continue
        c = Concept(
            id=new_id(),
            user_id=scope.user_id,
            course_id=course_id,
            name=name[:200],
            norm_name=key[:200],
            description=str(item.get("description") or "").strip(),
            section_id=section_id,
            created_at=utcnow(),
        )
        scope.add(c)
        existing[key] = c

    await scope.flush()

    seen: set[tuple[str, str, str]] = set()
    for rel in (data.get("relations") or [])[:40]:
        a = existing.get(str(rel.get("from") or "").strip().lower())
        b = existing.get(str(rel.get("to") or "").strip().lower())
        if not a or not b or a.id == b.id:
            continue
        kind = str(rel.get("relation") or "related")
        if kind not in {"prerequisite", "part_of", "related", "contrast"}:
            kind = "related"
        sig = (a.id, b.id, kind)
        if sig in seen:
            continue
        seen.add(sig)
        dup = await scope.session.scalar(
            select(ConceptEdge.id).where(
                ConceptEdge.from_concept == a.id,
                ConceptEdge.to_concept == b.id,
                ConceptEdge.relation == kind,
            )
        )
        if dup:
            continue
        scope.add(
            ConceptEdge(
                id=new_id(),
                user_id=scope.user_id,
                course_id=course_id,
                from_concept=a.id,
                to_concept=b.id,
                relation=kind,
            )
        )
    await scope.commit()


async def suggest_topics(scope: UserScope, seed: str = "") -> list[str]:
    """首页的主题建议。小模型 + 缓存，成本可忽略。"""
    result = await chat(
        [
            Message(
                role="system",
                content="你负责给学习平台推荐值得深入学习的主题。"
                '只输出 JSON：{"topics": ["主题1", ...]}，8 个，每个不超过 12 字，'
                "覆盖不同领域，具体而非笼统（例如「Transformer 注意力机制」而非「人工智能」）。",
            ),
            Message(role="user", content=seed or "给我一些值得学的主题"),
        ],
        scene="suggest",
        tier="small",
        user_id=scope.user_id,
        temperature=1.0,
        json_mode=True,
        max_tokens=500,
    )
    from app.llm import extract_json

    try:
        return [str(t) for t in (extract_json(result.text).get("topics") or [])][:8]
    except Exception:
        return []
