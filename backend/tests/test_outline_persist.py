"""大纲落库时的依赖解析。

模型输出的 prerequisites 是它自己那份 JSON 里的临时编号（"1.1"），
必须翻成真实的 section id 才有用 —— 这一步曾经根本没做，字段名叫
prerequisite_ids 但里面存着 "1.1"，永远查不回任何东西。

除了翻译，这里还有一条关键约束：**只保留指向更早小节的边**。
它同时解决三件事，每一件都是学习路径图能不能读的前提：
  1. 天然无环 —— 有环的图彻底失去方向感，dagre 只能瞎猜层级
  2. 符合「前置」语义 —— 前置知识不可能排在它后面
  3. 模型偶发的反向依赖被直接剪掉，不必再单独做环检测

没装 pytest 也能跑：python tests/test_outline_persist.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.models.course import (  # noqa: E402
    COURSE_READY,
    Chapter,
    Course,
    Section,
)
from app.services.course import _persist_outline  # noqa: E402


class FakeScope:
    """_persist_outline 只用到 add / flush / commit，不需要真数据库。"""

    def __init__(self) -> None:
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


def _course() -> Course:
    return Course(id="course-1", user_id="u1", topic="Transformer", title="Transformer")


def _outline(chapters: list[dict]) -> dict:
    return {"title": "T", "description": "d", "chapters": chapters}


def _run(data: dict) -> FakeScope:
    scope = FakeScope()
    asyncio.run(_persist_outline(scope, _course(), data))  # type: ignore[arg-type]
    return scope


def _by_title(scope: FakeScope) -> dict[str, Section]:
    return {s.title: s for s in scope.sections}


TWO_CHAPTERS = [
    {
        "title": "基础",
        "sections": [
            {"sid": "1.1", "title": "注意力", "prerequisites": []},
            {"sid": "1.2", "title": "QKV", "prerequisites": ["1.1"]},
        ],
    },
    {
        "title": "深入",
        "sections": [
            # 多前置：这正是「不能砍成树」的那种情况
            {"sid": "2.1", "title": "多头", "prerequisites": ["1.1", "1.2"]},
            {"sid": "2.2", "title": "位置编码", "prerequisites": []},
        ],
    },
]


class Test依赖翻译:
    def test_sid_被翻成真实的_section_id(self):
        scope = _run(_outline(TWO_CHAPTERS))
        s = _by_title(scope)
        assert s["QKV"].prerequisite_ids == [s["注意力"].id]
        # 存的必须是真 id，绝不能是 "1.1" 这种编号
        assert "1.1" not in s["QKV"].prerequisite_ids

    def test_多前置全部保留(self):
        scope = _run(_outline(TWO_CHAPTERS))
        s = _by_title(scope)
        assert set(s["多头"].prerequisite_ids) == {s["注意力"].id, s["QKV"].id}

    def test_没有前置的小节是空数组(self):
        scope = _run(_outline(TWO_CHAPTERS))
        s = _by_title(scope)
        assert s["注意力"].prerequisite_ids == []
        assert s["位置编码"].prerequisite_ids == []

    def test_兼容模型输出旧字段名(self):
        # prompt 改过字段名，但模型偶尔还会吐旧的
        scope = _run(
            _outline(
                [
                    {
                        "title": "章",
                        "sections": [
                            {"sid": "1.1", "title": "A"},
                            {"sid": "1.2", "title": "B", "prerequisite_ids": ["1.1"]},
                        ],
                    }
                ]
            )
        )
        s = _by_title(scope)
        assert s["B"].prerequisite_ids == [s["A"].id]


class Test剪掉坏边:
    def test_指向后面小节的依赖被剪掉(self):
        """前置不可能排在后面。模型偶尔会把方向搞反，留着就会成环。"""
        scope = _run(
            _outline(
                [
                    {
                        "title": "章",
                        "sections": [
                            {"sid": "1.1", "title": "A", "prerequisites": ["1.2"]},
                            {"sid": "1.2", "title": "B"},
                        ],
                    }
                ]
            )
        )
        s = _by_title(scope)
        assert s["A"].prerequisite_ids == []

    def test_自引用被剪掉(self):
        scope = _run(
            _outline([{"title": "章", "sections": [{"sid": "1.1", "title": "A", "prerequisites": ["1.1"]}]}])
        )
        assert _by_title(scope)["A"].prerequisite_ids == []

    def test_指向不存在的_sid_被剪掉(self):
        scope = _run(
            _outline(
                [{"title": "章", "sections": [{"sid": "1.1", "title": "A", "prerequisites": ["9.9"]}]}]
            )
        )
        assert _by_title(scope)["A"].prerequisite_ids == []

    def test_重复依赖只留一份(self):
        scope = _run(
            _outline(
                [
                    {
                        "title": "章",
                        "sections": [
                            {"sid": "1.1", "title": "A"},
                            {"sid": "1.2", "title": "B", "prerequisites": ["1.1", "1.1"]},
                        ],
                    }
                ]
            )
        )
        s = _by_title(scope)
        assert s["B"].prerequisite_ids == [s["A"].id]

    def test_全图无环(self):
        """把「只指向更早」这条性质直接验一遍：拓扑序必然存在。"""
        scope = _run(_outline(TWO_CHAPTERS))
        order = [s.id for s in scope.sections]
        rank = {sid: i for i, sid in enumerate(order)}
        for s in scope.sections:
            for dep in s.prerequisite_ids:
                assert rank[dep] < rank[s.id], "依赖必须指向更早的小节"


class Test结构:
    def test_没有小节的空壳章被丢弃(self):
        # 截断修复后最后一章常常只剩个标题，留着会显示成点不开的空章节
        scope = _run(
            _outline(
                [
                    {"title": "有内容", "sections": [{"sid": "1.1", "title": "A"}]},
                    {"title": "空壳", "sections": []},
                ]
            )
        )
        assert [c.title for c in scope.chapters] == ["有内容"]

    def test_模型没给_sid_时按位置兜底(self):
        scope = _run(
            _outline(
                [
                    {
                        "title": "章",
                        "sections": [
                            {"title": "A"},  # 没有 sid
                            {"title": "B", "prerequisites": ["1.1"]},  # 引用位置编号
                        ],
                    }
                ]
            )
        )
        s = _by_title(scope)
        assert s["B"].prerequisite_ids == [s["A"].id]

    def test_一章都没有时报错而不是落一门空课(self):
        try:
            _run(_outline([]))
        except ValueError:
            return
        raise AssertionError("空大纲应该抛 ValueError")

    def test_成功后课程状态置为_ready(self):
        scope = FakeScope()
        course = _course()
        asyncio.run(_persist_outline(scope, course, _outline(TWO_CHAPTERS)))  # type: ignore[arg-type]
        assert course.status == COURSE_READY
        assert course.error is None
        assert course.title == "T"


def _独立运行() -> int:
    import inspect
    import traceback

    ok = bad = 0
    for cls in (Test依赖翻译, Test剪掉坏边, Test结构):
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
    sys.exit(_独立运行())
