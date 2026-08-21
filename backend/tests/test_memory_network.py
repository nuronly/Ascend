"""记忆网络：骨架是课程结构，不是用户手建的连线。

★ 为什么要重做

  原来的边只有两种来源：追问的父子链，和用户在卡片空间里手动拉的线。
  线上全库总共 3 条 —— 于是这张网实际画的是「你手动拉过几根线」：
  孤岛率 33%，连唯一那张永久笔记都被判成「孤岛（濒临遗忘）」，
  画成最小最暗的一点。系统里最有价值的单元，视觉上最不值钱。

★ 结构本身就是知识单元，不是脚手架

  学完一节课就是获得了一块知识，跟划词提问获得一块知识是同一件事，
  而且正文是主干、卡片只是旁支。原来只画卡片，于是一个认真读完十二节
  但不怎么划词的人，网络里几乎是空的 —— 他明明学了很多。

★ 这里钉六件事

  1. 五类节点都在（课程/章/节/卡/笔记），结构也算神经元
  2. **卡片 id 不能加前缀** —— 第二大脑召回点亮走的就是裸卡片 id
  3. 边数是 O(n)：卡片挂小节、小节挂章、章连成链。绝不能同章两两相连
  4. 不再有孤岛：每个节点都必然连在树上
  5. 未生成正文的小节 learned=False（待点亮，不是濒临遗忘）
  6. 卡片超限时留下的是**最新**的，不是最老的

没装 pytest 也能跑：python tests/test_memory_network.py
"""

from __future__ import annotations

import asyncio
import sys
from datetime import timedelta
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.core.types import utcnow  # noqa: E402
from app.models.card import KIND_CARD, KIND_NOTE, STATE_VAULT, Card  # noqa: E402
from app.models.course import Chapter, Course, Section  # noqa: E402
from app.services import brain as svc  # noqa: E402

NOW = utcnow()


def _course(**kw) -> Course:
    base = dict(
        id="co1",
        user_id="u1",
        topic="Transformer",
        title="Transformer 注意力机制",
        description="从检索类比讲到工程取舍",
        created_at=NOW - timedelta(days=10),
        updated_at=NOW,
    )
    base.update(kw)
    return Course(**base)  # type: ignore[arg-type]


def _chapter(cid: str, idx: int, title: str) -> Chapter:
    return Chapter(id=cid, course_id="co1", idx=idx, title=title, summary="")


def _section(sid: str, chapter_id: str, idx: int, title: str, **kw) -> Section:
    base = dict(
        id=sid,
        chapter_id=chapter_id,
        idx=idx,
        title=title,
        summary="要点",
        content_md=None,
        completed_at=None,
        key_concepts=["点积"],
        regenerate_count=0,
        generated_at=None,
    )
    base.update(kw)
    return Section(**base)  # type: ignore[arg-type]


def _card(**kw) -> Card:
    base = dict(
        id="c1",
        user_id="u1",
        kind=KIND_CARD,
        state=STATE_VAULT,
        question="为什么除以根号 d？",
        ai_answer="控制方差",
        user_note="",
        summary="缩放点积",
        selected_text="softmax",
        is_rewritten=False,
        depth=0,
        touch_count=0,
        parent_card_id=None,
        source_section_id="s1",
        concept_tags=[],
        created_at=NOW - timedelta(days=1),
        updated_at=NOW,
    )
    base.update(kw)
    return Card(**base)  # type: ignore[arg-type]


