"""桌宠说什么。

★ 这个功能的全部价值在「说得对不对、该不该说」，而这两件事都不会报错

  说错话（提起一件已经做完的事）和不该说话时说话（刚打开就催你复习），
  都只会让用户点掉那个叉，然后再也不打开 —— 而后台一切正常。

守四件事：
  1. 优先级：时效性 > 系统排程 > 差最后一步 > 他自己的困惑 > 荒废提醒
  2. 番茄那条有**时间窗**：过了劲儿就别提了，脑子里已经不热了
  3. 措辞不带责备，且全程不调模型（常驻的东西一冒泡就花钱是灾难）
  4. 什么都没有时**不硬找话说**，也不能返回 None 让前端崩

⚠️ 有一条测不到，说清楚：「已经收成笔记的小节不能再催」靠 SQL 的
   source_section_id.not_in(noted) 与 having(count >= 3) 保证 ——
   替身接不住 SQL 语义，硬写只会是假测试。这条是在服务器上拿真实数据核实的
   （输出「1.1 键值查询隐喻与注意力打分 你划了 4 个词」，而那一节确实还没笔记）。

没装 pytest 也能跑：python tests/test_pet.py
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
from app.services import pet as svc  # noqa: E402


class _Chain:
    """吃掉任意链式调用的语句替身（scope.select(...).where(...).order_by(...)）。"""

    def __getattr__(self, _name):
        return lambda *_a, **_kw: self


class FakePomodoro:
    def __init__(self, *, ended_min_ago=5.0, reviewed=False, section_id="s1", minutes=25):
        self.status = "completed"
        self.reviewed_at = utcnow() if reviewed else None
        self.ended_at = utcnow() - timedelta(minutes=ended_min_ago)
        self.started_at = self.ended_at - timedelta(minutes=minutes)
        self.section_id = section_id
        self.planned_minutes = minutes


class FakeNote:
    def __init__(self, body: str, *, section_id="s1"):
        self.kind = "note"
        self.state = "vault"
        self.user_note = ""
        self.ai_answer = body
        self.source_section_id = section_id


class FakeScope:
    """按调用者需要的返回值逐项配。

    ⚠️ 替身要照做真身的形状：真身用 scope.one_or_none 取番茄、
       scope.all 取笔记、session.scalar 数到期、session.execute 取聚合行。
       形状对不上，测出来的就不是线上行为。
    """

    user_id = "u1"

    def __init__(self, *, pomo=None, due=0, notes=(), exec_rows=None, count=0):
        self._pomo = pomo
        self._due = due
        self._notes = list(notes)
        self._exec = list(exec_rows or [])
        self._count = count
        outer = self

        class _S:
            async def scalar(_self, _stmt):
                return outer._due

            async def execute(_self, _stmt):
                class _R:
                    def all(_s):
                        return outer._exec.pop(0) if outer._exec else []

                    def first(_s):
                        rows = outer._exec.pop(0) if outer._exec else []
                        return rows[0] if rows else None

                return _R()

            async def scalars(_self, _stmt):
                return outer._notes

        self.session = _S()

    def select(self, *_a, **_kw):
        return _Chain()

    async def one_or_none(self, _stmt):
        return self._pomo

    async def all(self, _stmt):
        return self._notes

    async def count(self, _stmt):
        return self._count


def run(coro):
    return asyncio.run(coro)


# ── 1. 番茄那条的时间窗 ────────────────────────────────────────
class Test番茄回顾:
    def test_刚跑完就提_并带上收了几张卡(self):
        scope = FakeScope(pomo=FakePomodoro(ended_min_ago=3), count=3)
        got = run(svc._pomodoro_tail(scope))
        assert got is not None
        assert "3 张卡" in got["text"]
        assert got["kind"] == "pomodoro"

    def test_过了时间窗就不提(self):
        """★ 番茄刚结束那几分钟脑子里还热着，此时回顾和半小时后完全不是
        一回事。过了劲儿还催，就变成了纯骚扰。"""
        scope = FakeScope(pomo=FakePomodoro(ended_min_ago=90), count=3)
        assert run(svc._pomodoro_tail(scope)) is None

    def test_一张卡都没收也有话说(self):
        scope = FakeScope(pomo=FakePomodoro(ended_min_ago=2), count=0)
        got = run(svc._pomodoro_tail(scope))
        assert got is not None and "记下来" in got["text"]

    def test_没有番茄就返回_None(self):
        assert run(svc._pomodoro_tail(FakeScope())) is None


# ── 2. 到期复习 ────────────────────────────────────────────────
class Test到期复习:
    def test_有到期卡就报数(self):
        got = run(svc._due_review(FakeScope(due=7)))
        assert got is not None
        assert "7 张卡" in got["text"]
        assert got["route"] == "/review"

    def test_没有到期卡就闭嘴(self):
        """★ 「0 张卡待复习」这种话没有任何价值，只会消耗用户的耐心。"""
        assert run(svc._due_review(FakeScope(due=0))) is None


# ── 3. 他自己写的「还没搞懂」 ──────────────────────────────────
class Test自己承认的缺口:
    def test_抠出第一句并转成一句问话(self):
        """这是最有分量的一条：是他**自己**承认的缺口，不是系统猜的。
        通用助手永远说不出这句话。"""
        note = FakeNote(
            "## 核心机制\n讲了 QKV\n\n"
            "## 我还没搞懂的\n多头为什么要拆成多个子空间，我没想明白。还有位置编码。\n"
        )
        scope = FakeScope(notes=[note], exec_rows=[[("c1",)]])
        got = run(svc._own_gap(scope))
        assert got is not None
        assert "多头为什么要拆成多个子空间" in got["text"]
        # 只取第一句 —— 气泡里放不下一整段
        assert "位置编码" not in got["text"]
        # 能一键丢给第二大脑
        assert got.get("ask")

    def test_空的那一节不算缺口(self):
        for body in (
            "## 我还没搞懂的\n\n## 下一节",
            "## 我还没搞懂的\n（无）\n",
            "## 核心机制\n只有这一节",
        ):
            assert run(svc._own_gap(FakeScope(notes=[FakeNote(body)]))) is None, body

    def test_太短的缺口不提(self):
        """「不懂」这种两个字的残句拿出来问，只会显得莫名其妙。"""
        assert run(svc._own_gap(FakeScope(notes=[FakeNote("## 我还没搞懂的\n不懂啊\n")]))) is None

    def test_终稿优先于原稿(self):
        note = FakeNote("## 我还没搞懂的\nAI 原稿里写的缺口\n")
        note.user_note = "## 我还没搞懂的\n我改过之后真正没搞懂的是缩放那一步\n"
        scope = FakeScope(notes=[note], exec_rows=[[("c1",)]])
        got = run(svc._own_gap(scope))
        assert got is not None and "缩放那一步" in got["text"]


# ── 4. 优先级与兜底 ────────────────────────────────────────────
class Test优先级:
    def test_番茄压过到期复习(self):
        """★ 顺序就是「此刻最该被提起的事」：番茄有时效，到期复习没有 ——
        今天不刷明天刷区别不大，而番茄的余温只有几分钟。"""
        assert svc._PICKERS[0] is svc._pomodoro_tail
        assert svc._PICKERS.index(svc._due_review) < svc._PICKERS.index(svc._unfinished_note)

    def test_他自己的困惑排在荒废提醒之前(self):
        """「你说过多头没想明白」比「你三天没学了」有用得多 ——
        后者是责备，前者是接得上的话头。"""
        assert svc._PICKERS.index(svc._own_gap) < svc._PICKERS.index(svc._stale_course)

    def test_五路都在链里(self):
        assert len(svc._PICKERS) == 5

    def test_全都没有时不硬找话说(self):
        """★ 但也绝不能返回 None —— 前端拿 None 会崩，
        而且「手上都清了」本身就是一句值得说的话。"""
        got = run(svc.nudge(FakeScope()))
        assert got["kind"] == "idle"
        assert got["text"]
        assert got["route"] == ""

    def test_一路查询挂了不该让桌宠整个哑掉(self):
        class Boom(FakeScope):
            async def one_or_none(self, _stmt):
                raise RuntimeError("数据库抽风")

        got = run(svc.nudge(Boom(due=5)))
        # 番茄那一路炸了，但到期复习照常说出来
        assert got["kind"] == "due"


# ── 5. 措辞 ────────────────────────────────────────────────────
class Test措辞:
    def test_荒废提醒说清停在哪_而不是责备(self):
        """★ 「你已经三天没学了」只会让人点掉那个叉。
        说清它**停在哪一节**，才是一句接得上的话。

        ⚠️ 这里检查的是**真实输出**，不是扫源码 —— 扫源码会命中注释里
           解释「为什么不用这些词」的那段文字，那是假失败。
        """
        old = utcnow() - timedelta(days=16)
        scope = FakeScope(
            exec_rows=[
                [("c1", "Transformer 深度解析", "transformer", old)],
                [("s9", 0, 1, "软注意力与权重归一化")],
            ]
        )
        got = run(svc._stale_course(scope))
        assert got is not None
        assert "停了 16 天" in got["text"]
        # 说清了下一节是哪一节 —— 降低重新开始的门槛
        assert "1.2 软注意力与权重归一化" in got["text"]
        assert got["route"] == "/courses/c1/sections/s9"
        for bad in ("偷懒", "该努力", "坚持", "居然", "才学"):
            assert bad not in got["text"], bad

    def test_不接任何模型调用(self):
        """★ 桌宠常驻，一冒泡就调模型等于持续烧钱。
        它只从已有数据里挑话说 —— 要「聊」是转给第二大脑的事。"""
        src = Path(svc.__file__).read_text("utf-8")
        for bad in ("chat_json", "stream_chat", "await chat("):
            assert bad not in src, bad


def _独立运行() -> int:
    import inspect
    import traceback

    ok = bad = 0
    for cls in (Test番茄回顾, Test到期复习, Test自己承认的缺口, Test优先级, Test措辞):
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
