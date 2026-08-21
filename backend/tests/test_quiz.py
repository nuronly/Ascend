"""章节刷题。

这个功能的价值几乎全部在**素材组织**上：同一个模型，喂「这一章的正文」和喂
「他问过什么、他写的理解是什么、他自己说哪里没搞懂、哪些卡快忘了」，
出来的题不是一个量级。所以测的重点不是"能不能出题"，是**那些信号有没有
真的进到 prompt 里** —— 少标一个，功能就退化成「AI 照着教材出题」，
而且不会报错、看不出来。

其余三处容易静默出错的地方：
  · 选择题 answer 必须是合法下标。模型给 "A" 或者越界都见过 ——
    不洗的话前端永远判错，而且所有人都答错，不报错
  · 两个选项答对不能给 FSRS 满分（蒙也有一半概率）。给 4 会让间隔被
    不当拉长，下次该问的时候不问 —— 排程失准是静默的
  · 正文节选要优先取「他划过词的段落」。按顺序截前 900 字最省事，
    但那等于假设开头最重要

没装 pytest 也能跑：python tests/test_quiz.py
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
from app.services import prompts, quiz as svc  # noqa: E402


# ── 替身 ────────────────────────────────────────────────────────
class FakeCard:
    def __init__(self, **kw):
        self.id = kw.get("id", "k1")
        self.kind = kw.get("kind", "card")
        self.selected_text = kw.get("selected_text", "")
        self.question = kw.get("question", "")
        self.ai_answer = kw.get("ai_answer", "")
        self.user_note = kw.get("user_note", "")
        self.is_rewritten = kw.get("is_rewritten", False)
        self.touch_count = kw.get("touch_count", 0)
        self.source_section_id = kw.get("source_section_id", "s1")
        self.state = "vault"
        self.created_at = utcnow()


class FakeState:
    def __init__(self, *, due_in_days=10.0, stability=20.0, lapses=0, card_id="k1"):
        self.card_id = card_id
        self.due_date = utcnow() + timedelta(days=due_in_days)
        self.stability = stability
        self.lapses = lapses


class FakeSection:
    def __init__(self, **kw):
        self.id = kw.get("id", "s1")
        self.idx = kw.get("idx", 0)
        self.title = kw.get("title", "自注意力")
        self.summary = kw.get("summary", "讲 QKV")
        self.key_concepts = kw.get("key_concepts", ["缩放点积"])
        self.content_md = kw.get("content_md", "")
        self.completed_at = kw.get("completed_at")
        self.regenerate_count = kw.get("regenerate_count", 0)
        self.chapter_id = "ch1"


class FakeChapter:
    id = "ch1"
    idx = 0
    title = "注意力机制"
    summary = "从长程依赖讲到 QKV"
    course_id = "c1"


class _Chain:
    """吃掉任意链式调用的语句替身。

    真身写的是 scope.select(Card).where(...).order_by(...) —— 替身要是返回
    一个裸 object()，第一个 .where 就 AttributeError。这种「替身接不住真身的
    链式写法」是替身最常见的坏法。
    """

    def __getattr__(self, _name):
        return lambda *_a, **_kw: self


class FakeScope:
    """只实现 _material 用到的那几个查询。

    ⚠️ 替身必须照做真身的过滤条件 —— 这里 sections 按 idx 排序，
       与真身的 order_by(Section.idx) 一致。顺序错了，题目里的
       「1.1 / 1.2」编号就会串。
    """

    user_id = "u1"

    def __init__(self, sections, cards, states):
        self._cards = cards
        self._states = states

        class _S:
            async def scalars(_self, _stmt):
                return sorted(sections, key=lambda s: s.idx)

            async def get(_self, _model, _id):
                return None

            async def execute(_self, _stmt):
                return []

        self.session = _S()

    def select(self, *_a, **_kw):
        return _Chain()

    async def all(self, _stmt):
        # 按调用顺序返回：_material 先查 cards，再查 review states
        if not getattr(self, "_asked", False):
            self._asked = True
            return self._cards
        return self._states

    async def get(self, _model, _id):
        return None


def _material(sections, cards, states=()):
    return asyncio.run(svc._material(FakeScope(sections, cards, list(states)), FakeChapter()))


# ── 1. 素材标注：功能的命脉 ────────────────────────────────────
class Test素材标注:
    def test_他问过的卡要被标出来(self):
        _, cards = _material(
            [FakeSection()],
            [FakeCard(id="k1", selected_text="缩放点积", question="为什么要除以根号 dk")],
        )
        assert cards[0]["tags"] == ["他问过"] or "他问过" in cards[0]["tags"]
        assert cards[0]["他问的"] == "为什么要除以根号 dk"
        assert cards[0]["划的词"] == "缩放点积"

    def test_己见要单独标并带上原话(self):
        """★ 他自己写的理解是判分的第二把尺子：如果他当初就理解偏了，
        这次答的和当初一致，不该算对。"""
        _, cards = _material(
            [FakeSection()],
            [FakeCard(is_rewritten=True, user_note="我理解成梯度会消失", question="q")],
        )
        assert "他写过自己的理解" in cards[0]["tags"]
        assert cards[0]["他自己写的理解"] == "我理解成梯度会消失"

    def test_快忘了要标出来(self):
        """FSRS 退到后台之后，它的价值就体现在这个标注上。"""
        _, cards = _material(
            [FakeSection()],
            [FakeCard(id="k1")],
            [FakeState(card_id="k1", due_in_days=-2)],
        )
        assert "快忘了" in cards[0]["tags"]

    def test_记不牢与反复错也要标(self):
        _, cards = _material(
            [FakeSection()],
            [FakeCard(id="k1")],
            [FakeState(card_id="k1", due_in_days=5, stability=1.2, lapses=3)],
        )
        assert "记得还不牢" in cards[0]["tags"]
        assert any("错过 3 次" in t for t in cards[0]["tags"])

    def test_笔记里的我还没搞懂要被抠出来(self):
        """★ 这是他**自己承认**的缺口，出题权重最高。
        NOTE_SYSTEM 固定输出这个小标题，抠不出来就等于这个信号没了。"""
        note = (
            "## 核心机制\n讲了 QKV。\n\n"
            "## 我的理解\n我觉得是加权平均。\n\n"
            "## 我还没搞懂的\n多头到底为什么要拆成多个子空间，我没想明白。\n\n"
            "## 与前面学过的关系\n略"
        )
        _, cards = _material([FakeSection()], [FakeCard(kind="note", ai_answer=note)])
        assert "他标了还没搞懂" in cards[0]["tags"]
        assert "多头到底为什么" in cards[0]["他说还没搞懂"]

    def test_空的没搞懂节不要误标(self):
        for body in (
            "## 我还没搞懂的\n\n## 下一节",
            "## 我还没搞懂的\n（无）\n",
            "## 核心机制\n只有这一节",
        ):
            _, cards = _material([FakeSection()], [FakeCard(kind="note", ai_answer=body)])
            assert "他标了还没搞懂" not in cards[0]["tags"], body

    def test_笔记看终稿而不是原稿(self):
        """user_note 是用户改过的终稿，ai_answer 只是原稿快照。
        出题该按他最后认可的版本来。"""
        _, cards = _material(
            [FakeSection()],
            [FakeCard(kind="note", ai_answer="原稿", user_note="## 我还没搞懂的\n改过之后的缺口在这")],
        )
        assert "改过之后的缺口" in cards[0]["他说还没搞懂"]

    def test_重读次数与未读都要标在小节上(self):
        secs, _ = _material(
            [
                FakeSection(id="s1", idx=0, content_md="正文", regenerate_count=2),
                FakeSection(id="s2", idx=1, content_md=None),
            ],
            [],
        )
        assert any("重读过 2 次" in m for m in secs[0]["marks"])
        assert "这一节他还没读" in secs[1]["marks"]

    def test_小节按顺序且带上章节号(self):
        secs, _ = _material(
            [FakeSection(id="s2", idx=1, title="多头"), FakeSection(id="s1", idx=0, title="点积")],
            [],
        )
        assert [s["title"] for s in secs] == ["1.1 点积", "1.2 多头"]


# ── 2. 正文节选：优先取他划过词的段落 ─────────────────────────
class Test正文节选:
    def test_优先取划过词的段落(self):
        """★ 按顺序截前 900 字最省事，但那等于假设开头最重要。
        真正值得出题的是他停下来划词提问的那几段。"""
        content = (
            "第一段是背景介绍，讲历史脉络，内容很长但他没有在这里停下来过。" * 3
            + "\n\n"
            + "第二段讲的是缩放点积注意力的推导过程，他在这里划了词。" * 3
        )
        got = svc._excerpt(content, ["缩放点积"], budget=200)
        assert "缩放点积" in got
        assert got.startswith("第二段"), "划过词的段落必须排在前面"

    def test_一个词都没命中时退回开头(self):
        content = "只有这一段内容，他从没划过词。" * 6
        got = svc._excerpt(content, ["不存在的词"], budget=120)
        assert got.startswith("只有这一段")

    def test_没有正文就是空串(self):
        assert svc._excerpt("", ["x"]) == ""

    def test_不超预算(self):
        content = "\n\n".join("段落内容" * 20 for _ in range(10))
        assert len(svc._excerpt(content, [], budget=300)) <= 300


# ── 3. 洗题目：模型输出不可信 ──────────────────────────────────
class Test洗题目:
    def test_字母答案要转成下标(self):
        got = svc._clean(
            [{"kind": "choice", "q": "q", "options": ["甲", "乙"], "answer": "B"}], 6, 2
        )
        assert got[0]["answer"] == 1

    def test_越界与非法答案直接丢掉(self):
        """★ 留下来的后果是所有人都答错，而且不报错。"""
        bad = [
            {"kind": "choice", "q": "q", "options": ["甲", "乙"], "answer": 5},
            {"kind": "choice", "q": "q", "options": ["甲", "乙"], "answer": None},
            {"kind": "choice", "q": "q", "options": ["甲", "乙"]},
            {"kind": "choice", "q": "q", "options": ["只有一个"], "answer": 0},
            {"kind": "choice", "q": "", "options": ["甲", "乙"], "answer": 0},
            {"kind": "short", "q": "q"},  # 简答没有参考要点，判分没依据
        ]
        assert svc._clean(bad, 6, 2) == []

    def test_两个选项是合法题型(self):
        """题干本身就能承载辨析，不必硬凑四个选项 ——
        凑出来的干扰项往往一眼假。"""
        got = svc._clean(
            [{"kind": "choice", "q": "是不是", "options": ["是", "否"], "answer": 0}], 6, 2
        )
        assert len(got) == 1

    def test_选择题排在简答前面(self):
        """一上来就让人打字，刷题的节奏直接没了。"""
        got = svc._clean(
            [
                {"kind": "short", "q": "简答", "answer": "要点"},
                {"kind": "choice", "q": "选择", "options": ["甲", "乙"], "answer": 0},
            ],
            6,
            2,
        )
        assert [i["kind"] for i in got] == ["choice", "short"]

    def test_简答题数量按上限截断(self):
        items = [{"kind": "short", "q": f"q{i}", "answer": "a"} for i in range(5)]
        got = svc._clean(items, 6, 2)
        assert sum(1 for i in got if i["kind"] == "short") == 2

    def test_脏输入不抛异常(self):
        for bad in (None, "字符串", [None, 1, "x"], [{"kind": "choice"}]):
            assert svc._clean(bad, 6, 2) == []


# ── 4. FSRS 评级映射 ───────────────────────────────────────────
class TestFSRS评级:
    def test_两个选项答对不能给满分(self):
        """★ 蒙也有一半概率对。给 4（轻松准确）会让间隔被不当拉长，
        下次该问的时候不问了 —— 排程失准是静默的，等发现时已经忘了一片。"""
        assert svc._rating_of({"options": ["是", "否"]}, True) == 3

    def test_四个选项答对给满分(self):
        assert svc._rating_of({"options": ["甲", "乙", "丙", "丁"]}, True) == 4

    def test_答错一律_again(self):
        assert svc._rating_of({"options": ["甲", "乙", "丙"]}, False) == 1

    def test_简答题没有选项也不报错(self):
        assert svc._rating_of({"kind": "short"}, True) == 3


# ── 5. 题量规划 ────────────────────────────────────────────────
class Test题量:
    def test_素材少就少出(self):
        """一章只有两张卡还硬出 12 道题，后面几道必然是凑数的。"""
        n_choice, n_short = svc._plan(n_sections=1, n_cards=0)
        assert n_choice == svc.CHOICE_MIN
        assert n_short == 0, "没有卡片就没有简答题的素材"

    def test_素材多就多出但有上限(self):
        n_choice, n_short = svc._plan(n_sections=8, n_cards=40)
        assert n_choice == svc.CHOICE_MAX
        assert n_short == svc.SHORT_MAX

    def test_卡片不多时只出一道简答(self):
        _, n_short = svc._plan(n_sections=3, n_cards=2)
        assert n_short == 1


# ── 6. prompt 真的带上了那些标注 ──────────────────────────────
class Test出题_prompt:
    def _built(self):
        secs, cards = _material(
            [FakeSection(content_md="正文里提到缩放点积注意力。" * 5, regenerate_count=2)],
            [
                FakeCard(
                    id="k1", selected_text="缩放点积", question="为什么除以根号 dk",
                    is_rewritten=True, user_note="我以为是防梯度消失",
                ),
                FakeCard(id="k2", kind="note", ai_answer="## 我还没搞懂的\n多头的意义"),
            ],
            [FakeState(card_id="k1", due_in_days=-1)],
        )
        return prompts.quiz_user(
            course_title="Transformer", chapter_title="第 1 章 注意力",
            sections=secs, cards=cards, n_choice=8, n_short=2,
        )

    def test_痕迹排在教材内容之前(self):
        """★ 模型对靠前的内容更敏感，而我们要的正是让它优先往他卡过的地方出题。"""
        text = self._built()
        assert text.index("他在这一章留下的痕迹") < text.index("这一章的内容")

    def test_所有信号都进了_prompt(self):
        text = self._built()
        for must in (
            "他问过",
            "他写过自己的理解",
            "我以为是防梯度消失",  # 他的原话
            "快忘了",
            "他标了还没搞懂",
            "多头的意义",
            "重读过 2 次",
            "缩放点积",
        ):
            assert must in text, must

    def test_题量要求写进_prompt(self):
        assert "出 8 道选择题 + 2 道简答题" in self._built()

    def test_系统提示把标注当成出题指令而不是背景(self):
        """如果这些字样被删掉，模型就会平铺直叙地按教材出题 ——
        功能还在，但价值没了，而且完全看不出来。"""
        for must in ("他问过", "他标了还没搞懂", "快忘了", "两个选项", "card_id"):
            assert must in prompts.QUIZ_SYSTEM, must


# ── 7. 没刷完的题要能找回来 ───────────────────────────────────
class Test未完成的题:
    """出一套题要几十秒，而人随时会被打断。

    所以出题时不该把他锁在界面上等，走开之后更不该让那套题白丢 ——
    落库的意义正在这里。这一节守的是「找回来」这条链路：
    没答过的旧题要清掉（否则堆一串谁也不会刷的空套题），
    答过一部分的必须留着（那是他的进度和错题记录）。
    """

    def _pending(self, quizzes: list) -> dict:
        """复现 chapter_targets 里挑 pending 的那段逻辑。"""
        pending: dict[str, dict] = {}
        for q in quizzes:  # 调用方按 created_at 倒序
            if q["chapter_id"] in pending or not q["items"]:
                continue
            done = sum(1 for i in q["items"] if i.get("correct") is not None)
            pending[q["chapter_id"]] = {"id": q["id"], "answered": done, "total": len(q["items"])}
        return pending

    def test_取每章最近的那一套(self):
        got = self._pending(
            [
                {"id": "new", "chapter_id": "ch1", "items": [{"correct": True}]},
                {"id": "old", "chapter_id": "ch1", "items": [{"correct": True}]},
            ]
        )
        assert got["ch1"]["id"] == "new"

    def test_一道题都没有的套不算(self):
        """出题失败留下的空壳不该显示成「还没刷完」。"""
        got = self._pending([{"id": "empty", "chapter_id": "ch1", "items": []}])
        assert got == {}

    def test_进度按已答题数算(self):
        got = self._pending(
            [
                {
                    "id": "q",
                    "chapter_id": "ch1",
                    "items": [{"correct": True}, {"correct": False}, {}, {"correct": None}],
                }
            ]
        )
        assert got["ch1"] == {"id": "q", "answered": 2, "total": 4}

    def test_一道没答的旧题该被清掉_答过的要留(self):
        """★ 判据是「有没有答过任何一道」：
        没答过的是纯浪费（用户重新出题时留下的空壳）；
        答过一部分的是他的进度，删掉等于把错题记录一起删了。"""
        def should_drop(items: list) -> bool:
            return not any(i.get("correct") is not None for i in (items or []))

        assert should_drop([{"q": "a"}, {"q": "b"}]) is True
        assert should_drop([]) is True
        assert should_drop([{"q": "a", "correct": False}]) is False
        assert should_drop([{"q": "a", "correct": True}]) is False
        # correct=None 不算答过（初始化的形状）
        assert should_drop([{"q": "a", "correct": None}]) is True


def _独立运行() -> int:
    import inspect
    import traceback

    ok = bad = 0
    for cls in (
        Test素材标注,
        Test正文节选,
        Test洗题目,
        TestFSRS评级,
        Test题量,
        Test出题_prompt,
        Test未完成的题,
    ):
        print(f"\n{cls.__name__}")
        inst = cls()
        for name in sorted(n for n in dir(inst) if n.startswith("test")):
            try:
                got = getattr(inst, name)()
                if inspect.iscoroutine(got):
                    asyncio.run(got)
                ok += 1
                print(f"  ✓ {name}")
            except Exception:
                bad += 1
                print(f"  ✗ {name}")
                traceback.print_exc()
    print(f"\n{'─' * 60}\n通过 {ok} · 失败 {bad}\n")
    return 1 if bad else 0


if __name__ == "__main__":
    raise SystemExit(_独立运行())
