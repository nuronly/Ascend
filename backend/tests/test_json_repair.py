"""被截断的 LLM JSON 输出的修复逻辑。

大纲是这套系统里唯一"格式错一个字符就整份报废"的产物：
正文截断了还能读，JSON 截断了就是 100% 失败。所以这里的边界要钉死。

没装 pytest 也能跑：python tests/test_json_repair.py
（本项目所有测试都要能这样单跑 —— 服务器和干净环境里都没有 pytest）
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

import pytest  # noqa: E402

from app.llm import extract_json, repair_truncated_json  # noqa: E402


class TestRepairTruncatedJson:
    def test_完整的_json_不该被改动(self):
        # 返回 None 表示"没截断，不归我管"，避免对健康数据做无谓手术
        assert repair_truncated_json('{"a": [1, 2, 3]}') is None

    def test_数组尾部截断(self):
        assert repair_truncated_json('{"a": [1, 2, 3') == '{"a": [1, 2]}'

    def test_对象写到一半就断了(self):
        src = '{"chapters": [{"t": 1}, {"t": 2}, {"title": "第5章'
        assert repair_truncated_json(src) == '{"chapters": [{"t": 1}, {"t": 2}]}'

    def test_字符串里的括号和转义引号不能干扰括号配对(self):
        src = '{"c": [{"t": "a\\"b} ["}, {"t": "半'
        got = repair_truncated_json(src)
        assert got == '{"c": [{"t": "a\\"b} ["}]}'
        assert json.loads(got)["c"] == [{"t": 'a"b} ['}]

    def test_括号对不上说明是坏数据而非截断(self):
        assert repair_truncated_json('{"a": ]}') is None

    def test_只写出一个键就断了(self):
        assert repair_truncated_json('{"title": "abc", "chapters": [') == '{"title": "abc"}'

    def test_空输入(self):
        assert repair_truncated_json("") is None

    @pytest.mark.parametrize(
        "src",
        [
            '{"a": [1, 2, 3',
            '{"chapters": [{"t": 1}, {"title": "断',
            '[{"x": 1}, {"y": [2, 3',
            '{"a": {"b": {"c": [1,',
        ],
    )
    def test_修复结果必须是合法_json(self, src: str):
        got = repair_truncated_json(src)
        assert got is not None
        json.loads(got)  # 不抛异常即通过


class TestOutlineRecovery:
    """真实场景：一份 Transformer 大纲在第 3 章的 summary 里耗尽了 token。"""

    RAW = (
        '{ "title": "图解 Transformer", "description": "讲注意力机制。", "chapters": [\n'
        ' { "title": "第 1 章 为什么需要注意力", "summary": "从困境说起",\n'
        '   "sections": [ {"sid":"1.1","title":"RNN 的长程依赖","est_minutes":20,'
        '"key_concepts":["RNN"],"prerequisite_ids":[]} ] },\n'
        ' { "title": "第 2 章 QKV", "summary": "查询键值",\n'
        '   "sections": [ {"sid":"2.1","title":"三个向量","est_minutes":25,'
        '"key_concepts":["Query"],"prerequisite_ids":["1.1"]} ] },\n'
        ' { "title": "第 3 章 自注意力", "summary": "用阅读长文本、找人等日常场景引入'
    )

    def test_原始输出确实解析不了(self):
        with pytest.raises(ValueError):
            extract_json(self.RAW)

    def test_修复后能救回前面的完整章节(self):
        data = json.loads(repair_truncated_json(self.RAW))
        assert data["title"] == "图解 Transformer"
        assert len(data["chapters"]) == 3

    def test_语法修复救回的第三章是残缺的(self):
        """语法上合法 ≠ 语义上可用 —— 第 3 章断在 summary 里，没有 sections。"""
        data = json.loads(repair_truncated_json(self.RAW))
        assert data["chapters"][2].get("sections") is None

    def test_落库前的清洗会丢掉空壳章(self):
        """与 _persist_outline 里的过滤保持一致：没有小节的章不能进库，
        否则课程页会出现一个点不开的空章节。"""
        data = json.loads(repair_truncated_json(self.RAW))
        kept = [
            c for c in data["chapters"] if isinstance(c, dict) and (c.get("sections") or [])
        ]
        assert len(kept) == 2
        assert [c["title"] for c in kept] == ["第 1 章 为什么需要注意力", "第 2 章 QKV"]


# ─────────────────────────────────────────────────────────────
def _独立运行() -> int:
    """没装 pytest 时的 runner。

    这个文件是套件里唯一用了 parametrize 的，所以 runner 要自己把参数拆开跑 ——
    否则它就成了"只有装了 pytest 才跑得动"的孤例，而服务器上没有 pytest。
    """
    ok = failed = 0
    for cls in (TestRepairTruncatedJson, TestOutlineRecovery):
        inst = cls()
        for name in sorted(n for n in dir(inst) if n.startswith("test_")):
            fn = getattr(inst, name)
            cases: list[tuple] = [()]
            for mark in getattr(fn, "pytestmark", []):
                if getattr(mark, "name", "") == "parametrize":
                    values = mark.args[1]
                    cases = [v if isinstance(v, tuple) else (v,) for v in values]
            for args in cases:
                try:
                    fn(*args)
                    ok += 1
                except Exception as exc:  # noqa: BLE001
                    failed += 1
                    print(f"  ✗ {cls.__name__}.{name}{args or ''}: {exc!r}")
    print(f"通过 {ok} · 失败 {failed}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(_独立运行())