class FakeScope:
    """memory_network 用 session.execute（课程结构）/ scalars（有笔记的小节）
    / scope.all（卡片、复习状态、连线）。

    scope.all 按语句选的**表**分派：Card / ReviewState / CardLink 三种。
    """

    def __init__(
        self,
        *,
        rows: list[tuple] | None = None,
        cards: list[Card] | None = None,
        noted: set[str] | None = None,
    ) -> None:
        self.user_id = "u1"
        self.session = self  # type: ignore[assignment]
        self._rows = rows or []
        self._cards = cards or []
        self._noted = noted or set()
        self.limits: list[int | None] = []

    # ── session ──
    async def execute(self, _stmt):
        rows = list(self._rows)

        class _R:
            def all(self_inner):
                return rows

        return _R()

    async def scalars(self, _stmt):
        return list(self._noted)

    # ── scope ──
    def select(self, model, *cols):
        from sqlalchemy import select as _select

        stmt = _select(*cols) if cols else _select(model)
        return stmt

    async def all(self, stmt):
        text = str(stmt)
        if "card_links" in text:
            return []
        if "review_states" in text:
            return []
        # 记下 limit，用来验证「留下的是最新的」
        limit = getattr(stmt, "_limit", None)
        self.limits.append(limit)
        # 真身是 order_by(created_at.desc()).limit(n) —— 替身必须照做，
        # 否则「留下最新的、再按升序返回」这条根本测不出来
        rows = sorted(self._cards, key=lambda c: c.created_at, reverse=True)
        return rows[:limit] if limit else rows


def _net(**kw) -> dict:
    scope = FakeScope(**kw)
    return asyncio.run(svc.memory_network(scope))  # type: ignore[arg-type]


def _ids(net: dict, kind: str) -> list[str]:
    return [n["id"] for n in net["neurons"] if n["kind"] == kind]


def _edges(net: dict, kind: str) -> list[tuple[str, str]]:
    return [(s["a"], s["b"]) for s in net["synapses"] if s["kind"] == kind]


# 一门课：2 章，第 1 章 2 节（1.1 学完、1.2 没生成），第 2 章 1 节
def _tree() -> list[tuple]:
    co = _course()
    ch1 = _chapter("ch1", 0, "基础")
    ch2 = _chapter("ch2", 1, "多头")
    return [
        (co, ch1, _section("s1", "ch1", 0, "为什么需要注意力", content_md="正文", completed_at=NOW)),
        (co, ch1, _section("s2", "ch1", 1, "缩放点积")),  # 没生成正文
        (co, ch2, _section("s3", "ch2", 0, "单头局限", content_md="正文")),
    ]


# ─────────────────────────────────────────────────────────────
class Test五类节点:
    def test_结构也算神经元(self):
        """认真读完十二节但不划词的人，网络不该是空的。"""
        net = _net(rows=_tree(), cards=[])
        assert _ids(net, "course") == ["co:co1"]
        assert set(_ids(net, "chapter")) == {"ch:ch1", "ch:ch2"}
        assert set(_ids(net, "section")) == {"sec:s1", "sec:s2", "sec:s3"}
        assert net["stats"]["by_kind"]["section"] == 3

    def test_一张卡都没有也有网络(self):
        net = _net(rows=_tree(), cards=[])
        assert net["neurons"]
        assert net["synapses"]

    def test_笔记和卡片分开计数(self):
        net = _net(
            rows=_tree(),
            cards=[_card(), _card(id="n1", kind=KIND_NOTE, question="1.1 为什么需要注意力")],
        )
        assert net["stats"]["by_kind"]["card"] == 1
        assert net["stats"]["by_kind"]["note"] == 1


class Test卡片_id_不能动:
    def test_卡片用裸_id(self):
        """★ 第二大脑召回点亮走的就是卡片 id（recall 事件里发的是 card.id）。
        加前缀等于从此再也点不亮 —— 而且不会报错，只是永远没反应。"""
        net = _net(rows=_tree(), cards=[_card(id="abc123")])
        assert "abc123" in _ids(net, "card")

    def test_结构节点带前缀_避免与卡片撞_id(self):
        """section.id 与 card.id 都是 uuid hex，同一个命名空间里必须分开。"""
        net = _net(rows=_tree())
        for kind, prefix in (("course", "co:"), ("chapter", "ch:"), ("section", "sec:")):
            got = _ids(net, kind)
            assert got, kind
            assert all(i.startswith(prefix) for i in got), kind


