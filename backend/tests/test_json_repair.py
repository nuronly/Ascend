"""被截断的 LLM JSON 输出的修复逻辑。

大纲是这套系统里唯一"格式错一个字符就整份报废"的产物：
正文截断了还能读，JSON 截断了就是 100% 失败。所以这里的边界要钉死。
"""

from __future__ import annotations

import json

import pytest

from app.llm import extract_json, repair_truncated_json


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
