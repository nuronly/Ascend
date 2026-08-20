"""从还没写完的 JSON 里逐个取出已闭合的对象。

为什么需要它：模型规划十几个概念要想 20~30 秒，一次性等它写完，用户就在盯着
空白 —— 而每个概念在生成出来的那一刻就已经可以勾了。这个解析器把「等全部」
变成「来一个用一个」，校准页因此从「读进度条」变成「刷题」。

它必须扛住流式的全部恶意：分片可能切在任何位置（字符串中间、转义反斜杠后面、
括号前后），而概念的解释文字里完全可能出现 `{`、`}` 和转义引号。
一处配对错乱就会漏题或吐出乱码。

没装 pytest 也能跑：python tests/test_jsonstream.py
"""

from __future__ import annotations

import sys
from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
if str(_BACKEND) not in sys.path:
    sys.path.insert(0, str(_BACKEND))

from app.llm import JsonArrayStream  # noqa: E402


def _feed_all(text: str, *, key: str = "concepts", size: int = 0) -> list[dict]:
    """按 size 字符切片喂进去（size=0 表示一次性喂完）。"""
    s = JsonArrayStream(key)
    out: list[dict] = []
    if size <= 0:
        return s.feed(text)
    for i in range(0, len(text), size):
        out.extend(s.feed(text[i : i + size]))
    return out


DOC = (
    '{"total": 3, "concepts": ['
    '{"name": "矩阵乘法", "depth": 1, "probe": ""},'
    '{"name": "softmax", "depth": 2, "probe": "为什么它对最大值敏感？"},'
    '{"name": "自注意力", "depth": 3, "probe": "为什么除以根号 d？"}'
    '], "goals": [{"kind": "build", "label": "能自己实现"}]}'
)


class Test逐个取出:
    def test_一次性喂完取到全部(self):
        got = _feed_all(DOC)
        assert [c["name"] for c in got] == ["矩阵乘法", "softmax", "自注意力"]

    def test_逐字符喂也一样(self):
        """流式最恶劣的情况：每个分片只有一个字符。"""
        got = _feed_all(DOC, size=1)
        assert [c["name"] for c in got] == ["矩阵乘法", "softmax", "自注意力"]

    def test_各种分片大小结果一致(self):
        for size in (2, 3, 5, 7, 13, 64):
            got = _feed_all(DOC, size=size)
            assert len(got) == 3, f"分片 {size} 时只取到 {len(got)} 个"

    def test_对象是一到就给_不等数组闭合(self):
        """这正是「刷题」的前提：第一道不能等最后一道写完。"""
        s = JsonArrayStream("concepts")
        # 对象还没闭合 → 什么都不给
        assert s.feed('{"total": 3, "concepts": [{"name": "A", "depth": 1') == []
        # 闭合括号一到就产出，此时数组、整份 JSON 都还远没写完
        assert [c["name"] for c in s.feed("}")] == ["A"]

    def test_写到一半的对象不会被吐出来(self):
        s = JsonArrayStream("concepts")
        assert s.feed('{"concepts": [{"name": "半截') == []


class Test字符串里的捣蛋鬼:
    def test_解释文字里的花括号不能干扰配对(self):
        doc = '{"concepts": [{"name": "集合", "gloss": "写成 {a, b} 的东西"}]}'
        got = _feed_all(doc)
        assert got[0]["gloss"] == "写成 {a, b} 的东西"

    def test_转义引号不能提前结束字符串(self):
        doc = '{"concepts": [{"name": "引号", "gloss": "他说\\"好\\"，然后走了"}]}'
        got = _feed_all(doc)
        assert got[0]["gloss"] == '他说"好"，然后走了'

    def test_结尾反斜杠恰好被切开也不能乱(self):
        """分片切在转义符和被转义字符之间 —— 状态必须跨分片保持。"""
        doc = '{"concepts": [{"name": "路径", "gloss": "C:\\\\dir"}]}'
        for size in (1, 2, 3, 4, 9):
            got = _feed_all(doc, size=size)
            assert got and got[0]["gloss"] == "C:\\dir", f"分片 {size} 出错"

    def test_方括号出现在字符串里也不会误判数组结束(self):
        doc = '{"concepts": [{"name": "下标", "gloss": "写作 a[i]"},{"name": "第二个"}]}'
        got = _feed_all(doc, size=3)
        assert [c["name"] for c in got] == ["下标", "第二个"]


class Test边界情况:
    def test_数组还没出现时什么都不给(self):
        s = JsonArrayStream("concepts")
        assert s.feed('{"total": 15, "note": "还没到 conce') == []

    def test_只认指定的键(self):
        doc = '{"goals": [{"kind": "build"}], "concepts": [{"name": "A"}]}'
        got = _feed_all(doc, key="concepts")
        assert [c["name"] for c in got] == ["A"]

    def test_数组闭合之后的对象不再算进来(self):
        """goals 在 concepts 后面，不能被当成概念一起吐出来。"""
        got = _feed_all(DOC, size=4)
        assert all("kind" not in c for c in got)
        assert len(got) == 3

    def test_坏对象跳过而不是炸掉整条流(self):
        """模型偶发写出不合法的一项时，其余的还要能用。"""
        doc = '{"concepts": [{"name": "好的"},{"name": 中文没引号},{"name": "也好的"}]}'
        got = _feed_all(doc)
        assert [c["name"] for c in got] == ["好的", "也好的"]

    def test_空数组(self):
        assert _feed_all('{"concepts": []}') == []

    def test_嵌套对象算作同一条(self):
        doc = '{"concepts": [{"name": "A", "meta": {"x": {"y": 1}}},{"name": "B"}]}'
        got = _feed_all(doc, size=5)
        assert [c["name"] for c in got] == ["A", "B"]
        assert got[0]["meta"]["x"]["y"] == 1


# ─────────────────────────────────────────────────────────────
def _独立运行() -> int:
    ok = failed = 0
    for cls in (Test逐个取出, Test字符串里的捣蛋鬼, Test边界情况):
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
