"""学习边界校准 —— 取代「入门 / 进阶 / 深入」。

为什么换掉等级：那是个谁也答不准的问题（写了十年后端的人学 Transformer 算
入门吗？），而且「深入」对模型不可执行 —— 它只会多写公式。换成三个集合之后，
约束变得可执行、而且**可机械检查**，这个文件就是在钉那些边界条件：

  · 归一化：Softmax / softmax / " softmax " 必须是同一个概念，
    否则同一个词会同时出现在「已掌握」和「没接触」里，prompt 自相矛盾
  · 抽查只降级不升级：多回顾一句最多啰嗦，少回顾一句他直接看不懂
  · 判定服务挂了按自评走：保守原则针对「模型拿不准」，不是「我们调用失败」
  · forget 是最强信号（他真的在这个词上卡住了），但不能误伤

没装 pytest 也能跑：python tests/test_calibrate.py
"""

from __future__ import annotations

import asyncio
import inspect
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.models.user import User  # noqa: E402
from app.services import calibrate  # noqa: E402


def _user(known: list[str] | None = None) -> User:
    return User(id="u1", email="a@b.c", name="t", known_concepts=list(known or []))


# 在被替换之前先抓住真身的签名
_REAL_SIG = inspect.signature(calibrate.chat_json)


def _fake_chat_json(payload: dict | Exception):
    """替身，但**先按真实签名校验参数**。

    ★ 这一行 bind 是血的教训：替身原来无脑 `**_kw` 全收，于是
      `chat_json(..., json_mode=True)` 这种参数名错误在测试里完全看不出来
      （chat_json 内部本就强制 JSON，不接受这个参数），一路溜到线上，
      表现成「一直显示没能生成概念地图」。
      替身放过的东西，真身会当场拒绝 —— 所以替身必须比真身更严，至少一样严。
    """

    async def fn(*a, **kw):
        _REAL_SIG.bind(*a, **kw)
        if isinstance(payload, Exception):
            raise payload
        return payload

    return fn


def _patched(payload: dict | Exception, coro):
    """临时替换 chat_json 跑一段协程。"""
    real = calibrate.chat_json
    calibrate.chat_json = _fake_chat_json(payload)  # type: ignore[assignment]
    try:
        return asyncio.run(coro())
    finally:
        calibrate.chat_json = real  # type: ignore[assignment]


# ─────────────────────────────────────────────────────────────
class Test归一化:
    def test_大小写与空格不该产生两个概念(self):
        assert calibrate.norm(" Softmax ") == calibrate.norm("softmax") == "softmax"

    def test_中间的多余空格也要压掉(self):
        assert calibrate.norm("self  attention") == "self attention"

    def test_空值不炸(self):
        assert calibrate.norm("") == ""
        assert calibrate.norm(None) == ""  # type: ignore[arg-type]


class Test边界组装:
    def test_三态各归各桶(self):
        b = calibrate.build_boundary(
            {"a": "known", "b": "shaky", "c": "unknown"},
            names={"a": "A", "b": "B", "c": "C"},
            goal="能读懂论文",
        )
        assert b["known"] == ["A"]
        assert b["shaky"] == ["B"]
        assert b["unknown"] == ["C"]
        assert b["goal"] == "能读懂论文"

    def test_抽查没过的从熟悉落到半懂(self):
        """只降级 —— 而且是降到「回顾一句」，不是打回「从头讲」。"""
        b = calibrate.build_boundary(
            {"softmax": "known", "梯度": "known"},
            names={"softmax": "softmax", "梯度": "梯度"},
            demoted=["Softmax"],  # 大小写不同也要认出来
        )
        assert b["known"] == ["梯度"]
        assert b["shaky"] == ["softmax"]

    def test_降级不会把没勾熟悉的也拖下水(self):
        b = calibrate.build_boundary(
            {"a": "unknown"}, names={"a": "A"}, demoted=["A"]
        )
        assert b["unknown"] == ["A"] and not b["shaky"]

    def test_非法状态直接丢掉(self):
        b = calibrate.build_boundary({"a": "maybe", "b": "known"}, names={"a": "A", "b": "B"})
        assert b["known"] == ["B"]
        assert "A" not in b["known"] + b["shaky"] + b["unknown"]


