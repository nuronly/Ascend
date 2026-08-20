"""正文生成拿到的上下文：他手里已经有什么。

★ 这一层要解决的问题

  讲一节课最容易翻车的两件事：**把他已经会的又讲一遍**（他觉得被当傻子），
  **假定他会某个其实没接触过的词**（他当场卡住）。两种都会让人关掉页面。

  所以正文生成必须先弄清他手里有什么。分两条路拿：

    · 零成本的塞进 prompt —— 讲过哪些小节、本节踩在哪几节身上（前置依赖）、
      他哪几节写过笔记（路由清单）。这些都是一句 SQL 的事。
    · 昂贵/会变的留给工具 —— read_note 读他那一节笔记的**当前**全文，
      my_boundary 看跨课程的已知边界，search_memory 翻别的课。

  一句话：**索引用于发现，工具用于引用**（见 llm/tools/memory.py）。
  每一次工具调用都是一轮完整的模型往返（正文一轮十几秒），能白拿的信息
  不该拿一轮往返去换。

没装 pytest 也能跑：python tests/test_section_context.py
"""

from __future__ import annotations

import asyncio
import inspect
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.llm.base import StreamChunk  # noqa: E402
from app.llm.tools.memory import SECTION_TOOLS, memory_tools  # noqa: E402
from app.models.course import SECTION_READY, Chapter, Course, Section  # noqa: E402
from app.services import course as svc  # noqa: E402
from app.services import prompts  # noqa: E402

SENT: dict = {}
_REAL_STREAM_SIG = inspect.signature(svc.stream_chat)


class _FakeWebSearch:
    """联网工具的替身。测试机没有 tavily key，真身会被 available_tools 过滤掉，
    那样就分不清「记忆工具接上了」和「工具列表被整块替换了」。"""

    name = "web_search"
    description = "联网"

    def schema(self):
        return {"type": "object", "properties": {}}

    async def run(self, **_kw):  # pragma: no cover - 本测试不触发调用
        raise AssertionError("本测试不该真的联网")


class FakeScope:
    """正文生成用到 section_course / commit / session.execute / session.get。

    session.execute 按**选了几列**分派：3 列是小节标题（前序 / 前置依赖都长这样），
    7 列是 note_routes 那条外连接。比按语句文本猜稳，也不用把 WHERE 抄一遍。
    """

    def __init__(
        self,
        *,
        sections: list[tuple] | None = None,
        routes: list[tuple] | None = None,
        prerequisite_ids: list[str] | None = None,
    ) -> None:
        self.user_id = "u1"
        self.session = self  # type: ignore[assignment]
        self.commits = 0
        self._sections = sections or []
        self._routes = routes or []

        self.section = Section(
            id="s2",
            chapter_id="ch1",
            idx=1,
            title="缩放点积注意力",
            summary="推导缩放因子",
            key_concepts=["点积", "softmax"],
            content_md="",
            content_status="pending",
            regenerate_count=0,
            prerequisite_ids=prerequisite_ids or [],
        )
        self.chapter = Chapter(id="ch1", course_id="co1", idx=0, title="基础")
        self.course = Course(
            id="co1",
            user_id="u1",
            topic="Transformer",
            title="Transformer 入门",
            level="intermediate",
            boundary={"known": ["矩阵乘法"], "unknown": ["位置编码"]},
        )

    async def section_course(self, _sid):
        return self.section, self.chapter, self.course

    async def execute(self, stmt):
        rows = self._routes if len(stmt.selected_columns) == 7 else self._sections

        class _R:
            def all(self_inner):
                return rows

            def __iter__(self_inner):
                return iter(rows)

        return _R()

    async def get(self, _model, _oid):
        return self.chapter

    async def commit(self):
        self.commits += 1


BODY = "## 为什么要除以根号 d\n因为点积的方差随维度增长。"


def _fake_stream(body: str = BODY):
    async def gen(*a, **kw):
        _REAL_STREAM_SIG.bind(*a, **kw)  # 参数名写错要当场暴露，不能靠 **kwargs 兜住
        SENT.clear()
        SENT["messages"] = a[0] if a else kw.get("messages")
        SENT["tools"] = kw.get("tools") or []
        for i in range(0, len(body), 11):
            yield StreamChunk(delta=body[i : i + 11])
        yield StreamChunk(done=True)

    return gen


def _run(scope: FakeScope) -> list[dict]:
    real_stream, real_tools = svc.stream_chat, svc.available_tools
    svc.stream_chat = _fake_stream()  # type: ignore[assignment]
    svc.available_tools = lambda: [_FakeWebSearch()]  # type: ignore[assignment]

    async def go():
        return [ev async for ev in svc.stream_section_content(scope, "s2")]  # type: ignore[arg-type]

    try:
        return asyncio.run(go())
    finally:
        svc.stream_chat = real_stream  # type: ignore[assignment]
        svc.available_tools = real_tools  # type: ignore[assignment]


