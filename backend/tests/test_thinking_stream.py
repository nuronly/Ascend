"""思维链的流式透出。

用户盯着一个转圈等两分钟，会认定它卡死了 —— 哪怕它其实一直在算。
早先这里只报「已推理 N 字」，那只证明进程还活着，用户仍然不知道模型在想
什么。所以思维链原文必须推给前端。但逐 token 直推等于让前端 setState
几千次，肉眼可见地卡，于是要攒段。这两条约束都在这里钉死：

  1. 攒够 _CHUNK 个字符才发，且一个字都不能丢
  2. 切去调工具 / 开始吐正文之前必须先把攒着的尾巴发掉，否则时序会乱
  3. 思维链绝不能混进大纲 JSON —— 混进去整份大纲就解析失败

没装 pytest 也能跑：python tests/test_thinking_stream.py
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.llm.base import StreamChunk, ToolEvent  # noqa: E402
from app.models.course import Chapter, Course, Section  # noqa: E402
from app.services import course as course_mod  # noqa: E402
from app.services.course import _Thinking  # noqa: E402


# ─────────────────────────────────────────────────────────────
# 攒段器
# ─────────────────────────────────────────────────────────────
class Test攒段:
    def test_没攒够不发(self):
        t = _Thinking()
        assert t.add("嗯") is None
        assert t.add("再想想") is None

    def test_攒够一段就发且是原文拼接(self):
        t = _Thinking()
        t.add("甲" * 30)
        ev = t.add("乙" * 20)
        assert ev is not None
        assert ev["event"] == "thinking"
        assert ev["data"]["text"] == "甲" * 30 + "乙" * 20

    def test_chars_是累计总量而不是本段长度(self):
        t = _Thinking()
        first = t.add("甲" * 50)
        second = t.add("乙" * 50)
        assert first["data"]["chars"] == 50
        # 前端拿它显示「已推理 N 字」，必须是总量
        assert second["data"]["chars"] == 100
        assert len(second["data"]["text"]) == 50

    def test_flush_吐出没攒满的尾巴(self):
        t = _Thinking()
        t.add("最后半句话")
        ev = t.flush()
        assert ev["data"]["text"] == "最后半句话"

    def test_空缓冲_flush_不发空事件(self):
        t = _Thinking()
        assert t.flush() is None
        t.add("甲" * 50)  # 这一下已经把缓冲清空了
        assert t.flush() is None

    def test_一个字都不能丢(self):
        """逐 token 喂进去，所有事件拼回来必须等于原文。"""
        src = "".join(f"第{i}步先看" for i in range(200))
        t = _Thinking()
        out: list[str] = []
        for ch in src:  # 模拟一个字一个字地来
            if ev := t.add(ch):
                out.append(ev["data"]["text"])
        if ev := t.flush():
            out.append(ev["data"]["text"])
        assert "".join(out) == src
        assert t.total == len(src)
        # 顺便确认真的压缩了事件数，否则攒段就白做了
        assert len(out) < len(src) / 20


# ─────────────────────────────────────────────────────────────
# 大纲流里的时序
# ─────────────────────────────────────────────────────────────
class FakeScope:
    """stream_outline + _persist_outline 只要 user_id / add / flush / commit。"""

    def __init__(self) -> None:
        self.user_id = "u1"
        self.added: list[object] = []

    def add(self, obj: object) -> None:
        self.added.append(obj)

    async def flush(self) -> None:
        pass

    async def commit(self) -> None:
        pass

    @property
    def sections(self) -> list[Section]:
        return [o for o in self.added if isinstance(o, Section)]

    @property
    def chapters(self) -> list[Chapter]:
        return [o for o in self.added if isinstance(o, Chapter)]


_OUTLINE = {
    "title": "真标题",
    "description": "d",
    "chapters": [
        {
            "title": "第一章",
            "summary": "s",
            "sections": [
                {"sid": "1.1", "title": "小节一", "summary": "x", "prerequisites": []},
                {"sid": "1.2", "title": "小节二", "summary": "y", "prerequisites": ["1.1"]},
            ],
        }
    ],
}


def _fake_stream_chat(chunks: list[StreamChunk]):
    async def gen(*_a, **_kw):
        for c in chunks:
            yield c

    return gen


async def _collect(chunks: list[StreamChunk]) -> tuple[list[dict], FakeScope, Course]:
    scope = FakeScope()
    course = Course(id="c1", user_id="u1", topic="Transformer")
    real = course_mod.stream_chat
    course_mod.stream_chat = _fake_stream_chat(chunks)
    try:
        events = [ev async for ev in course_mod.stream_outline(scope, course)]  # type: ignore[arg-type]
    finally:
        course_mod.stream_chat = real
    return events, scope, course


class Test大纲流时序:
    def test_思考在工具调用之前收尾(self):
        """先想 → 去查 → 再想。攒着的半句思考不能拖到工具事件后面才露出来。"""
        chunks = [
            StreamChunk(reasoning="我得先确认这个领域的标准划分"),
            StreamChunk(
                tool_event=ToolEvent(
                    phase="call", name="web_search", detail="Transformer 教程"
                )
            ),
            StreamChunk(
                tool_event=ToolEvent(
                    phase="result",
                    name="web_search",
                    detail="找到 3 条",
                    payload={"items": [{"title": "T", "url": "https://a.com/x", "source": "a.com"}]},
                )
            ),
            StreamChunk(reasoning="那就按这个顺序排"),
            StreamChunk(delta=json.dumps(_OUTLINE, ensure_ascii=False)),
        ]
        events, _, course = asyncio.run(_collect(chunks))
        names = [e["event"] for e in events]

        # 第一段思考必须落在 tool_call 之前
        assert names.index("thinking") < names.index("tool_call")
        # 第二段思考（不足一段长）也不能被吞掉：正文开始前要 flush 出来
        thinking = [e for e in events if e["event"] == "thinking"]
        assert len(thinking) == 2
        assert thinking[0]["data"]["text"] == "我得先确认这个领域的标准划分"
        assert thinking[1]["data"]["text"] == "那就按这个顺序排"
        assert names[-1] == "done"
        assert course.title == "真标题"

    def test_思考原文一定带_text(self):
        """只给 chars 的老行为就是用户抱怨的「没实现流式思考」，不能退回去。"""
        events, _, _ = asyncio.run(
            _collect(
                [
                    StreamChunk(reasoning="想一下"),
                    StreamChunk(delta=json.dumps(_OUTLINE, ensure_ascii=False)),
                ]
            )
        )
        th = next(e for e in events if e["event"] == "thinking")
        assert th["data"]["text"] == "想一下"
        assert th["data"]["chars"] == 3

    def test_思维链不进大纲_json(self):
        """思维链里常常出现看着就像结果的片段，混进 buf 会让整份大纲报废。"""
        chunks = [
            StreamChunk(reasoning='也许可以写 {"title": "假标题"}'),
            StreamChunk(delta=json.dumps(_OUTLINE, ensure_ascii=False)),
        ]
        events, scope, course = asyncio.run(_collect(chunks))
        assert course.title == "真标题"
        assert [s.title for s in scope.sections] == ["小节一", "小节二"]
        # 进度条上也不该冒出思维链里那个假标题
        titles = [e["data"]["title"] for e in events if e["event"] == "progress"]
        assert "假标题" not in titles


# ─────────────────────────────────────────────────────────────
def _独立运行() -> int:
    """没装 pytest 时的 runner。"""
    failed = 0
    for cls in (Test攒段, Test大纲流时序):
        inst = cls()
        for name in sorted(dir(inst)):
            if not name.startswith("test_"):
                continue
            try:
                getattr(inst, name)()
                print(f"  ✓ {cls.__name__}.{name}")
            except Exception as exc:  # noqa: BLE001
                failed += 1
                print(f"  ✗ {cls.__name__}.{name}: {exc}")
    print("全部通过" if not failed else f"{failed} 项失败")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_独立运行())
