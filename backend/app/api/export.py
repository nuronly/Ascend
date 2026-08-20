"""数据导出（PLAN §4 架构约定 4 / §1.5）。

借鉴 Folium 的"数据模型要朴素"原则：我们用 DB 做本体，
但**必须提供无损导出**，避免数据绑架。用户随时能把自己的
卡片网络完整拿走 —— 这是核心资产，不能锁在我们的库里。
"""

from __future__ import annotations

import io
import zipfile
from datetime import datetime

from fastapi import APIRouter, Query
from fastapi.responses import Response, StreamingResponse
from sqlalchemy import select

from app.api.deps import Scope
from app.core.types import utcnow
from app.models.card import STATE_ARCHIVED, Card, CardLink
from app.models.course import Chapter, Course, Section
from app.models.learning import Pomodoro, ReviewState

router = APIRouter(prefix="/export", tags=["export"])


def _fname(prefix: str, ext: str) -> str:
    return f"{prefix}-{datetime.now().strftime('%Y%m%d-%H%M')}.{ext}"


@router.get("/json")
async def export_json(scope: Scope) -> Response:
    """全量 JSON 导出。字段与库内一一对应，可用于迁移或自建分析。"""
    cards = await scope.all(scope.select(Card).order_by(Card.created_at))
    links = await scope.all(scope.select(CardLink))
    courses = await scope.all(scope.select(Course).order_by(Course.created_at))
    pomodoros = await scope.all(scope.select(Pomodoro).order_by(Pomodoro.started_at))
    reviews = await scope.all(
        select(ReviewState).where(ReviewState.user_id == scope.user_id)
    )

    course_payload = []
    for c in courses:
        course_payload.append(
            {
                "id": c.id,
                "topic": c.topic,
                "title": c.title,
                "description": c.description,
                "level": c.level,
                "status": c.status,
                "created_at": c.created_at.isoformat(),
                "chapters": [
                    {
                        "id": ch.id,
                        "idx": ch.idx,
                        "title": ch.title,
                        "summary": ch.summary,
                        "sections": [
                            {
                                "id": s.id,
                                "idx": s.idx,
                                "title": s.title,
                                "summary": s.summary,
                                "key_concepts": list(s.key_concepts or []),
                                # 学习路径图的边：指向本节的前置小节 id
                                "prerequisite_ids": list(s.prerequisite_ids or []),
                                "content_md": s.content_md,
                                "completed_at": (
                                    s.completed_at.isoformat() if s.completed_at else None
                                ),
                            }
                            for s in ch.sections
                        ],
                    }
                    for ch in c.chapters
                ],
            }
        )

    payload = {
        "exported_at": utcnow().isoformat(),
        "format": "ladder-export/v1",
        "courses": course_payload,
        "cards": [
            {
                "id": c.id,
                "depth": c.depth,
                "parent_card_id": c.parent_card_id,
                "question": c.question,
                "ai_answer": c.ai_answer,
                "user_note": c.user_note,
                "is_rewritten": c.is_rewritten,
                "summary": c.summary,
                "concept_tags": list(c.concept_tags or []),
                "selected_text": c.selected_text,
                "context_text": c.context_text,
                "source_type": c.source_type,
                "source_section_id": c.source_section_id,
                "text_anchor": c.text_anchor or {},
                "origin": c.origin,
                "state": c.state,
                "pomodoro_id": c.pomodoro_id,
                "touch_count": c.touch_count,
                "created_at": c.created_at.isoformat(),
                "messages": [
                    {"seq": m.seq, "role": m.role, "content": m.content} for m in c.messages
                ],
            }
            for c in cards
        ],
        "links": [
            {
                "from": link.from_card_id,
                "to": link.to_card_id,
                "kind": link.kind,
                "relation": link.relation,
                "note": link.note,
                "created_by": link.created_by,
            }
            for link in links
        ],
        "pomodoros": [
            {
                "id": p.id,
                "section_id": p.section_id,
                "started_at": p.started_at.isoformat(),
                "ended_at": p.ended_at.isoformat() if p.ended_at else None,
                "planned_minutes": p.planned_minutes,
                "status": p.status,
            }
            for p in pomodoros
        ],
        "review_states": [
            {
                "card_id": r.card_id,
                "due_date": r.due_date.isoformat(),
                "stability": r.stability,
                "difficulty": r.difficulty,
                "reps": r.reps,
                "lapses": r.lapses,
            }
            for r in reviews
        ],
    }

    import orjson

    return Response(
        content=orjson.dumps(payload, option=orjson.OPT_INDENT_2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{_fname("ladder", "json")}"'},
    )


def _slug(text: str, fallback: str = "untitled") -> str:
    keep = "".join(ch if ch.isalnum() or ch in " -_（）()" else "-" for ch in text).strip()
    return (keep[:60] or fallback).replace("/", "-")


def _tree_order(cards: list[Card]) -> list[Card]:
    """前序遍历：根卡按创建时间排，子卡紧随父卡 —— 追问链在导出里保持相邻。"""
    children: dict[str | None, list[Card]] = {}
    for c in cards:
        children.setdefault(c.parent_card_id, []).append(c)
    for sibs in children.values():
        sibs.sort(key=lambda c: c.created_at)
    out: list[Card] = []

    def walk(c: Card) -> None:
        out.append(c)
        for kid in children.get(c.id, []):
            walk(kid)

    for root in children.get(None, []):
        walk(root)
    # 防御：父卡不在本次导出里（如被排除的 draft）的孤儿卡，按时间补在末尾
    seen = {c.id for c in out}
    out.extend(c for c in cards if c.id not in seen)
    return out


@router.get("/markdown")
async def export_markdown(scope: Scope, include_drafts: bool = Query(False)) -> StreamingResponse:
    """Markdown 打包导出。

    卡片文件名 = 标题 + id 短码（防重名），双链写成 `[[文件名]]` ——
    直接扔进 Obsidian 就能用，不需要任何转换脚本。
    """
    stmt = scope.select(Card).order_by(Card.created_at)
    if not include_drafts:
        stmt = stmt.where(Card.state != STATE_ARCHIVED)
    cards = await scope.all(stmt)
    links = await scope.all(scope.select(CardLink))
    by_id = {c.id: c for c in cards}

    outgoing: dict[str, list[tuple[Card, CardLink]]] = {}
    for link in links:
        a, b = by_id.get(link.from_card_id), by_id.get(link.to_card_id)
        if a and b:
            outgoing.setdefault(a.id, []).append((b, link))
            outgoing.setdefault(b.id, []).append((a, link))

    # 先统一算好文件名，双链才能指向正确的目标
    name_of = {
        c.id: _slug(f"{c.selected_text or c.question[:30]}-{c.id[:8]}", c.id) for c in cards
    }

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # ── 课程 ──
        for course in await scope.all(scope.select(Course)):
            lines = [f"# {course.title}", "", course.description, ""]
            for ch in course.chapters:
                lines += [f"## {ch.idx + 1}. {ch.title}", "", ch.summary, ""]
                for s in ch.sections:
                    lines += [
                        f"### {ch.idx + 1}.{s.idx + 1} {s.title}",
                        "",
                        f"> {s.summary}",
                        "",
                        s.content_md or "_（尚未生成）_",
                        "",
                    ]
            zf.writestr(
                f"courses/{_slug(course.title, course.id)}.md", "\n".join(lines)
            )

        # ── 卡片 ──
        for c in cards:
            fm = [
                "---",
                f"id: {c.id}",
                f"created: {c.created_at.isoformat()}",
                f"state: {c.state}",
                f"depth: {c.depth}",
                f"rewritten: {str(c.is_rewritten).lower()}",
            ]
            if c.concept_tags:
                fm.append("tags: [" + ", ".join(str(t) for t in c.concept_tags) + "]")
            fm.append("---")

            body = [
                "",
                f"# {c.selected_text or c.question[:40]}",
                "",
            ]
            if c.context_text:
                body += [f"> {c.context_text}", ""]
            for m in c.messages:
                body += [f"**{'Q' if m.role == 'user' else 'A'}：** {m.content}", ""]
            if c.user_note:
                body += ["## 我的话", "", c.user_note, ""]

            if peers := outgoing.get(c.id):
                body += ["## 关联", ""]
                for peer, link in peers:
                    mark = "→" if link.kind == "real" else "~"
                    note = f" — {link.note}" if link.note else ""
                    body.append(
                        f"- {mark} [[{name_of[peer.id]}]] "
                        f"（{link.relation}{note}）"
                    )
                body.append("")

            if parent := by_id.get(c.parent_card_id or ""):
                body += [f"父卡：[[{name_of[parent.id]}]]", ""]

            zf.writestr(f"cards/{name_of[c.id]}.md", "\n".join(fm + body))

        # ── 索引（树序：追问链相邻）──
        idx = ["# 卡片索引", ""]
        for c in _tree_order(cards):
            flag = " ★" if c.is_rewritten else ""
            indent = "  " * min(c.depth, 6)
            idx.append(
                f"{indent}- [[{name_of[c.id]}]] "
                f"{c.summary or c.selected_text}{flag}"
            )
        zf.writestr("INDEX.md", "\n".join(idx))
        zf.writestr(
            "README.md",
            "# 阶梯计划 · 数据导出\n\n"
            f"导出时间：{utcnow().isoformat()}\n\n"
            "- `courses/` 课程正文\n"
            "- `cards/` 卡片，文件名 = 标题 + id 短码\n"
            "- `INDEX.md` 全部卡片索引（缩进体现追问层级），★ 表示写过己见的卡\n\n"
            "卡片间的双链写作 `[[文件名]]`，可直接导入 Obsidian 等工具。\n",
        )

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{_fname("ladder-md", "zip")}"'},
    )