def _row(ci: int, si: int, title: str) -> tuple:
    """_prev_section_titles / _prereq_titles 的一行。"""
    return (ci, si, title)


def _route(sid: str, title: str, ci: int, si: int, *, note_id="n", edited=False) -> tuple:
    """note_routes 那条外连接的一行。"""
    return (sid, title, ["点积"], ci, si, note_id, edited)


def _user_msg() -> str:
    return SENT["messages"][1].content


# ─────────────────────────────────────────────────────────────
class Test工具接线:
    def test_联网与记忆两套工具都在(self):
        """摘掉任意一套都是静默退化：正文照样生成，只是从此不认识这个人了。"""
        _run(FakeScope())
        names = [t.name for t in SENT["tools"]]
        assert "web_search" in names
        assert set(SECTION_TOOLS) <= set(names)

    def test_不给正文用不上的工具(self):
        """大纲结构已经零成本拼进 prompt 了，read_outline 是重复的 ——
        给一件用不上的工具，模型有不小概率去调，白烧一轮十几秒的往返。"""
        _run(FakeScope())
        assert "read_outline" not in [t.name for t in SENT["tools"]]

    def test_记忆工具带着本人的_scope_走(self):
        scope = FakeScope()
        _run(scope)
        for t in SENT["tools"]:
            if t.name in SECTION_TOOLS:
                assert getattr(t, "_scope") is scope

    def test_工具名写错要当场炸(self):
        """只给字符串的话，拼错一个名字就是静默少一件工具。"""
        try:
            memory_tools(FakeScope(), only=("read_notes",))  # type: ignore[arg-type]
        except ValueError as exc:
            assert "read_notes" in str(exc)
        else:
            raise AssertionError("拼错的工具名被放过了")


class Test送进模型的上下文:
    def test_前置依赖单独给出_不混在已学过里(self):
        """已学过的是一串按时间排的标题；前置依赖说的是「这一节踩在谁身上」。
        后者可以直接引用不重讲，前者只是别重复 —— 两种约束不一样。"""
        scope = FakeScope(
            sections=[_row(0, 0, "为什么需要注意力"), _row(0, 1, "缩放点积注意力")],
            prerequisite_ids=["s1"],
        )
        _run(scope)
        msg = _user_msg()
        assert "本节的前置" in msg
        assert "不要重讲" in msg

    def test_没有前置依赖时整段不出现(self):
        _run(FakeScope(sections=[_row(0, 0, "为什么需要注意力")]))
        assert "本节的前置" not in _user_msg()

    def test_他写过笔记的小节列成路由清单(self):
        """让模型直接知道去 read_note 哪一节，省掉「先摸索一遍」那一轮。"""
        scope = FakeScope(routes=[_route("s1", "为什么需要注意力", 0, 0, edited=True)])
        _run(scope)
        msg = _user_msg()
        assert "section_id=s1" in msg
        assert "亲手改写过" in msg  # 那一节里有他自己写下的理解，最值得读

    def test_没有笔记时不铺路由清单(self):
        """正文没有「与前面的关系」这个必填节，不需要专门告诉它「他没写过笔记」。"""
        _run(FakeScope())
        assert "read_note" not in _user_msg()

    def test_已知边界照旧是最硬的约束(self):
        _run(FakeScope())
        assert "矩阵乘法" in _user_msg()

    def test_正文照样落库(self):
        """接上工具之后最容易坏的是主流程本身。"""
        scope = FakeScope()
        ev = _run(scope)
        assert scope.section.content_md.startswith("## 为什么要除以根号 d")
        assert scope.section.content_status == SECTION_READY
        assert [e["event"] for e in ev][-1] == "done"


class Test使用说明写给了模型:
    def test_system_里说清每件工具什么时候用(self):
        """描述是模型唯一的使用说明书。写不清它就不会调，或者乱调。"""
        s = prompts.SECTION_SYSTEM
        assert "read_note" in s
        assert "my_boundary" in s
        assert "search_memory" in s

    def test_写清了两头都会翻车(self):
        """只说「参考他的水平」是形容词约束，模型只能揣摩。
        必须把后果讲明：讲会的像当他傻子，讲没学的他当场卡住。"""
        s = prompts.SECTION_SYSTEM
        assert "铺垫" in s
        assert "关掉页面" in s

    def test_要求查到的东西真的用上(self):
        """查完还是讲一份通用教程，等于白烧一轮往返。"""
        assert "不要查完还是讲一份通用教程" in prompts.SECTION_SYSTEM


# ─────────────────────────────────────────────────────────────
def _独立运行() -> int:
    ok = failed = 0
    for cls in (Test工具接线, Test送进模型的上下文, Test使用说明写给了模型):
        inst = cls()
        for name in sorted(n for n in dir(inst) if n.startswith("test_")):
            try:
                getattr(inst, name)()
                ok += 1
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"  ✗ {cls.__name__}.{name}: {exc!r}")
    print(f"通过 {ok} · 失败 {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_独立运行())
