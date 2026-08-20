"""第二大脑：GraphRAG-lite（PLAN §3.6）。

核心洞察：**你的知识本来就是结构化的，检索不必只靠向量。**

普通 RAG 用向量，是因为它面对无结构文本堆，只能靠语义相似度捞。
而我们每条知识天生带着：课程 → 章 → 节 → 番茄 → 卡片父子链 →
图节点 → 时间戳 → 触碰次数。这是一张真正的知识图，
**图遍历 + 关键词比向量更精确、更可解释。**

边界（已定）：只吃本产品内产生的学习记录，不做通用文档问答。
"""

from __future__ import annotations

import logging
import math
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import select

from app.core.config import TIER_FLAGSHIP, TIER_SMALL
from app.core.scope import UserScope
from app.core.types import utcnow
from app.llm import Message, chat_json, embed, stream_chat
from app.models.card import LINK_REAL, STATE_VAULT, Card
from app.models.course import Chapter, Course, Section
from app.models.system import CardSearch
from app.search.fts import search_cards_fts
from app.services import prompts

log = logging.getLogger(__name__)

RRF_K = 60  # Reciprocal Rank Fusion 的平滑常数，60 是文献里的常用值


# ─────────────────────────────────────────────────────────────
# 第 2 步：多路召回
# ─────────────────────────────────────────────────────────────
async def _recall_fulltext(scope: UserScope, query: str, limit: int) -> list[str]:
    """路 1：全文检索（jieba + FTS5 / tsvector）。"""
    return [cid for cid, _ in await search_cards_fts(scope.session, scope.user_id, query, limit)]


async def _recall_vector(scope: UserScope, query: str, limit: int) -> list[str]:
    """路 2：向量召回。

    ⚠️ 必须**先按 user_id 过滤再算相似度**。反过来做（先 ANN 后过滤）
    会漏召回，而且可能跨用户 —— pgvector 的经典陷阱（PLAN §4.2 陷阱 4）。
    这里 SQLite 侧天然先过滤，切 PG 后也要保持这个顺序。
    """
    try:
        import numpy as np

        qvec = (await embed([query], user_id=scope.user_id, scene="brain_query"))[0]
        if not qvec:
            return []

        rows = list(
            (
                await scope.session.execute(
                    select(CardSearch.card_id, CardSearch.embedding)
                    .join(Card, Card.id == CardSearch.card_id)
                    .where(
                        CardSearch.user_id == scope.user_id,  # ← 先过滤
                        Card.user_id == scope.user_id,
                        Card.state == STATE_VAULT,
                        CardSearch.embedding.is_not(None),
                    )
                )
            ).all()
        )
        if not rows:
            return []

        ids = [r[0] for r in rows]
        mat = np.asarray([r[1] for r in rows], dtype=np.float32)
        q = np.asarray(qvec, dtype=np.float32)
        denom = (np.linalg.norm(mat, axis=1) * np.linalg.norm(q)) + 1e-9
        sims = (mat @ q) / denom
        order = np.argsort(-sims)[:limit]
        return [ids[i] for i in order]
    except Exception:
        log.warning("向量召回不可用，降级为其它三路", exc_info=True)
        return []


async def _recall_graph(scope: UserScope, seeds: list[str], hops: int = 2) -> list[str]:
    """路 3：图扩散 —— 这是别人没有的一路。

    命中节点后沿 real link 与父子链走 1~2 跳，把邻居捞上来。
    ⚠️ 每跳都要校验 owner（scope.neighbor_card_ids 内部做了三重校验）。
    """
    if not seeds:
        return []
    seen = set(seeds)
    frontier = list(seeds)
    out: list[str] = []

    for _ in range(hops):
        if not frontier:
            break
        nxt = await scope.neighbor_card_ids(frontier, kinds=(LINK_REAL,))

        # 父子链同样是语义相邻，一并纳入
        kin = set(
            await scope.session.scalars(
                scope.select(Card, Card.id).where(Card.parent_card_id.in_(frontier))
            )
        )
        parents = set(
            await scope.session.scalars(
                scope.select(Card, Card.parent_card_id).where(
                    Card.id.in_(frontier), Card.parent_card_id.is_not(None)
                )
            )
        )
        step = (nxt | kin | parents) - seen
        if not step:
            break
        out.extend(step)
        seen |= step
        frontier = list(step)

    return out