class Test派生等级:
    def test_大部分没接触算入门(self):
        assert calibrate.derive_level({"unknown": ["a", "b", "c"], "known": ["d"]}) == "beginner"

    def test_几乎都会算深入(self):
        assert (
            calibrate.derive_level({"known": ["a", "b", "c", "d"], "unknown": []}) == "advanced"
        )

    def test_一半一半算进阶(self):
        assert (
            calibrate.derive_level({"known": ["a", "b"], "unknown": ["c"], "shaky": ["d"]})
            == "intermediate"
        )

    def test_没有边界时回落到进阶(self):
        """老课程 / 跳过校准的课，不能因为空边界推出个「入门」误导人。"""
        assert calibrate.derive_level({}) == "intermediate"


class Test跨课继承:
    def test_学过的进已知边界且去重(self):
        u = _user(["梯度下降"])
        added = calibrate.learn(u, ["梯度下降", "GRADIENT descent", "注意力", "注意力"])
        # 「梯度下降」已有，「GRADIENT descent」是另一个词面（不做翻译等价），
        # 「注意力」重复只算一次
        assert added == 2
        assert u.known_concepts == ["梯度下降", "GRADIENT descent", "注意力"]

    def test_超上限丢最早的(self):
        u = _user([f"c{i}" for i in range(calibrate.KNOWN_CAP)])
        calibrate.learn(u, ["新概念"])
        assert len(u.known_concepts) == calibrate.KNOWN_CAP
        assert u.known_concepts[-1] == "新概念"
        assert "c0" not in u.known_concepts  # 三年前勾的「熟悉」不该永久生效

    def test_划词命中已知概念就撤回(self):
        u = _user(["softmax", "位置编码"])
        hit = calibrate.forget(u, "这里的 softmax 到底在算什么？")
        assert hit == ["softmax"]
        assert u.known_concepts == ["位置编码"]

    def test_英文要卡词边界(self):
        u = _user(["go"])
        assert calibrate.forget(u, "我用 google 搜了一下") == []
        assert u.known_concepts == ["go"]

    def test_单字概念不参与匹配(self):
        """「熵」会命中一大堆无关文本，误伤代价太高。"""
        u = _user(["熵"])
        assert calibrate.forget(u, "这段讲的是熵增") == []

    def test_没有已知边界时是空操作(self):
        u = _user()
        assert calibrate.forget(u, "随便一段话") == []


class Test覆盖率自检:
    def test_大纲铺到了就没有缺口(self):
        b = {"unknown": ["自注意力", "位置编码"]}
        covered = ["1.1 什么是自注意力 从检索类比讲起", "1.2 位置编码 为什么需要它"]
        assert calibrate.coverage_gap(b, covered) == []

    def test_漏掉的要报出来(self):
        """这是集合约束才有的红利：「够不够深入」没法验，「有没有讲到」可以。"""
        b = {"unknown": ["自注意力", "位置编码", "多头"]}
        covered = ["1.1 自注意力入门", "1.2 位置编码"]
        assert calibrate.coverage_gap(b, covered) == ["多头"]

    def test_没有边界就没有缺口(self):
        assert calibrate.coverage_gap({}, ["随便"]) == []


class Test抽查选题:
    CONCEPTS = [
        {"name": "矩阵乘法", "depth": 1, "probe": "问题1"},
        {"name": "softmax", "depth": 2, "probe": "问题2"},
        {"name": "自注意力", "depth": 3, "probe": "问题3"},
        {"name": "多头", "depth": 3, "probe": ""},
    ]

    def test_只抽查自评熟悉的最深档(self):
        states = {"矩阵乘法": "known", "softmax": "known", "自注意力": "known"}
        picked = calibrate.pick_probes(self.CONCEPTS, states)
        assert [p["concept"] for p in picked] == ["自注意力", "softmax"]

    def test_没勾熟悉的一个都不问(self):
        assert calibrate.pick_probes(self.CONCEPTS, {"softmax": "shaky"}) == []

    def test_没有_probe_的概念跳过(self):
        picked = calibrate.pick_probes(self.CONCEPTS, {"多头": "known"})
        assert picked == []


