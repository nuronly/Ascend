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

from app.llm.base import StreamChunk  # noqa: E402
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


# ─────────────────────────────────────────────────────────────
# 流式概念地图（刷题式校准）
# ─────────────────────────────────────────────────────────────
_REAL_STREAM_SIG = inspect.signature(calibrate.stream_chat)

_MAP_JSON = (
    '{"total": 4, "concepts": ['
    '{"name": "矩阵乘法", "gloss": "两个矩阵相乘", "depth": 1, "probe": ""},'
    '{"name": "softmax", "gloss": "归一化", "depth": 9, "probe": ""},'
    '{"name": " 矩阵乘法 ", "gloss": "重复项", "depth": 1, "probe": ""},'
    '{"name": "自注意力", "gloss": "每个词看别的词", "depth": 3, "probe": "为什么除以根号 d？"}'
    '], "goals": ['
    '{"kind": "read_paper", "label": "能读懂原论文"},'
    '{"kind": "read_paper", "label": "重复的 kind"},'
    '{"kind": "build", "label": "能自己实现一个"}'
    "]}"
)


def _fake_stream(*, reasoning: str = "", body: str = _MAP_JSON, boom: Exception | None = None):
    """按小片吐出来，逼出真实的流式行为（分片会切在任何位置）。"""

    async def gen(*a, **kw):
        _REAL_STREAM_SIG.bind(*a, **kw)  # 参数名写错要当场暴露，不能靠 **kwargs 兜住
        if reasoning:
            for i in range(0, len(reasoning), 7):
                yield StreamChunk(reasoning=reasoning[i : i + 7])
        if boom is not None:
            raise boom
        for i in range(0, len(body), 5):
            yield StreamChunk(delta=body[i : i + 5])
        yield StreamChunk(done=True)

    return gen


def _collect(coro_factory, *, cached: str | None = None, stream=None) -> list[dict]:
    """跑一遍流式生成，收集所有 SSE 事件（缓存与模型都换成替身）。"""
    real_stream, real_get, real_put, real_json = (
        calibrate.stream_chat, calibrate.cache_get, calibrate.cache_put, calibrate.chat_json,
    )
    put: dict[str, str] = {}

    async def fake_get(_k):
        return cached

    async def fake_put(k, *_a):
        put[k] = "written"

    async def fake_quick(*_a, **_kw):
        # 校准只该发**一次**调用。曾经并行发过两次（小模型垫场 + 推理模型深想），
        # 后来确认这个场景根本不需要深思，就该只剩一次流式调用
        raise AssertionError("概念地图不该再走非流式调用")

    calibrate.stream_chat = stream or _fake_stream()  # type: ignore[assignment]
    calibrate.cache_get = fake_get  # type: ignore[assignment]
    calibrate.cache_put = fake_put  # type: ignore[assignment]
    calibrate.chat_json = fake_quick  # type: ignore[assignment]

    async def run():
        return [ev async for ev in coro_factory()]

    try:
        events = asyncio.run(run())
    finally:
        calibrate.stream_chat = real_stream  # type: ignore[assignment]
        calibrate.cache_get = real_get  # type: ignore[assignment]
        calibrate.cache_put = real_put  # type: ignore[assignment]
        calibrate.chat_json = real_json  # type: ignore[assignment]
    events.append({"event": "_cache_written", "data": {"n": len(put)}})
    return events


def _of(events: list[dict], name: str) -> list[dict]:
    return [e["data"] for e in events if e["event"] == name]