def _rrf(rankings: list[list[str]], weights: list[float] | None = None) -> list[tuple[str, float]]:
    """Reciprocal Rank Fusion：把多路结果合成一个排序。

    比加权求和稳健得多 —— 各路的分数量纲完全不同（BM25 vs 余弦 vs 跳数），
    直接相加没有意义，只有名次是可比的。
    """
    weights = weights or [1.0] * len(rankings)
    scores: dict[str, float] = {}
    for w, ranking in zip(weights, rankings, strict=False):
        for rank, cid in enumerate(ranking):
            scores[cid] = scores.get(cid, 0.0) + w / (RRF_K + rank + 1)
    return sorted(scores.items(), key=lambda kv: -kv[1])


async def _structural_boost(scope: UserScope, cards: list[Card]) -> dict[str, float]:
    """路 4：结构过滤加权。

    这些信号只有我们有：己见 = 真正内化过的，触碰多 = 反复回看的，
    新鲜 = 当前正在学的。用它们做加权，比纯语义相似度贴近用户意图。
    """
    now = utcnow()
    boost: dict[str, float] = {}
    for c in cards:
        b = 1.0
        if c.is_rewritten:
            b += 0.35  # 己见卡优先 —— 那是他真正内化了的部分
        b += min(c.touch_count, 10) * 0.02
        age_days = max((now - c.created_at).total_seconds() / 86400, 0)
        b += 0.25 * math.exp(-age_days / 45)  # 近 45 天内的记忆更可能被追问
        boost[c.id] = b
    return boost


@dataclass
class RecallTrace:
    """各路召回的中间结果。

    暴露它是为了让前端能把检索过程**演出来**（神经网络可视化）：
    哪些节点被全文命中、哪些是向量捞的、图扩散又从哪些种子走出去。
    这不只是好看 —— 它让「为什么答案引用了这几条」变得可解释，
    而可解释性正是 GraphRAG 相对于黑箱向量检索的核心优势。
    """

    fulltext: list[str]
    vector: list[str]
    graph: list[str]
    seeds: list[str]
    fused: list[tuple[str, float]]


async def retrieve_traced(
    scope: UserScope, query: str, *, top_k: int = 20, use_vector: bool = True
) -> tuple[list[Card], RecallTrace]:
    """多路召回 + RRF 融合，同时保留过程轨迹。"""
    ft = await _recall_fulltext(scope, query, 30)
    vec = await _recall_vector(scope, query, 30) if use_vector else []
    seeds = (ft[:5] + vec[:5])[:8]
    graph = await _recall_graph(scope, seeds)

    fused = _rrf([ft, vec, graph], weights=[1.0, 0.9, 0.6])
    trace = RecallTrace(fulltext=ft, vector=vec, graph=graph, seeds=seeds, fused=fused)
    if not fused:
        return [], trace

    ids = [cid for cid, _ in fused[: top_k * 3]]
    cards = await scope.all(
        scope.select(Card).where(Card.id.in_(ids), Card.state == STATE_VAULT)
    )
    boost = await _structural_boost(scope, cards)
    base = dict(fused)
    cards.sort(key=lambda c: -(base.get(c.id, 0.0) * boost.get(c.id, 1.0)))
    return cards[:top_k], trace


async def retrieve(
    scope: UserScope, query: str, *, top_k: int = 20, use_vector: bool = True
) -> list[Card]:
    cards, _ = await retrieve_traced(scope, query, top_k=top_k, use_vector=use_vector)
    return cards