class Test自评校验:
    ITEMS = [{"concept": "自注意力", "question": "q", "answer": "就是让每个词看别的词"}]

    def test_没通过的降级(self):
        out = _patched(
            {"results": [{"concept": "自注意力", "pass": False, "note": "说反了"}]},
            lambda: calibrate.verify_claims(user=_user(), items=self.ITEMS),
        )
        assert out["demoted"] == ["自注意力"]
        assert out["notes"]["自注意力"] == "说反了"

    def test_通过的维持原状_不做升级(self):
        out = _patched(
            {"results": [{"concept": "自注意力", "pass": True}]},
            lambda: calibrate.verify_claims(user=_user(), items=self.ITEMS),
        )
        assert out["demoted"] == []

    def test_模型漏judge的算没通过(self):
        """拿不准就多铺垫一句 —— 两种错误的代价差一个数量级。"""
        out = _patched(
            {"results": []},
            lambda: calibrate.verify_claims(user=_user(), items=self.ITEMS),
        )
        assert out["demoted"] == ["自注意力"]

    def test_判定调用失败则按自评走(self):
        """保守原则针对「模型拿不准」，不是「我们的调用挂了」——
        后者拿用户的自评背锅毫无道理，效果等同于他跳过了抽查。"""
        out = _patched(
            RuntimeError("上游 500"),
            lambda: calibrate.verify_claims(user=_user(), items=self.ITEMS),
        )
        assert out["demoted"] == []

    def test_空回答不调模型(self):
        called = {"n": 0}

        async def spy(*a, **kw):
            _REAL_SIG.bind(*a, **kw)
            called["n"] += 1
            return {"results": []}

        real = calibrate.chat_json
        calibrate.chat_json = spy  # type: ignore[assignment]
        try:
            out = asyncio.run(
                calibrate.verify_claims(
                    user=_user(), items=[{"concept": "a", "question": "q", "answer": "  "}]
                )
            )
        finally:
            calibrate.chat_json = real  # type: ignore[assignment]
        assert out == {"demoted": [], "notes": {}}
        assert called["n"] == 0  # 留空 = 跳过，不该白花一次调用


class Test概念地图:
    RAW = {
        "concepts": [
            {"name": "矩阵乘法", "gloss": "两个矩阵相乘", "depth": 1, "probe": "q1"},
            {"name": "自注意力", "gloss": "让每个词看别的词", "depth": 3, "probe": "q3"},
            {"name": " 矩阵乘法 ", "gloss": "重复项", "depth": 1, "probe": "q1"},
            {"name": "softmax", "gloss": "归一化", "depth": 9, "probe": "q2"},
            {"name": "", "gloss": "没名字", "depth": 2},
        ],
        "goals": [
            {"kind": "read_paper", "label": "能读懂原论文"},
            {"kind": "read_paper", "label": "重复的 kind"},
            {"kind": "build", "label": "能自己实现一个"},
        ],
    }

    def test_去重_补档_并按深度排序(self):
        out = _patched(
            self.RAW,
            lambda: calibrate.concept_map(user=_user(), topic="Transformer"),
        )
        names = [c["name"] for c in out["concepts"]]
        assert names == ["矩阵乘法", "softmax", "自注意力"]  # depth 9 → 2，排中间
        assert [c["depth"] for c in out["concepts"]] == [1, 2, 3]

    def test_学过的概念预勾成熟悉(self):
        """复利：学得越多，下一门课要勾的越少。"""
        out = _patched(
            self.RAW,
            lambda: calibrate.concept_map(user=_user(["SOFTMAX"]), topic="Transformer"),
        )
        by = {c["name"]: c for c in out["concepts"]}
        assert by["softmax"]["preset"] == "known"
        assert by["自注意力"]["preset"] == ""

    def test_目标候选去重且有上限(self):
        out = _patched(
            self.RAW,
            lambda: calibrate.concept_map(user=_user(), topic="Transformer"),
        )
        assert [g["kind"] for g in out["goals"]] == ["read_paper", "build"]


# ─────────────────────────────────────────────────────────────
def _独立运行() -> int:
    classes = [
        Test归一化,
        Test边界组装,
        Test派生等级,
        Test跨课继承,
        Test覆盖率自检,
        Test抽查选题,
        Test自评校验,
        Test概念地图,
    ]
    ok = failed = 0
    for cls in classes:
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
