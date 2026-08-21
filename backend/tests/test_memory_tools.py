"""记忆工具：让任何 AI 场景都能查这个人的学习记录。

★ 这一层的立意（见 llm/tools/memory.py 的模块注释）

  **索引用于发现，工具用于引用。** 向量与全文索引负责路由（「第 3 章那份笔记
  可能相关」），工具负责取当前真相（read_note 拿到此刻的全文）。
  笔记是用户反复改写的东西，靠向量保持同步必然有一致性窗口，而且摘要截断
  恰好会砍掉后半的「我的理解」——最值钱的部分。

  所以这里钉四件事：
    1. read_note 必须返回**用户终稿**（user_note），不是 AI 原稿
    2. 没有笔记时必须如实说，不许假装读到了内容
    3. section_id 与笔记 id 都要认（模型经常混用）
    4. 检索不到时必须让模型「如实说没学过」，而不是留空让它自己编

没装 pytest 也能跑：python tests/test_memory_tools.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.core.types import utcnow  # noqa: E402
from app.llm.tools import memory as mem  # noqa: E402
from app.models.card import KIND_CARD, KIND_NOTE, STATE_ARCHIVED, Card  # noqa: E402
from app.models.course import Chapter, Course, Section  # noqa: E402


def _note(**kw) -> Card:
    base = dict(
        id="n1",
        user_id="u1",
        kind=KIND_NOTE,
        question="1.2 QKV 的来历",
        ai_answer="## 核心机制\nAI 原来写的草稿。",
        user_note="## 核心机制\n我自己改写过的终稿。",
        is_rewritten=True,
        summary="",
        selected_text="QKV 的来历",
        source_section_id="s1",
        state="vault",
        created_at=utcnow(),
    )
    base.update(kw)
    return Card(**base)  # type: ignore[arg-type]


def _card(**kw) -> Card:
    base = dict(
        id="c1",
        user_id="u1",
        kind=KIND_CARD,
        question="为什么要除以根号 d？",
        ai_answer="因为点积方差随维度增长",
        user_note="",
        summary="缩放点积注意力的方差控制",
        is_rewritten=False,
        selected_text="softmax",
        source_section_id="s1",
        state="vault",
        created_at=utcnow(),
    )
    base.update(kw)
    return Card(**base)  # type: ignore[arg-type]


class FakeScope:
    """记忆工具只用 get / one_or_none / all / select / session.execute / scalars。"""

    def __init__(
        self,
        *,
        note: Card | None = None,
        cards: list[Card] | None = None,
        sections: list[tuple] | None = None,
        noted: set[str] | None = None,
    ) -> None:
        self.user_id = "u1"
        self._note = note
        self._cards = cards or []
        self._sections = sections or []
        self._noted = noted or set()
        self.session = self  # type: ignore[assignment]

    # ── scope 接口 ──
    def select(self, *_a, **_kw):
        class _Q:
            def where(self, *_a, **_kw):
                return self

            def order_by(self, *_a, **_kw):
                return self

            def limit(self, *_a, **_kw):
                return self

        return _Q()

    async def get(self, _model, oid):
        if self._note is not None and oid == self._note.id:
            return self._note
        return None

    async def one_or_none(self, _stmt):
        # 真身那条语句带 kind=note 与 state != archived。替身不照做的话，
        # 「归档过的不给读」这类语义根本测不出来
        if self._note is None:
            return None
        if self._note.kind != KIND_NOTE or self._note.state == STATE_ARCHIVED:
            return None
        return self._note

    async def all(self, _stmt):
        return []

    # ── session 接口（小节结构查询走它）──
    async def execute(self, _stmt):
        rows = list(self._sections)

        class _R:
            def all(self_inner):
                return rows

        return _R()

    async def scalars(self, _stmt):
        """哪几节有笔记。"""
        return list(self._noted)


def _run(tool, **kw):
    return asyncio.run(tool.run(**kw))


# ─────────────────────────────────────────────────────────────
class Test读笔记:
    def test_读到的是用户终稿_不是_ai_原稿(self):
        """笔记的价值在于他改写过的那一版；拿原稿糊弄等于抹掉他的工作。"""
        r = _run(mem.ReadNote(FakeScope(note=_note())), id="n1")
        assert "我自己改写过的终稿" in r.content
        assert "AI 原来写的草稿" not in r.content
        assert "他亲手改写过" in r.content

    def test_还没改写时如实说明这是_ai_草稿(self):
        r = _run(
            mem.ReadNote(FakeScope(note=_note(user_note="", is_rewritten=False))),
            id="n1",
        )
        assert "AI 原来写的草稿" in r.content
        assert "仍是 AI 草稿" in r.content

    def test_section_id_也能读到(self):
        """模型经常把 section_id 当笔记 id 传 —— 两种都得认。"""
        r = _run(mem.ReadNote(FakeScope(note=_note())), id="s1")
        assert "我自己改写过的终稿" in r.content

    def test_没有笔记时不许假装读到了(self):
        r = _run(mem.ReadNote(FakeScope(note=None)), id="s9")
        assert "还没有写笔记" in r.content
        assert "不要假装" in r.content

    def test_空_id_不炸(self):
        assert "没有给 id" in _run(mem.ReadNote(FakeScope()), id="").content

    def test_归档过的不给读(self):
        """归档是他主动扔掉的动作，翻出来当依据等于不认这个动作。"""
        r = _run(mem.ReadNote(FakeScope(note=_note(state="archived"))), id="n1")
        assert "我自己改写过的终稿" not in r.content


class Test读疑问卡:
    """★ 服务器上真跑一次才发现的：模型拿疑问卡的 id 来调 read_note。

    它没做错什么 —— search_memory 只给一行摘要，它想看全文，手里只有这一件
    工具。原来连着三次拿回「这一节还没有笔记」，三次白烧。现在给什么读什么。
    """

    def test_卡片_id_也能读到全文(self):
        r = _run(mem.ReadNote(FakeScope(note=_card())), id="c1")
        assert "因为点积方差随维度增长" in r.content
        assert "softmax" in r.content  # 他划中的那个词
        assert "疑问卡" in r.content

    def test_己见要标成用他的原话(self):
        """卡片里最值钱的是他自己写的那段，也是判断他懂到哪一层唯一可靠的依据。"""
        r = _run(
            mem.ReadNote(FakeScope(note=_card(user_note="我觉得是为了控方差"))),
            id="c1",
        )
        assert "我觉得是为了控方差" in r.content
        assert "他的原话" in r.content

    def test_没有解答的卡要说清那是他的空白(self):
        """问了就走的卡最容易被当成「他学过这个」—— 恰恰相反。"""
        r = _run(mem.ReadNote(FakeScope(note=_card(ai_answer="", user_note=""))), id="c1")
        assert "没有解答" in r.content
        assert "不要当成他已经懂了" in r.content


class Test检索记忆:
    def _tool(self, cards: list[Card]):
        scope = FakeScope(cards=cards)
        tool = mem.SearchMemory(scope)

        # 召回走 brain.retrieve，这里替身掉它 —— 本测试只关心工具的输出契约
        async def fake_retrieve(_scope, _query, **_kw):
            return cards

        import app.services.brain as brain

        self._real = brain.retrieve
        brain.retrieve = fake_retrieve  # type: ignore[assignment]
        return tool

    def _restore(self):
        import app.services.brain as brain

        brain.retrieve = self._real  # type: ignore[assignment]

    def test_笔记要标出可读全文(self):
        tool = self._tool([_note()])
        try:
            r = _run(tool, query="QKV")
        finally:
            self._restore()
        assert "[笔记]" in r.content
        assert "read_note" in r.content  # 告诉模型下一步能干什么
        assert r.display["items"][0]["kind"] == KIND_NOTE

    def test_疑问卡也给全文入口(self):
        tool = self._tool([_card()])
        try:
            r = _run(tool, query="softmax")
        finally:
            self._restore()
        assert "[疑问卡]" in r.content
        assert "缩放点积注意力的方差控制" in r.content
        assert "read_note" in r.content  # 有内容就该能读全文

    def test_没有答案的卡如实说_而不是留一行空摘要(self):
        """留空的话模型只能去 read_note 撞运气 —— 而这种卡本来就没有全文。"""
        tool = self._tool([_card(summary="", ai_answer="", user_note="")])
        try:
            r = _run(tool, query="softmax")
        finally:
            self._restore()
        assert "没有留下答案" in r.content
        assert "read_note" not in r.content

    def test_按_kind_过滤(self):
        tool = self._tool([_note(), _card()])
        try:
            only_note = _run(tool, query="x", kind="note")
            only_card = _run(tool, query="x", kind="card")
        finally:
            self._restore()
        assert "[疑问卡]" not in only_note.content
        assert "[笔记]" not in only_card.content

    def test_检索不到时明确要求别编(self):
        """留空会让模型拿通用知识兜底，并伪装成他学过的东西 —— 那是最坏的失败。"""
        tool = self._tool([])
        try:
            r = _run(tool, query="他没学过的东西")
        finally:
            self._restore()
        assert "没有" in r.content
        assert "不要编造" in r.content

    def test_空检索词不查库(self):
        tool = self._tool([_note()])
        try:
            r = _run(tool, query="   ")
        finally:
            self._restore()
        assert "检索词为空" in r.summary


class Test小节命中要如实说有没有笔记:
    """★ 路由层给错指引，比不给指引更浪费。

    这条是在服务器上真跑一次笔记生成时发现的：原来对每一个小节命中都写
    「可用 read_note 读他这一节的笔记」，模型老实照做，连着拿回三次
    「这一节还没有笔记」—— 三次注定落空的工具调用，占掉了本该用来
    读真有内容那一节的轮次。
    """

    def _search(self, *, noted: set[str]):
        sec = Section(id="s1", chapter_id="ch1", idx=0, title="为什么需要注意力", summary="长程依赖")
        ch = Chapter(id="ch1", course_id="co1", idx=0, title="入门")
        co = Course(id="co1", user_id="u1", topic="Transformer", title="Transformer 入门")
        scope = FakeScope(sections=[(sec, ch, co)], noted=noted)
        tool = mem.SearchMemory(scope)

        async def fake_retrieve(_scope, _query, **_kw):
            return []

        import app.services.brain as brain

        real = brain.retrieve
        brain.retrieve = fake_retrieve  # type: ignore[assignment]
        try:
            return _run(tool, query="注意力", kind="section")
        finally:
            brain.retrieve = real  # type: ignore[assignment]

    def test_有笔记才给_read_note_的入口(self):
        r = self._search(noted={"s1"})
        assert "可用 read_note 读全文" in r.content
        assert "section_id=s1" in r.content

    def test_没笔记就明确说不必读(self):
        r = self._search(noted=set())
        assert "不必 read_note" in r.content
        # 连 section_id 都不给：给了模型就会去试
        assert "section_id=s1" not in r.content


class Test工具契约:
    def test_四个工具都齐(self):
        names = {t.name for t in mem.memory_tools(FakeScope())}  # type: ignore[arg-type]
        assert names == {"search_memory", "read_note", "read_outline", "my_boundary"}

    def test_schema_是合法的_json_schema(self):
        for t in mem.memory_tools(FakeScope()):  # type: ignore[arg-type]
            s = t.schema()
            assert s["type"] == "object"
            assert isinstance(s.get("properties"), dict)

    def test_描述里必须写清什么时候该用(self):
        """描述是模型唯一的使用说明书 —— 写不清它就不会调，或者乱调。"""
        by = {t.name: t.description for t in mem.memory_tools(FakeScope())}  # type: ignore[arg-type]
        assert "read_note" in by["search_memory"]  # 指出下一步
        assert "当前" in by["read_note"]  # 强调实时性
        assert "前置依赖" in by["read_outline"]
        assert "铺垫" in by["my_boundary"]

    def test_工具带着_scope_走(self):
        """用户隔离不能靠工具自觉：所有查询都过 scope，与业务代码同一条通道。"""
        scope = FakeScope()
        for t in mem.memory_tools(scope):  # type: ignore[arg-type]
            assert getattr(t, "_scope") is scope


class Test场景化子集:
    """★ 能零成本塞进 prompt 的信息，别拿一轮工具调用去换。

    每次工具调用都是一次完整的模型往返（正文一轮十几秒）。给模型一件用不上的
    工具，它有不小概率去调 —— 白烧一轮。所以各场景只拿自己真需要的那几件。
    """

    def test_正文不给_read_outline(self):
        """章节顺序与前置依赖已经零成本拼进 prompt 了，再给一件是重复的。"""
        assert "read_outline" not in mem.SECTION_TOOLS
        assert "read_note" in mem.SECTION_TOOLS
        assert "my_boundary" in mem.SECTION_TOOLS  # 边界跨课程，course.boundary 只有本课那份

    def test_笔记只往回看自己的记录(self):
        """笔记是他自己的总结。掺进外部内容，半年后重读只会疑惑
        「这句是我想的还是它抄的」。"""
        assert set(mem.NOTE_TOOLS) == {"search_memory", "read_note"}
        assert "web_search" not in mem.NOTE_TOOLS

    def test_按名字裁剪(self):
        got = mem.memory_tools(FakeScope(), only=mem.NOTE_TOOLS)  # type: ignore[arg-type]
        assert [t.name for t in got] == ["search_memory", "read_note"]

    def test_名字写错当场炸_而不是静默少一件(self):
        """名字是模型看到的契约。拼错了静默返回空列表，表现成「它从来不查记忆」。"""
        try:
            mem.memory_tools(FakeScope(), only=("read_notes",))  # type: ignore[arg-type]
        except ValueError as exc:
            assert "read_notes" in str(exc)
        else:
            raise AssertionError("拼错的工具名被放过了")


# ─────────────────────────────────────────────────────────────
def _独立运行() -> int:
    ok = failed = 0
    for cls in (
        Test读笔记,
        Test读疑问卡,
        Test检索记忆,
        Test小节命中要如实说有没有笔记,
        Test工具契约,
        Test场景化子集,
    ):
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