# ─────────────────────────────────────────────────────────────
# 第 3 步：LLM 重排
# ─────────────────────────────────────────────────────────────
def _snippet(c: Card) -> str:
    return "\n".join(
        filter(
            None,
            [
                f"【{c.selected_text}】" if c.selected_text else "",
                f"问：{c.question}" if c.question else "",
                f"答：{c.ai_answer[:900]}" if c.ai_answer else "",
                f"我的理解：{c.user_note[:600]}" if c.user_note else "",
            ],
        )
    )


async def rerank(
    scope: UserScope, query: str, cards: list[Card], keep: int = 5, *, quota: int | None = None
) -> list[Card]:
    """小模型只做相关性打分 —— 这个档位完全够（PLAN §4.1 分级路由）。"""
    if len(cards) <= keep:
        return cards
    try:
        data = await chat_json(
            [
                Message(role="system", content=prompts.RERANK_SYSTEM),
                Message(
                    role="user",
                    content=prompts.rerank_user(
                        query, [{"id": c.id, "text": _snippet(c)} for c in cards]
                    ),
                ),
            ],
            scene="brain_rerank",
            tier=TIER_SMALL,
            user_id=scope.user_id,
            temperature=0.1,
            max_tokens=1200,
            quota=quota,
        )
    except Exception:
        log.warning("重排失败，按融合分数截断", exc_info=True)
        return cards[:keep]

    order = {
        str(p.get("id")): float(p.get("score") or 0)
        for p in (data.get("picked") or [])
        if p.get("id")
    }
    picked = [c for c in cards if c.id in order]
    picked.sort(key=lambda c: -order[c.id])
    return picked[:keep] if picked else cards[:keep]


# ─────────────────────────────────────────────────────────────
# 第 4 步：带引用回答
# ─────────────────────────────────────────────────────────────
async def _cite_meta(scope: UserScope, cards: list[Card]) -> dict[str, dict]:
    """给每条引用附上"这是学什么的时候产生的"，让答案可溯源。"""
    section_ids = {c.source_section_id for c in cards if c.source_section_id}
    origins: dict[str, dict] = {}
    if section_ids:
        rows = await scope.session.execute(
            select(Section.id, Section.title, Course.id, Course.title)
            .join(Chapter, Chapter.id == Section.chapter_id)
            .join(Course, Course.id == Chapter.course_id)
            .where(Section.id.in_(section_ids), Course.user_id == scope.user_id)
        )
        origins = {
            sid: {"section_id": sid, "section_title": st, "course_id": cid, "course_title": ct}
            for sid, st, cid, ct in rows
        }
    return origins


