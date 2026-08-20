"""课程服务：主题 → 大纲 → 小节懒生成（PLAN §3.1）。"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import AsyncIterator
from typing import Any

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
from app.llm.tools import available_tools
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
from app.services import prompts

log = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────
# 参考资料
# ─────────────────────────────────────────────────────────────
def _collect_found(payload: dict, into: dict[str, dict]) -> None:
    """把一次检索的结果并入「本次生成里真实见过的 url」白名单。"""
    for it in payload.get("items") or []:
        if url := str(it.get("url") or ""):
            into.setdefault(url, it)


def _as_resource(url: str, hit: dict, *, title: str = "", kind: str = "", why: str = "") -> dict:
    return {
        "title": (title or str(hit.get("title") or ""))[:200],
        "url": url,
        "source": str(hit.get("source") or ""),
        "kind": kind or str(hit.get("kind") or "article"),
        "authority": int(hit.get("authority") or 0),
        "why": why[:200],
    }


def _verify_resources(raw: Any, found: dict[str, dict], limit: int = 6) -> list[dict]:
    """校验模型给出的推荐资料。

    ★ 只保留 url 在本次检索结果里**真实出现过**的条目。模型很会「顺手」写一个
      看起来非常对的链接（arXiv 编号尤其容易被编出来），学习者点进去发现 404
      或者完全不相干的论文 —— 那比不给推荐糟得多，一次就会失去信任。
      与其相信 prompt 里的约束，不如在这里做白名单校验。
    """
    out: list[dict] = []
    seen: set[str] = set()
    dropped = 0
    for r in raw or []:
        if not isinstance(r, dict):
            continue
        url = str(r.get("url") or "").strip()
        hit = found.get(url)
        if not hit or url in seen:
            dropped += 1
            continue
        seen.add(url)
        out.append(
            _as_resource(
                url,
                hit,
                title=str(r.get("title") or ""),
                kind=str(r.get("kind") or ""),
                why=str(r.get("why") or ""),
            )
        )
    if dropped:
        log.warning("丢弃 %d 条编造或重复的推荐资料（url 不在检索结果里）", dropped)
    # 权威优先
    out.sort(key=lambda x: -x["authority"])
    return out[:limit]


def _top_found(found: dict[str, dict], limit: int = 4) -> list[dict]:
    """直接从检索结果里挑权威的做延伸阅读。

    小节正文不让模型输出 url —— 它没机会编造，也省下一段 JSON 的输出预算。
    """
    items = sorted(
        found.values(),
        key=lambda x: (-int(x.get("authority") or 0), -float(x.get("score") or 0)),
    )
    return [_as_resource(str(it.get("url")), it) for it in items[:limit]]


def _tool_sse(ev, found: dict[str, dict]) -> dict:
    """把工具事件翻成 SSE。

    等待期的空白是最劝退的东西：大纲本来就要一两分钟，中间再插一次静默的
    联网检索，用户完全无法判断是在干活还是卡死了。所以「正在搜什么、
    搜到了什么」必须实时说出来。
    """
    if ev.phase == "call":
        return {"event": "tool_call", "data": {"name": ev.name, "detail": ev.detail}}
    if ev.phase == "result":
        _collect_found(ev.payload, found)
        items = [
            {
                "title": it.get("title", ""),
                "url": it.get("url", ""),
                "source": it.get("source", ""),
                "kind": it.get("kind", "article"),
                "authority": it.get("authority", 0),
            }
            for it in (ev.payload.get("items") or [])[:6]
        ]
        return {
            "event": "tool_result",
            "data": {"name": ev.name, "detail": ev.detail, "items": items, "ms": ev.ms},
        }
    return {"event": "tool_error", "data": {"name": ev.name, "detail": ev.detail}}


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
    # 本次生成过程中真实检索到的 url → 结果项。落库时拿它当白名单校验
    found: dict[str, dict] = {}
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
            # 实测 json_mode 与 tools 可以同时用，所以大纲这条「必须输出 JSON」
            # 的路也能带工具
            json_mode=True,
            tools=available_tools(),
        ):
            if chunk.done:
                break
            # 工具调用：正在搜什么、搜到了什么，实时说出来
            if chunk.tool_event:
                yield _tool_sse(chunk.tool_event, found)
                continue
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
        await _persist_outline(scope, course, data, found=found)
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
        "data": {
            "course_id": course.id,
            "title": course.title,
            "truncated": truncated,
            # 顺带把资料带回去，前端不用再多一次请求
            "resources": list(course.resources or []),
        },
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


async def _persist_outline(
    scope: UserScope, course: Course, data: dict, *, found: dict[str, dict] | None = None
) -> Course:
    course.title = (data.get("title") or course.topic).strip()[:500]
    course.description = (data.get("description") or "").strip()
    # 只有 url 真实出现在本次检索结果里的推荐才留下（见 _verify_resources）
    course.resources = _verify_resources(data.get("resources"), found or {})

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

    # ── 第一趟：建章与节，同时记下 sid → Section 的对应 ──
    # 依赖要等所有小节都拿到真实 id 才能回填，所以必须拆成两趟。
    # 模型给的 sid（"1.1"）只是它自己那份 JSON 里的临时编号，不入库。
    by_sid: dict[str, Section] = {}
    order: list[Section] = []  # 按 (章序, 节序) 排好的自然学习顺序
    raw_prereq: dict[str, list[str]] = {}  # section.id → 模型给的 sid 列表

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
            section = Section(
                id=new_id(),
                chapter_id=chapter.id,
                idx=si,
                title=(sec.get("title") or f"{ci + 1}.{si + 1}").strip()[:500],
                summary=(sec.get("summary") or "").strip(),
                key_concepts=[str(k) for k in (sec.get("key_concepts") or [])][:8],
            )
            scope.add(section)
            order.append(section)

            sid = str(sec.get("sid") or "").strip() or f"{ci + 1}.{si + 1}"
            # 模型偶尔会给出重复 sid，先到先得
            by_sid.setdefault(sid, section)
            # prerequisites 是新字段名；prerequisite_ids 是旧的，一并认
            deps_raw = sec.get("prerequisites")
            if deps_raw is None:
                deps_raw = sec.get("prerequisite_ids")
            raw_prereq[section.id] = [str(x).strip() for x in (deps_raw or [])][:8]

    # ── 第二趟：把 sid 翻成真实 section id ──
    # ★ 只保留指向「更早小节」的边。这一条约束同时解决三件事：
    #   1. 天然无环 —— 有环的路径图会彻底失去方向感，dagre 只能瞎猜层级
    #   2. 符合「前置」语义 —— 前置知识不可能排在它后面
    #   3. 模型偶发的反向依赖被直接剪掉，不必再单独做环检测
    rank = {s.id: i for i, s in enumerate(order)}
    dropped = 0
    for s in order:
        deps: list[str] = []
        for sid in raw_prereq.get(s.id, []):
            target = by_sid.get(sid)
            if target is None or target.id == s.id or rank[target.id] >= rank[s.id]:
                dropped += 1
                continue
            if target.id not in deps:
                deps.append(target.id)
        s.prerequisite_ids = deps

    if dropped:
        log.info("剪掉 %d 条无效依赖（指向不存在的小节、自身，或排在后面的小节）", dropped)

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
            "data": {
                "section_id": section.id,
                "cached": True,
                "length": len(section.content_md),
                "resources": list(section.resources or []),
            },
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
        level=course.level,
        prev_titles=prev,
        key_concepts=list(section.key_concepts or []),
        adjust=prompts.ADJUST_HINT.get(adjust, adjust),
    )

    yield {"event": "start", "data": {"section_id": section.id, "title": section.title}}

    buf: list[str] = []
    thinking_chars = 0
    found: dict[str, dict] = {}
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
            tools=available_tools(),
        ):
            if chunk.done:
                break
            # 正在核实什么 / 找到了什么，实时说出来
            if chunk.tool_event:
                yield _tool_sse(chunk.tool_event, found)
                continue
            # 思维链只作为「正在思考」信号透出，不进正文
            if chunk.reasoning:
                thinking_chars += len(chunk.reasoning)
                yield {"event": "thinking", "data": {"chars": thinking_chars}}
                continue
            buf.append(chunk.delta)
            yield {"event": "delta", "data": {"text": chunk.delta}}
    except Exception as exc:
        section.content_status = SECTION_FAILED
        await scope.commit()
        log.exception("小节生成失败")
        yield {"event": "error", "data": {"message": str(exc)[:500]}}
        return

    body = "".join(buf).strip()
    section.content_md = body
    section.content_status = SECTION_READY
    section.generated_at = utcnow()
    # 延伸阅读直接取检索到的权威结果 —— 不让模型输出 url，它就没机会编造，
    # 也省下一段 JSON 的输出预算
    if found:
        section.resources = _top_found(found)
    await scope.commit()

    # 落库后把全文再发一次，让前端与服务端对齐。
    # （原来这一步还负责剔掉尾部概念块；概念块已废除，正文就是纯 Markdown，
    #   但事件保留 —— 前端靠它做最终一致性校正。）
    yield {"event": "content", "data": {"markdown": body}}
    yield {
        "event": "done",
        "data": {
            "section_id": section.id,
            "cached": False,
            "length": len(body),
            "resources": list(section.resources or []),
        },
    }




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