class Test边是线性的:
    def test_卡片挂在小节上_小节挂在章上_章连成链(self):
        net = _net(rows=_tree(), cards=[_card(id="c1", source_section_id="s1")])
        assert ("sec:s1", "c1") in _edges(net, "origin")
        assert ("ch:ch1", "sec:s1") in _edges(net, "structure")
        assert ("ch:ch1", "ch:ch2") in _edges(net, "spine")
        assert ("co:co1", "ch:ch1") in _edges(net, "structure")

    def test_绝不同章两两相连(self):
        """一章 20 张卡就是 190 条边，力导向会糊成一团黑。"""
        cards = [_card(id=f"c{i}", source_section_id="s1") for i in range(20)]
        net = _net(rows=_tree(), cards=cards)
        # 20 卡 + 3 节 + 2 章 + 1 课 = 26 节点；边应该在同一量级，不是 O(n²)
        assert len(net["synapses"]) < len(net["neurons"]) * 2

    def test_子卡不重复挂到小节上(self):
        """子卡靠父子链挂上去，再连一条到小节就是重复计边。"""
        net = _net(
            rows=_tree(),
            cards=[
                _card(id="root", source_section_id="s1"),
                _card(id="kid", source_section_id="s1", parent_card_id="root", depth=1),
            ],
        )
        assert ("sec:s1", "kid") not in _edges(net, "origin")
        assert ("root", "kid") in _edges(net, "parent")

    def test_每条边的两端都真实存在(self):
        """悬空的边在力导向里会被静默丢掉，表现成「连线时有时无」。"""
        net = _net(rows=_tree(), cards=[_card(id="c1", source_section_id="s1")])
        ids = {n["id"] for n in net["neurons"]}
        for s in net["synapses"]:
            assert s["a"] in ids, s
            assert s["b"] in ids, s


class Test不再有孤岛:
    def test_每个节点都连在树上(self):
        """原来孤岛率 33%，笔记卡必然是孤岛（没有父卡、没有子卡、没人连它）。"""
        net = _net(
            rows=_tree(),
            cards=[
                _card(id="c1", source_section_id="s1"),
                _card(id="n1", kind=KIND_NOTE, source_section_id="s1"),
            ],
        )
        for n in net["neurons"]:
            assert n["degree"] > 0, n["id"]

    def test_孤岛指标已撤掉(self):
        """留着一个恒为 0 的指标比撤掉更糟：它会让人以为这件事还在被度量。"""
        assert "isolated" not in net_stats(_net(rows=_tree()))
        assert "isolation_rate" not in net_stats(_net(rows=_tree()))

    def test_笔记比卡片更该被看见(self):
        """笔记是人工改写过、有完整语境的阅读单元，不能和碎卡同权。"""
        net = _net(rows=_tree(), cards=[_card(id="n1", kind=KIND_NOTE, source_section_id="s1")])
        note = next(n for n in net["neurons"] if n["kind"] == KIND_NOTE)
        assert note["degree"] > 0


def net_stats(net: dict) -> dict:
    return net["stats"]


class Test点亮与牢固度:
    def test_没生成正文的小节是待点亮(self):
        """「还没走到这里」和「快忘了」是两件事，不能共用一种视觉。"""
        net = _net(rows=_tree())
        by_id = {n["id"]: n for n in net["neurons"]}
        assert by_id["sec:s2"]["learned"] is False
        assert by_id["sec:s2"]["strength"] == 0.0
        assert by_id["sec:s1"]["learned"] is True

    def test_学完的比只读过的牢(self):
        net = _net(rows=_tree())
        by_id = {n["id"]: n for n in net["neurons"]}
        assert by_id["sec:s1"]["strength"] > by_id["sec:s3"]["strength"]

    def test_收成过笔记的那一节最牢(self):
        """亲手写过的地方记得最牢，这是这套系统里最该被奖励的行为。"""
        plain = _net(rows=_tree())
        noted = _net(rows=_tree(), noted={"s1"})
        a = next(n for n in plain["neurons"] if n["id"] == "sec:s1")
        b = next(n for n in noted["neurons"] if n["id"] == "sec:s1")
        assert b["strength"] > a["strength"]
        assert b["rewritten"] is True  # 前端据此描一圈己见色

    def test_章和课的牢固度是聚合出来的(self):
        net = _net(rows=_tree())
        by_id = {n["id"]: n for n in net["neurons"]}
        # ch1 = (学完 0.7 + 没开始 0) / 2
        assert 0.3 < by_id["ch:ch1"]["strength"] < 0.4
        assert 0 < by_id["co:co1"]["strength"] < 1

    def test_已点亮的数才是_我有多少知识(self):
        net = _net(rows=_tree())
        assert net["stats"]["neurons"] == 6  # 1 课 + 2 章 + 3 节
        assert net["stats"]["lit"] == 5  # s2 还没走到，它所在的章仍算点亮

    def test_平均牢固度只算已点亮的(self):
        """把没走到的地方算进分母，指标会随「课越开越多」而下降 —— 荒谬。"""
        net = _net(rows=_tree())
        assert net["stats"]["avg_strength"] > 0