async def answer_stream(
    scope: UserScope,
    query: str,
    *,
    history: list[dict] | None = None,
    quota: int | None = None,
) -> AsyncIterator[dict]:
    yield {"event": "status", "data": {"stage": "retrieving", "text": "正在检索你的学习记录…"}}

    candidates, trace = await retrieve_traced(scope, query)

    # 把四路召回的中间结果逐个抛给前端，让神经网络能同步演出激活过程。
    # 顺序刻意与实际检索顺序一致：关键词 → 向量 → 沿突触扩散 → 融合。
    yield {
        "event": "recall",
        "data": {
            "stage": "fulltext",
            "label": "关键词命中",
            "ids": trace.fulltext[:30],
        },
    }
    if trace.vector:
        yield {
            "event": "recall",
            "data": {"stage": "vector", "label": "语义相近", "ids": trace.vector[:30]},
        }
    if trace.graph:
        yield {
            "event": "recall",
            "data": {
                "stage": "graph",
                "label": "沿连接扩散",
                "ids": trace.graph[:40],
                "seeds": trace.seeds,
            },
        }
    yield {
        "event": "recall",
        "data": {
            "stage": "fused",
            "label": "融合排序",
            "ids": [cid for cid, _ in trace.fused[:20]],
        },
    }

    if not candidates:
        yield {
            "event": "empty",
            "data": {
                "message": "你的学习记录里还没有涉及这个话题。"
                "先去学一节相关的课，或者划词问几个问题，我才有东西可以回忆。"
            },
        }
        return

    yield {
        "event": "status",
        "data": {"stage": "reranking", "text": f"找到 {len(candidates)} 条，正在筛选…"},
    }
    picked = await rerank(scope, query, candidates, quota=quota)

    origins = await _cite_meta(scope, picked)
    citations = [
        {
            "id": c.id,
            "label": c.summary or c.selected_text or c.question[:40],
            "selected_text": c.selected_text,
            "is_rewritten": c.is_rewritten,
            "created_at": c.created_at.isoformat(),
            "origin": origins.get(c.source_section_id or "", {}),
        }
        for c in picked
    ]
    yield {"event": "citations", "data": {"citations": citations}}

    snippets = [
        {
            "id": c.id,
            "text": _snippet(c),
            "source": (origins.get(c.source_section_id or "") or {}).get("section_title", ""),
            "created_at": c.created_at.strftime("%Y-%m-%d"),
            "is_rewritten": c.is_rewritten,
        }
        for c in picked
    ]

    # 终答用旗舰模型 —— 质量直接决定产品可信度（PLAN §4.1）
    try:
        async for chunk in stream_chat(
            [
                Message(role="system", content=prompts.BRAIN_SYSTEM),
                Message(role="user", content=prompts.brain_user(query, snippets, history)),
            ],
            scene="brain_answer",
            tier=TIER_FLAGSHIP,
            user_id=scope.user_id,
            temperature=0.4,
            max_tokens=2500,
            quota=quota,
        ):
            if chunk.done:
                break
            yield {"event": "delta", "data": {"text": chunk.delta}}
    except Exception as exc:
        yield {"event": "error", "data": {"message": str(exc)[:400]}}
        return

    # 被引用过 = 被回想起来了，计入触碰，影响孤岛判定
    for c in picked:
        c.touch_count += 1
        c.last_touched_at = utcnow()
    await scope.commit()

    yield {"event": "done", "data": {"citation_count": len(picked)}}


# ─────────────────────────────────────────────────────────────
# 向量索引维护
# ─────────────────────────────────────────────────────────────
async def embed_card(scope: UserScope, card: Card) -> bool:
    row = await scope.session.get(CardSearch, card.id)
    if row is None or row.embedding is not None:
        return False
    text = row.tsv or _snippet(card)
    if not text.strip():
        return False
    try:
        vecs = await embed([text[:4000]], user_id=scope.user_id, scene="embed_card")
    except Exception:
        log.warning("卡片向量化失败（不影响其它召回路）", exc_info=True)
        return False
    if vecs and vecs[0]:
        row.embedding = vecs[0]
        row.embedded_at = utcnow()
        await scope.commit()
        return True
    return False


async def reindex_missing(scope: UserScope, limit: int = 100) -> int:
    """批量补齐缺失的向量。

    向量是唯一**有模型成本**的沉淀环节，所以不像复习排程那样在入口自动补，
    而是留一个显式端点（POST /brain/reindex）。缺了只是少一路召回，
    其它三路照常工作。
    """
    rows = await scope.all(
        select(CardSearch)
        .join(Card, Card.id == CardSearch.card_id)
        .where(
            CardSearch.user_id == scope.user_id,
            Card.user_id == scope.user_id,
            Card.state == STATE_VAULT,
            CardSearch.embedding.is_(None),
        )
        .limit(limit)
    )
    done = 0
    for row in rows:
        card = await scope.get(Card, row.card_id)
        if card and await embed_card(scope, card):
            done += 1
    return done


