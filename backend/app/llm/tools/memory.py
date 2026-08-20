"""记忆工具：让任何 AI 场景都能查这个人的学习记录。

★ 为什么是工具，而不是「把检索结果拼进 prompt」

  原则一句话：**索引用于发现，工具用于引用**（retrieval as routing）。

  · 向量与全文索引的职责是**路由** —— 告诉模型「第 3 章那份笔记可能相关」。
    摘要级的索引足够做这件事，过时一点也不影响：一份笔记的主题不会因为
    用户改了两句话就变。
  · 工具的职责是**取当前真相** —— read_note 拿到**此刻**的全文。

  这样解决三个真实问题：
    1. 笔记是动态的。用户改完笔记，旧向量作废（index_card 会置空 embedding），
       而重新 embed 需要额外调用。靠工具读全文就没有这个一致性窗口了。
    2. 上下文预算。原来把每条命中截断成 900+600 字拼进 prompt，一份三千字的
       笔记会被砍掉后半 —— 而后半正是「我的理解」「我还没搞懂的」，最值钱的部分。
       改成按需读全文，只有真正要引用的那一两份进上下文，反而更省。
    3. 可解释性。模型明说「我查了 1.2 的笔记」，而不是一堆来源不明的片段。

★ 为什么用户隔离是安全的

  工具是**实例**（不是全局注册表），构造时注入 UserScope。所有查询都走
  scope.select(...)，天然带 user_id 过滤 —— 与业务代码同一条数据访问通道，
  不存在「工具绕过隔离层」这种口子。

★ 这一层的调用方不止第二大脑

  正文生成（「他学过 RNN，可以直接类比」）、笔记生成（带入相关旧笔记）、
  卡片问答（用他自己的话回答他）、建课校准（已知边界）——
  一旦记忆是工具，它就自动无处不在，而不是侧栏里一个要专门想起来的入口。

★ 但工具不是白给的：每一次调用都是一轮完整的模型往返

  所以有一条配套原则：**能零成本塞进 prompt 的路由信息就塞进去，
  别拿一轮工具调用去换。** 「他哪几节写过笔记」是一句 SQL 的事，
  直接列进 prompt（见 services/note.note_routes）；工具只留给
  「按需取全文」这种又大又必须实时的事。

  各场景因此只拿自己真需要的那几件（见 SECTION_TOOLS / NOTE_TOOLS）。
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import or_, select

from app.core.scope import UserScope
from app.llm.tools import Tool, ToolResult
from app.models.card import KIND_CARD, KIND_NOTE, STATE_ARCHIVED, Card
from app.models.course import Chapter, Course, Section

log = logging.getLogger(__name__)

# 单条摘要的截断长度。tool loop 每轮都会重发完整历史，
# 不控制长度的话 prompt 会一轮比一轮胖
_ABSTRACT = 180
_FULL_NOTE = 6000


def _kind_label(kind: str) -> str:
    return "笔记" if kind == KIND_NOTE else "疑问卡"


class SearchMemory:
    """跨笔记 / 卡片 / 课程结构的召回。返回**摘要级**命中，供进一步 read。"""

    name = "search_memory"
    description = (
        "在这位学习者自己的学习记录里检索：他写过的笔记、划词提过的疑问、"
        "以及他学过的课程小节。返回摘要与 id —— 需要完整内容时再用 read_note。"
        "凡是涉及「他学过什么 / 他当时怎么理解的 / 他问过什么」都该先查这里，"
        "不要凭空推测他的水平。"
    )

    def __init__(self, scope: UserScope) -> None:
        self._scope = scope

    def schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "检索词，用具体的概念名词，不要用整句问句",
                },
                "kind": {
                    "type": "string",
                    "enum": ["any", "note", "card", "section"],
                    "description": (
                        "note=他写的笔记，card=他提过的疑问，"
                        "section=他学过的课程小节，any=全部"
                    ),
                },
            },
            "required": ["query"],
        }

    async def run(self, **kwargs: Any) -> ToolResult:
        query = str(kwargs.get("query") or "").strip()
        kind = str(kwargs.get("kind") or "any")
        if not query:
            return ToolResult(content="检索词为空。", summary="检索词为空")

        lines: list[str] = []
        display: dict[str, Any] = {"query": query, "items": []}

        if kind in ("any", "note", "card"):
            # 延迟 import：brain 那边也会构造这批工具，顶层互 import 会成环
            from app.services import brain

            cards = await brain.retrieve(self._scope, query, top_k=12)
            if kind == "note":
                cards = [c for c in cards if c.kind == KIND_NOTE]
            elif kind == "card":
                cards = [c for c in cards if c.kind == KIND_CARD]

            for c in cards[:8]:
                body = (c.user_note or c.ai_answer or "").replace("\n", " ")
                title = c.question or c.selected_text or "（无题）"
                lines.append(
                    f"[{_kind_label(c.kind)}] {title}\n"
                    f"  摘要：{(c.summary or body)[:_ABSTRACT]}\n"
                    f"  id={c.id}"
                    + ("（可用 read_note 读全文）" if c.kind == KIND_NOTE else "")
                )
                display["items"].append(
                    {"id": c.id, "kind": c.kind, "title": title[:80], "section_id": c.source_section_id}
                )

        if kind in ("any", "section"):
            for sec, ch, co in await self._sections(query):
                lines.append(
                    f"[课程小节] {co.title or co.topic} / {ch.idx + 1}.{sec.idx + 1} {sec.title}\n"
                    f"  要点：{(sec.summary or '')[:_ABSTRACT]}\n"
                    f"  section_id={sec.id}（可用 read_note 读他这一节的笔记）"
                )
                display["items"].append(
                    {"id": sec.id, "kind": "section", "title": sec.title[:80], "section_id": sec.id}
                )

        if not lines:
            return ToolResult(
                content=(
                    f"他的学习记录里没有与「{query}」相关的内容。"
                    "不要编造他学过什么 —— 如实说这部分他还没学过。"
                ),
                summary="没有相关记录",
                display=display,
            )

        head = f"「{query}」在他的学习记录里的命中（共 {len(lines)} 条）："
        return ToolResult(
            content="\n".join([head, *lines]),
            summary=f"命中 {len(lines)} 条",
            display=display,
        )

    async def _sections(self, query: str) -> list[tuple[Section, Chapter, Course]]:
        """小节结构走关键词匹配就够。

        一门课几十个小节、每节标题加要点不过百字，数据量小到不值得建向量索引；
        而课程结构恰恰是**最该被查到**的东西 —— 它带着章节递进与前置依赖，
        是这套系统里唯一结构化的知识顺序。
        """
        from app.search.tokenize import tokenize

        terms = [w for w in tokenize(query, for_query=True) if len(w) >= 2][:6] or [query]
        conds = []
        for t in terms:
            like = f"%{t}%"
            conds += [Section.title.like(like), Section.summary.like(like)]

        rows = await self._scope.session.execute(
            select(Section, Chapter, Course)
            .join(Chapter, Chapter.id == Section.chapter_id)
            .join(Course, Course.id == Chapter.course_id)
            .where(Course.user_id == self._scope.user_id, or_(*conds))
            .order_by(Chapter.idx, Section.idx)
            .limit(6)
        )
        return list(rows.all())


class ReadNote:
    """读一份笔记的**当前**全文。"""

    name = "read_note"
    description = (
        "读取这位学习者某一节的笔记全文（他自己改写过的版本）。"
        "search_memory 只给摘要，真要引用他的原话就用这个 —— "
        "笔记是他反复修改的东西，只有这里拿到的才是当前版本。"
    )

    def __init__(self, scope: UserScope) -> None:
        self._scope = scope

    def schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "id": {
                    "type": "string",
                    "description": "search_memory 返回的 id 或 section_id，两种都认",
                }
            },
            "required": ["id"],
        }

    async def run(self, **kwargs: Any) -> ToolResult:
        raw = str(kwargs.get("id") or "").strip()
        if not raw:
            return ToolResult(content="没有给 id。", summary="缺少 id")

        # 先当笔记 id 试，再当 section_id 试 —— 模型经常混用这两个
        card = await self._scope.get(Card, raw)
        if card is None or card.kind != KIND_NOTE:
            card = await self._scope.one_or_none(
                self._scope.select(Card)
                .where(
                    Card.source_section_id == raw,
                    Card.kind == KIND_NOTE,
                    Card.state != STATE_ARCHIVED,
                )
                .order_by(Card.created_at.desc())
            )

        if card is None:
            return ToolResult(
                content=(
                    "这一节他还没有写笔记。不要假装读到了内容 —— "
                    "可以基于 search_memory 里的疑问卡来判断他的理解。"
                ),
                summary="这一节还没有笔记",
            )

        # ★ 终稿优先：user_note 是他改写过的版本，ai_answer 只是当初的草稿
        body = (card.user_note or card.ai_answer or "").strip()
        edited = "（他亲手改写过）" if card.is_rewritten else "（尚未改写，仍是 AI 草稿）"
        return ToolResult(
            content=f"《{card.question}》的笔记全文 {edited}：\n\n{body[:_FULL_NOTE]}",
            summary=f"读了《{card.question}》",
            display={"card_id": card.id, "title": card.question, "edited": card.is_rewritten},
        )


class ReadOutline:
    """读课程大纲：章节递进 + 每节要点 + 前置依赖 + 学没学过。"""

    name = "read_outline"
    description = (
        "读取这位学习者某门课的大纲：章节顺序、每节要点、小节之间的前置依赖、"
        "以及他学到哪一节了。想知道「他的知识是按什么顺序搭起来的」就查这个。"
        "不传 course_id 时列出他的全部课程。"
    )

    def __init__(self, scope: UserScope) -> None:
        self._scope = scope

    def schema(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {"course_id": {"type": "string", "description": "课程 id，可省略"}},
        }

    async def run(self, **kwargs: Any) -> ToolResult:
        cid = str(kwargs.get("course_id") or "").strip()
        if not cid:
            courses = await self._scope.all(
                self._scope.select(Course).order_by(Course.created_at.desc()).limit(20)
            )
            if not courses:
                return ToolResult(content="他还没有任何课程。", summary="没有课程")
            lines = [f"- {c.title or c.topic}（course_id={c.id}）" for c in courses]
            return ToolResult(
                content="他的课程：\n" + "\n".join(lines),
                summary=f"{len(courses)} 门课",
            )

        course = await self._scope.get(Course, cid)
        if course is None:
            return ToolResult(content="没有这门课。", summary="课程不存在")

        rows = list(
            (
                await self._scope.session.execute(
                    select(Section, Chapter)
                    .join(Chapter, Chapter.id == Section.chapter_id)
                    .where(Chapter.course_id == course.id)
                    .order_by(Chapter.idx, Section.idx)
                )
            ).all()
        )
        by_id = {s.id: (s, ch) for s, ch in rows}

        lines = [f"《{course.title or course.topic}》大纲："]
        cur_ch = -1
        for sec, ch in rows:
            if ch.idx != cur_ch:
                cur_ch = ch.idx
                lines.append(f"\n第 {ch.idx + 1} 章 {ch.title}" + (f" —— {ch.summary}" if ch.summary else ""))
            mark = "✓已学完" if sec.completed_at else ("·已生成正文" if sec.content_md else "·未开始")
            deps = [
                by_id[d][0].title
                for d in (sec.prerequisite_ids or [])
                if d in by_id
            ]
            line = f"  {ch.idx + 1}.{sec.idx + 1} {sec.title} {mark}"
            if sec.summary:
                line += f"\n      要点：{sec.summary[:120]}"
            if deps:
                # 前置依赖是这套系统里唯一结构化的知识顺序，最值得告诉模型
                line += f"\n      需要先懂：{'、'.join(deps[:3])}"
            lines.append(line)

        return ToolResult(
            content="\n".join(lines)[:5000],
            summary=f"读了《{course.title or course.topic}》的大纲",
            display={"course_id": course.id, "sections": len(rows)},
        )


class MyBoundary:
    """读已知边界：他说自己会什么、半懂什么、没接触过什么。"""

    name = "my_boundary"
    description = (
        "读取这位学习者的已知边界：他已经掌握的概念、半懂的、以及开课时说过"
        "没接触过的。**讲解任何东西之前都该先看一眼** —— 已掌握的直接引用不必解释，"
        "没接触过的必须铺垫。"
    )

    def __init__(self, scope: UserScope) -> None:
        self._scope = scope

    def schema(self) -> dict[str, Any]:
        return {"type": "object", "properties": {}}

    async def run(self, **kwargs: Any) -> ToolResult:
        from app.models.user import User
        from app.services import calibrate

        user = await self._scope.session.get(User, self._scope.user_id)
        known = [str(x) for x in ((user.known_concepts if user else None) or [])]

        # 各门课校准时留下的边界：半懂与未掌握只在课程粒度上有意义
        shaky: list[str] = []
        unknown: list[str] = []
        for c in await self._scope.all(
            self._scope.select(Course).order_by(Course.created_at.desc()).limit(10)
        ):
            b = calibrate.as_any(c.boundary)
            shaky += [str(x) for x in (b.get("shaky") or [])]
            unknown += [str(x) for x in (b.get("unknown") or [])]

        if not (known or shaky or unknown):
            return ToolResult(
                content="他还没有做过边界校准，也还没学完任何小节 —— 边界未知，讲解时不要假定他会什么。",
                summary="边界未知",
            )

        parts = []
        if known:
            parts.append(f"已掌握（直接引用，不要解释）：{'、'.join(known[-40:])}")
        if shaky:
            parts.append(f"半懂（一句话回顾即可）：{'、'.join(dict.fromkeys(shaky))}")
        if unknown:
            parts.append(f"他说过没接触过（必须铺垫）：{'、'.join(dict.fromkeys(unknown))}")
        return ToolResult(
            content="他的已知边界：\n" + "\n".join(parts),
            summary=f"已掌握 {len(known)} 个概念",
            display={"known": len(known), "shaky": len(shaky), "unknown": len(unknown)},
        )


# ─────────────────────────────────────────────────────────────
# 场景化子集
# ─────────────────────────────────────────────────────────────
# 正文生成：大纲结构（前序小节、前置依赖）已经零成本拼进 prompt 了，
# read_outline 是重复的；真正只能现场取的是「他那一节笔记的全文」与
# 「他的已知边界」（边界横跨所有课程，course.boundary 只有本课那份）。
SECTION_TOOLS = ("search_memory", "read_note", "my_boundary")

# 笔记生成：只往回看自己的记录。
# 刻意**不给 web_search** —— 笔记是他自己的总结，掺进外部新内容就变成
# 「又一篇教程」，而且那部分他既没学过也没法核实，半年后重读只会疑惑
# 「这句是我想的还是它抄的」。
NOTE_TOOLS = ("search_memory", "read_note")


def memory_tools(scope: UserScope, *, only: tuple[str, ...] = ()) -> list[Tool]:
    """构造这个用户的记忆工具集。

    工具带着 scope 走 —— 所有查询都过 scope.select()，与业务代码同一条数据
    访问通道，不存在「工具绕过用户隔离」的口子。

    only 用来裁剪：给模型一件用不上的工具，它有不小的概率去调，白烧一轮
    往返（正文一轮是十几秒）。所以各场景只拿自己真需要的那几件。
    """
    tools: list[Tool] = [SearchMemory(scope), ReadNote(scope), ReadOutline(scope), MyBoundary(scope)]
    if only:
        # 用名字过滤而不是让调用方自己拼列表：名字是模型看到的契约，
        # 拼错了这里会当场少一件工具，比静默传错实例好查
        picked = [t for t in tools if t.name in only]
        unknown = set(only) - {t.name for t in tools}
        if unknown:
            raise ValueError(f"memory_tools(only=…) 里有不存在的工具名：{sorted(unknown)}")
        return picked
    return tools