class Test流式概念地图:
    def _run(self, user=None, **kw):
        u = user or _user()
        return _collect(
            lambda: calibrate.stream_concept_map(user=u, topic="Transformer"), **kw
        )

    def test_概念一到就单独推一条(self):
        """刷题的前提：不等整份 JSON 写完，来一道就能答一道。"""
        ev = self._run()
        names = [c["name"] for c in _of(ev, "concept")]
        assert names == ["矩阵乘法", "softmax", "自注意力"]  # 重复项被丢掉
        assert [c["idx"] for c in _of(ev, "concept")] == [1, 2, 3]

    def test_总题数先到_用户才知道还剩几道(self):
        ev = self._run()
        kinds = [e["event"] for e in ev]
        assert kinds.index("total") < kinds.index("concept")
        assert _of(ev, "total")[0]["total"] == 4

    def test_档位不可信时归到中间档(self):
        ev = self._run()
        by = {c["name"]: c for c in _of(ev, "concept")}
        assert by["softmax"]["depth"] == 2  # 原始是 9

    def test_思维链原文实时推出去(self):
        """长推理不是问题，看不见的长推理才是问题。"""
        ev = self._run(stream=_fake_stream(reasoning="先看这个主题需要什么底子" * 4))
        th = _of(ev, "thinking")
        assert th and "".join(t["text"] for t in th).startswith("先看这个主题需要什么底子")
        # 思考必须在第一道题之前就开始推，否则用户还是对着空白
        kinds = [e["event"] for e in ev]
        assert kinds.index("thinking") < kinds.index("concept")

    def test_学过的概念预勾成熟悉(self):
        ev = self._run(user=_user(["SOFTMAX"]))
        by = {c["name"]: c for c in _of(ev, "concept")}
        assert by["softmax"]["preset"] == "known"
        assert by["自注意力"]["preset"] == ""

    def test_目标候选在最后给出且去重(self):
        ev = self._run()
        assert [g["kind"] for g in _of(ev, "goals")[0]["goals"]] == ["read_paper", "build"]
        assert ev[-2]["event"] == "done"  # -1 是测试自己加的缓存标记

    def test_跑完才写缓存(self):
        ev = self._run()
        assert ev[-1]["data"]["n"] == 1

    def test_失败也要给_done(self):
        """否则前端会一直转圈，走不到「直接开始」那条降级路。"""
        ev = self._run(stream=_fake_stream(boom=RuntimeError("上游 500")))
        assert [e["event"] for e in ev][-3:-1] == ["error", "done"]
        assert _of(ev, "done")[0]["failed"] is True
        assert ev[-1]["data"]["n"] == 0  # 半截地图绝不能进缓存

    def test_缓存命中秒回放且不调模型(self):
        def explode(*_a, **_kw):
            raise AssertionError("缓存命中还去调模型了")

        ev = self._run(cached=_MAP_JSON, stream=explode)
        assert [c["name"] for c in _of(ev, "concept")] == ["矩阵乘法", "softmax", "自注意力"]
        assert _of(ev, "total")[0]["cached"] is True
        assert _of(ev, "done")[0]["cached"] is True

    def test_缓存坏了就当没有_退回真生成(self):
        ev = self._run(cached="{不是合法 JSON")
        assert len(_of(ev, "concept")) == 3


class Test不用推理模型:
    """★ 这个场景刻意不走推理模型：它是枚举，不是设计。

    拿中档推理模型跑实测要先想 60~100 秒才吐第一个字，而学习者正等着答第一道题。
    「不需要深思」是这里最重要的一条设计决定，所以用测试把它钉住 ——
    哪天有人顺手把它改回 standard，这里会红。
    """

    def test_走小模型档位(self):
        seen: dict[str, object] = {}

        def spy(*a, **kw):
            _REAL_STREAM_SIG.bind(*a, **kw)
            seen.update(kw)
            return _fake_stream()(*a, **kw)

        u = _user()
        _collect(lambda: calibrate.stream_concept_map(user=u, topic="X"), stream=spy)
        assert seen["tier"] == "small"

    def test_prompt_里明确禁止长推理(self):
        from app.services import prompts

        assert "不要长时间推理" in prompts.CALIBRATE_SYSTEM

    def test_中途失败也要把已经问出去的题算数(self):
        """已经答过的几道不该白费，前端会拿它们继续。"""
        u = _user()
        ev = _collect(
            lambda: calibrate.stream_concept_map(user=u, topic="X"),
            stream=_fake_stream(body=_MAP_JSON[:120], boom=None),
        )
        assert len(_of(ev, "concept")) >= 1


class Test规整单条:
    def test_丢掉无名与重复(self):
        seen: set[str] = set()
        assert calibrate._shape_concept({"name": ""}, set(), seen) is None
        assert calibrate._shape_concept({"name": "A"}, set(), seen) is not None
        assert calibrate._shape_concept({"name": " a "}, set(), seen) is None  # 归一化后重复

    def test_不是字典也不炸(self):
        assert calibrate._shape_concept("字符串", set(), set()) is None


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
        Test流式概念地图,
        Test不用推理模型,
        Test规整单条,
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