class Test截断方向:
    def test_卡片留最新的而不是最老的(self):
        """原来 order_by(created_at).limit(800) 拿的是最老一批 ——
        超过上限之后，新学的东西反而不在网络里。"""
        cards = [
            _card(id=f"c{i}", created_at=NOW - timedelta(days=9 - i), source_section_id="s1")
            for i in range(10)
        ]
        scope = FakeScope(rows=_tree(), cards=cards)
        net = asyncio.run(svc.memory_network(scope, card_limit=3))  # type: ignore[arg-type]
        assert scope.limits[-1] == 3
        # c9 最新、c0 最老 —— 留下的必须是尾三张
        assert _ids(net, "card") == ["c7", "c8", "c9"]

    def test_超限时丢未点亮的小节_但章上的进度还在(self):
        """力导向是 O(n²)。20 门课 × 40 节 + 900 张卡 = 140 万次配对/帧，
        画面直接卡死。丢未点亮的小节不会失真 —— 它们所属的章还在，
        章上带着「已学 2/24 节」，「还有多少没走」这个信息不丢。"""
        co = _course()
        ch = _chapter("ch1", 0, "基础")
        rows = [(co, ch, _section("s0", "ch1", 0, "学过的", content_md="正文"))]
        rows += [(co, ch, _section(f"u{i}", "ch1", i + 1, f"没走到 {i}")) for i in range(40)]
        scope = FakeScope(rows=rows, cards=[])
        real = svc.NODE_BUDGET
        svc.NODE_BUDGET = 12
        try:
            net = asyncio.run(svc.memory_network(scope))  # type: ignore[arg-type]
        finally:
            svc.NODE_BUDGET = real

        assert len(net["neurons"]) <= 12
        assert net["stats"]["folded"] > 0
        # 学过的那一节绝不能被丢
        assert "sec:s0" in _ids(net, "section")
        # 章上的进度是「还有多少没走」唯一的载体
        chap = next(n for n in net["neurons"] if n["id"] == "ch:ch1")
        assert chap["total"] == 41
        assert chap["lit"] == 1
        # 边必须同步清掉：悬空的边会被力导向静默丢弃，表现成「连线时有时无」
        ids = {n["id"] for n in net["neurons"]}
        for s in net["synapses"]:
            assert s["a"] in ids and s["b"] in ids, s

    def test_按时间升序返回_时间轴回放才对(self):
        """前端时间轴按 created_at 切，倒序会让回放从最新开始。"""
        old = _card(id="old", created_at=NOW - timedelta(days=5), source_section_id="s1")
        new = _card(id="new", created_at=NOW, source_section_id="s1")
        net = _net(rows=_tree(), cards=[old, new])
        got = [n["created_at"] for n in net["neurons"] if n["kind"] == "card"]
        assert got == sorted(got)


class Test跳转:
    def test_结构节点带路由_卡片不带(self):
        """未点亮的小节尤其要能点进去 —— 那正是「还没走到的地方」，
        点它就开始学，这张图于此从展示变成入口。"""
        net = _net(rows=_tree(), cards=[_card(id="c1")])
        by_id = {n["id"]: n for n in net["neurons"]}
        assert by_id["sec:s2"]["route"] == "/courses/co1/sections/s2"
        assert by_id["ch:ch1"]["route"] == "/courses/co1"
        assert by_id["c1"]["route"] == ""  # 卡片走 Modal


# ─────────────────────────────────────────────────────────────
def _独立运行() -> int:
    ok = failed = 0
    for cls in (
        Test五类节点,
        Test卡片_id_不能动,
        Test边是线性的,
        Test不再有孤岛,
        Test点亮与牢固度,
        Test截断方向,
        Test跳转,
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