async def memory_network(scope: UserScope, limit: int = 800) -> dict:
    """整张记忆网络的快照。

    这是「第二大脑」的具象化：每张 vault 卡是一个神经元，
    父子链与 real link 是突触，FSRS 的 stability 决定它有多亮。
    快遗忘的节点会自然暗下去 —— 用户能**看到**自己正在遗忘什么。
    """
    from sqlalchemy import or_ as sa_or

    from app.models.card import CardLink
    from app.models.learning import ReviewState

    cards = await scope.all(
        scope.select(Card)
        .where(Card.state == STATE_VAULT)
        .order_by(Card.created_at)
        .limit(limit)
    )
    if not cards:
        return {"neurons": [], "synapses": [], "stats": {}, "generated_at": utcnow().isoformat()}

    ids = [c.id for c in cards]
    id_set = set(ids)

    review = {
        r.card_id: r
        for r in await scope.all(
            select(ReviewState).where(
                ReviewState.user_id == scope.user_id, ReviewState.card_id.in_(ids)
            )
        )
    }
    links = await scope.all(
        scope.select(CardLink).where(
            CardLink.from_card_id.in_(ids),
            CardLink.to_card_id.in_(ids),
            CardLink.dismissed_at.is_(None),
        )
    )

    # 课程归属：用于按学科分组着色
    section_ids = {c.source_section_id for c in cards if c.source_section_id}
    course_of: dict[str, str] = {}
    if section_ids:
        rows = await scope.session.execute(
            select(Section.id, Course.id, Course.title)
            .join(Chapter, Chapter.id == Section.chapter_id)
            .join(Course, Course.id == Chapter.course_id)
            .where(Section.id.in_(section_ids), Course.user_id == scope.user_id)
        )
        course_of = {sid: cid for sid, cid, _ in rows}

    now = utcnow()
    degree: dict[str, int] = {c.id: 0 for c in cards}
    for c in cards:
        if c.parent_card_id in id_set:
            degree[c.id] += 1
            degree[c.parent_card_id] += 1
    for link in links:
        degree[link.from_card_id] += 1
        degree[link.to_card_id] += 1

    neurons = []
    for c in cards:
        st = review.get(c.id)
        # 记忆强度 → 亮度。stability 以天为单位，取对数压缩到 0~1
        stability = float(st.stability or 0) if st else 0.0
        strength = min(1.0, math.log1p(max(stability, 0)) / math.log1p(120))
        due = bool(st and st.due_date <= now)
        neurons.append(
            {
                "id": c.id,
                "label": c.summary or c.selected_text or c.question[:30],
                "term": c.selected_text,
                "depth": c.depth,
                "rewritten": c.is_rewritten,
                "touch": c.touch_count,
                "degree": degree.get(c.id, 0),
                "strength": round(strength, 3),
                "due": due,
                # 无连接、无子卡、久未触碰 → 濒临遗忘，视觉上几乎熄灭
                "isolated": degree.get(c.id, 0) == 0,
                "reps": st.reps if st else 0,
                "created_at": c.created_at.isoformat(),
                "course_id": course_of.get(c.source_section_id or "", ""),
                "tags": list(c.concept_tags or [])[:4],
            }
        )

    synapses = [
        {"a": c.parent_card_id, "b": c.id, "kind": "parent"}
        for c in cards
        if c.parent_card_id in id_set
    ] + [
        {
            "a": link.from_card_id,
            "b": link.to_card_id,
            "kind": link.kind,
            "relation": link.relation,
        }
        for link in links
    ]

    strengths = [n["strength"] for n in neurons]
    isolated = sum(1 for n in neurons if n["isolated"])
    return {
        "neurons": neurons,
        "synapses": synapses,
        "stats": {
            "neurons": len(neurons),
            "synapses": len(synapses),
            "rewritten": sum(1 for n in neurons if n["rewritten"]),
            "due": sum(1 for n in neurons if n["due"]),
            "isolated": isolated,
            "isolation_rate": round(isolated / len(neurons), 3),
            "avg_strength": round(sum(strengths) / len(strengths), 3),
            "max_depth": max((n["depth"] for n in neurons), default=0),
            "density": round(len(synapses) / max(len(neurons), 1), 2),
        },
        "generated_at": utcnow().isoformat(),
    }


async def recent_context(scope: UserScope, days: int = 7, limit: int = 5) -> list[Card]:
    """最近学过什么 —— 给第二大脑首页做「继续聊」的引子。"""
    since = utcnow() - timedelta(days=days)
    return await scope.all(
        scope.select(Card)
        .where(Card.state == STATE_VAULT, Card.created_at >= since)
        .order_by(Card.created_at.desc())
        .limit(limit)
    )
