"""中文分词。

PLAN §3.6 明确：中文全文检索需在 Python 侧用 jieba 分词后再写入索引，
别指望 zhparser。这条对 SQLite FTS5 同样成立 —— FTS5 的默认
unicode61 分词器会把整句中文当成一个 token，等于检索失效。
"""

from __future__ import annotations

import re
import threading

_jieba = None
_lock = threading.Lock()

# 停用词：只挡最高频的虚词，宁缺毋滥
_STOP = {
    "的", "了", "和", "是", "在", "我", "有", "就", "不", "人", "都", "一",
    "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看",
    "好", "自己", "这", "那", "个", "them", "the", "a", "an", "of", "to",
    "is", "are", "and", "or", "in", "on", "for", "it", "this", "that",
}

_PUNCT = re.compile(r"[\s\u3000!-/:-@\[-`{-~！-｝、。，；：？！“”‘’（）《》【】…—·]+")


def _get_jieba():
    global _jieba
    if _jieba is None:
        with _lock:
            if _jieba is None:
                import jieba

                jieba.setLogLevel(60)  # 关掉首次加载词典的日志
                _jieba = jieba
    return _jieba


def tokenize(text: str, *, for_query: bool = False) -> list[str]:
    """切成 token 列表。for_query=True 时用搜索引擎模式，召回更宽。"""
    if not text:
        return []
    jb = _get_jieba()
    raw = jb.cut_for_search(text) if for_query else jb.cut(text)
    out: list[str] = []
    for t in raw:
        t = t.strip().lower()
        if not t or _PUNCT.fullmatch(t):
            continue
        if t in _STOP:
            continue
        if len(t) == 1 and not ("\u4e00" <= t <= "\u9fff") and not t.isdigit():
            continue  # 单个英文字母无检索价值，单个汉字保留
        out.append(t)
    return out


def to_index_text(text: str) -> str:
    """生成写入索引列的空格分隔文本。"""
    return " ".join(tokenize(text))


def to_fts_query(text: str, *, mode: str = "or") -> str:
    """把用户查询转成 FTS5 MATCH 表达式。

    必须转义引号，否则用户输入一个 `"` 就能让 FTS5 语法报错
    （这也是一条注入面）。
    """
    tokens = tokenize(text, for_query=True)
    if not tokens:
        return ""
    quoted = [f'"{t}"' for t in (t.replace('"', "") for t in tokens) if t]
    if not quoted:
        return ""
    joiner = " OR " if mode == "or" else " AND "
    return joiner.join(quoted)
