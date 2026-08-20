"""笔记卡：一节学完，卡片与原文汇流成一张永久笔记。

这一层有几条规矩，破了就会让用户不敢用：

  1. **AI 原稿与用户终稿分开存**（ai_answer / user_note）。
     user_note 初始必须留空 —— 预填一份原稿的话 is_rewritten 立刻为真，
     「己见率」这个指标就被自动生成的内容注水了。
  2. **重新生成绝不覆盖**：force 会新建一张并排放着。用户写过的东西神圣。
  3. **笔记卡不能把自己汇流进去**，也不能出现在卡片空间那张画布上。
  4. **己见要原样进 prompt**，并明确要求模型逐字照抄 —— 那是用户的思考，
     不是模型的素材。
  5. 汇流要**收敛**：提了 30 个问题的人不该得到 30 段摘要。

没装 pytest 也能跑：python tests/test_note.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.core.types import utcnow  # noqa: E402
from app.llm.base import StreamChunk  # noqa: E402
from app.models.card import (  # noqa: E402
    KIND_CARD,
    KIND_NOTE,
    STATE_DRAFT,
    STATE_VAULT,
    Card,
)
from app.models.course import Chapter, Course, Section  # noqa: E402
from app.services import note as svc  # noqa: E402
from app.services import prompts  # noqa: E402


def _card(**kw) -> Card:
    base = dict(
        id=kw.pop("id", "c"),
        user_id="u1",
        kind=KIND_CARD,
        state=STATE_DRAFT,
        is_rewritten=False,
        selected_text="softmax",
        question="为什么要除以根号 d？",
        ai_answer="因为点积方差随维度增长",
        user_note="",
        summary="",
        created_at=utcnow(),
    )
    base.update(kw)
    return Card(**base)  # type: ignore[arg-type]


class FakeScope:
    """note 服务只用到 section_course / select / all / one_or_none / add / commit。"""

    def __init__(self, cards: list[Card], existing: Card | None = None) -> None:
        self.user_id = "u1"
        self._cards = cards
        self._existing = existing
        self.added: list[object] = []
        self.commits = 0

        self.section = Section(
            id="s1",
            chapter_id="ch1",
            idx=1,
            title="QKV 的来历",
            summary="从检索的类比讲起",
            content_md="## 正文\n注意力用点积算相似度。",
            key_concepts=["QKV", "点积"],
        )
        self.chapter = Chapter(id="ch1", course_id="co1", idx=0, title="基础")
        self.course = Course(
            id="co1",
            user_id="u1",
            topic="Transformer",
            title="Transformer 入门",
            boundary={"unknown": ["位置编码"]},
        )

    async def section_course(self, _sid):
        return self.section, self.chapter, self.course

    def select(self, *_a, **_kw):
        class _Q:
            def where(self, *_a, **_kw):
                return self

            def order_by(self, *_a, **_kw):
                return self

        return _Q()

    async def all(self, _stmt):
        return list(self._cards)

    async def one_or_none(self, _stmt):
        return self._existing

    def add(self, obj):
        self.added.append(obj)

    async def commit(self):
        self.commits += 1

    @property
    def notes(self) -> list[Card]:
        return [o for o in self.added if isinstance(o, Card) and o.kind == KIND_NOTE]


BODY = "## 这一节解决了什么问题\n点积注意力为什么要缩放。\n\n## 我的理解\n\n## 我还没搞懂的\n"


def _fake_stream(body: str = BODY, *, reasoning: str = "", boom: Exception | None = None):
    async def gen(*_a, **_kw):
        if reasoning:
            yield StreamChunk(reasoning=reasoning)
        if boom is not None:
            raise boom
        for i in range(0, len(body), 9):
            yield StreamChunk(delta=body[i : i + 9])
        yield StreamChunk(done=True)

    return gen


def _run(scope: FakeScope, *, force: bool = False, stream=None) -> list[dict]:
    real = svc.stream_chat
    svc.stream_chat = stream or _fake_stream()  # type: ignore[assignment]

    async def go():
        return [ev async for ev in svc.stream_section_note(scope, "s1", force=force)]  # type: ignore[arg-type]

    try:
        return asyncio.run(go())
    finally:
        svc.stream_chat = real  # type: ignore[assignment]


def _of(events: list[dict], name: str) -> list[dict]:
    return [e["data"] for e in events if e["event"] == name]


# ─────────────────────────────────────────────────────────────
class Test汇流优先级:
    def test_写过己见的排最前(self):
        rows = [
            _card(id="a"),
            _card(id="b", state=STATE_VAULT),
            _card(id="c", is_rewritten=True, user_note="我觉得是为了控方差"),
        ]
        assert [c.id for c in svc.rank_sources(rows)] == ["c", "b", "a"]

    def test_超上限时砍掉的是随手问的那些(self):
        rows = [_card(id=f"d{i}") for i in range(20)]
        rows.append(_card(id="mine", is_rewritten=True))
        picked = svc.rank_sources(rows)
        assert len(picked) == svc.MAX_CARDS
        assert picked[0].id == "mine"  # 己见卡一定在

    def test_原有顺序在同档内保持稳定(self):
        rows = [_card(id="x"), _card(id="y"), _card(id="z")]
        assert [c.id for c in svc.rank_sources(rows)] == ["x", "y", "z"]


class Test生成:
    def test_事件顺序_先给汇流清单再流正文(self):
        """start 里的 sources 就是动画的粒子 —— 它必须在正文之前到。"""
        scope = FakeScope([_card(id="a"), _card(id="b")])
        ev = _run(scope)
        kinds = [e["event"] for e in ev]
        assert kinds[0] == "start"
        assert kinds.index("start") < kinds.index("delta")
        assert kinds[-1] == "done"
        assert len(_of(ev, "start")[0]["sources"]) == 2

    def test_落库时原稿与终稿分开_终稿留空(self):
        """预填终稿会让 is_rewritten 立刻为真，把「己见率」注水。"""
        scope = FakeScope([_card()])
        _run(scope)
        note = scope.notes[0]
        assert note.kind == KIND_NOTE
        assert note.ai_answer.startswith("## 这一节解决了什么问题")
        assert note.user_note == ""
        assert note.is_rewritten is False
        assert note.state == STATE_DRAFT  # 用户点保存才进仓
        assert note.source_section_id == "s1"
        assert note.question == "1.2 QKV 的来历"

    def test_思维链也透出来(self):
        scope = FakeScope([])
        ev = _run(scope, stream=_fake_stream(reasoning="先看他问过什么" * 6))
        assert _of(ev, "thinking")

    def test_已有笔记则回放_不调模型(self):
        existing = _card(
            id="n1", kind=KIND_NOTE, ai_answer="原稿", user_note="我改过的", is_rewritten=True
        )
        scope = FakeScope([_card()], existing=existing)

        def explode(*_a, **_kw):
            raise AssertionError("已有笔记还去调模型了")

        ev = _run(scope, stream=explode)
        cached = _of(ev, "cached")[0]
        assert cached["content"] == "我改过的"  # 展示走终稿
        assert cached["ai_draft"] == "原稿"  # 原稿一直留着
        assert not scope.notes  # 没有新建

    def test_重新生成不覆盖_而是另建一张(self):
        """用户写过的东西神圣 —— 新版并排放着，由他自己挑。"""
        existing = _card(id="n1", kind=KIND_NOTE, ai_answer="旧原稿", user_note="我的旧笔记")
        scope = FakeScope([_card()], existing=existing)
        _run(scope, force=True)
        assert len(scope.notes) == 1
        assert scope.notes[0].id != "n1"
        assert existing.user_note == "我的旧笔记"  # 旧的一个字没动

    def test_空输出不落库(self):
        scope = FakeScope([_card()])
        ev = _run(scope, stream=_fake_stream(body="   "))
        assert _of(ev, "error")
        assert not scope.notes

    def test_模型失败也给出错误事件(self):
        scope = FakeScope([_card()])
        ev = _run(scope, stream=_fake_stream(boom=RuntimeError("上游 500")))
        assert "上游 500" in _of(ev, "error")[0]["message"]
        assert not scope.notes

    def test_没有卡片也能生成(self):
        """只读了正文、一个问题都没提的人，也该拿到一张笔记。"""
        scope = FakeScope([])
        ev = _run(scope)
        assert _of(ev, "start")[0]["sources"] == []
        assert scope.notes


class Test送进模型的素材:
    def _msg(self, cards: list[dict]) -> str:
        return prompts.note_user(
            course_title="Transformer",
            chapter_title="基础",
            section_title="QKV",
            content_md="正文正文",
            key_concepts=["QKV"],
            cards=cards,
            unknown=["位置编码"],
        )

    def test_己见要标成必须逐字照抄(self):
        """否则模型会顺手把用户的话「润色」掉 —— 那是他的思考，不是素材。"""
        msg = self._msg([{"question": "q", "user_note": "我觉得是为了控方差"}])
        assert "我觉得是为了控方差" in msg
        assert "逐字照抄" in msg

    def test_开课说不会的概念要带进去(self):
        assert "位置编码" in self._msg([])

    def test_没有卡片时明确告诉模型省略那一节(self):
        assert "没有提问" in self._msg([])

    def test_留白要求写死在_system_里(self):
        """「我的理解」「我还没搞懂的」必须留空 —— 那两处是最值钱的地方。"""
        assert "我的理解" in prompts.NOTE_SYSTEM
        assert "我还没搞懂的" in prompts.NOTE_SYSTEM
        assert "留空" in prompts.NOTE_SYSTEM
        # 空话禁令：这是笔记质量的下限
        assert "能被反驳" in prompts.NOTE_SYSTEM


# ─────────────────────────────────────────────────────────────
def _独立运行() -> int:
    ok = failed = 0
    for cls in (Test汇流优先级, Test生成, Test送进模型的素材):
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
