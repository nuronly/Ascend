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
from typing import Any

from sqlalchemy import select

from app.core.config import TIER_FLAGSHIP, TIER_SMALL
from app.core.scope import UserScope
from app.core.types import utcnow
from app.llm import Message, ThinkingBuffer, chat_json, embed, stream_chat
from app.models.card import KIND_NOTE, LINK_REAL, STATE_ARCHIVED, STATE_VAULT, Card
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
            # ★ 这里关思考链是对的，和终答那边不冲突：
            #   打个相关性分数不需要想，而且 chat_json 是**非流式**的 ——
            #   它的思考链没有任何办法展示出来，就是纯静默的一两秒。
            #   实测这一步中位 1.7 秒，占了首字延迟的一半。
            #   判据始终是「这段等待能不能变成用户看得见的内容」：
            #   能（终答的流式思考链）就留着，不能（这里）就关掉。
            thinking=False,
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
            "kind": c.kind,
        }
        for c in picked
    ]

    # ★ 四路召回只是**预热**：给模型一批摘要级候选。
    #   真要引用某份笔记的原话时，让它自己用 read_note 读当前全文 ——
    #   笔记是用户反复改的东西，截断片段既可能过时，又恰好砍掉后半的
    #   「我的理解」「我还没搞懂的」（最值钱的部分）。
    #   原则：索引用于发现，工具用于引用。
    from app.llm.tools.memory import memory_tools

    tools = memory_tools(scope)

    # 终答用旗舰模型 —— 质量直接决定产品可信度（PLAN §4.1）
    #
    # ★ 这条路刻意是**质量优先**的，和语音那条路的取舍正好相反：
    #   文本问答里用户看着屏幕，等待可以用「过程可见」来化解 —— 思考链、
    #   正在查什么、引用先落地。所以思考链在这里是**资产**（既是质量来源，
    #   也是等待期唯一有内容的东西），不该为了快关掉它。
    #   语音则相反：思考链没法读出来，是纯延迟，那条路要单独走。
    think = ThinkingBuffer()
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
            # ★ 12000 而不是 6000：带工具的多轮往返，每轮还有一条思考链。
            #   6000 会被思考链吃光然后正文零产出 —— 这个坑在大纲上踩过两次
            #   （router.chat 里那条「思维链吃光了 max_tokens」的警告就是为它加的）
            max_tokens=12000,
            quota=quota,
            tools=tools,
            # ★ 压到 2 轮，与正文/笔记一致。
            #   原来漏传这个参数，吃的是全局 tool_max_rounds=3 —— 而那个 3 是按
            #   大纲那种「值得多找几轮资料」的场景定的。实测 3 轮的样子：
            #   第 1 轮并行 4 个 search_memory + my_boundary，第 2 轮 5 个
            #   read_note + read_outline，第 3 轮又 2 个 read_outline。
            #   13 次调用**没有一次重复**（所以不是白调，是在广撒网），
            #   但第 3 轮的边际价值明显最低 —— 前两轮已经把卡片和笔记都拿到了。
            max_rounds=2,
        ):
            if chunk.done:
                break
            # 正在查什么、查到了什么，实时说出来（与大纲/正文一致的处理）
            if chunk.tool_event:
                if pending := think.flush():  # 想完了去查东西，先把那半句思考说完
                    yield pending
                ev = chunk.tool_event
                yield {
                    "event": f"tool_{ev.phase}",
                    "data": {
                        "name": ev.name,
                        "detail": ev.detail,
                        "items": (ev.payload or {}).get("items", []),
                        "ms": ev.ms,
                    },
                }
                continue
            # ★ 思维链原文透出去。
            #   原来这里是 `continue` —— 直接丢掉，理由是「避免和引用列表抢注意力」。
            #   但那样一来这段时间对用户就是纯空白：思考链既没换来可见的内容，
            #   又实打实占着几秒。而项目里早有现成的折叠展示（RunTimeline
            #   一行摘要 + 点开看全文），大纲和正文都在用，第二大脑没接上而已。
            if chunk.reasoning:
                if pending := think.add(chunk.reasoning):
                    yield pending
                continue
            if chunk.delta:
                if pending := think.flush():  # 开始说正文了，思考阶段收尾
                    yield pending
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


# ─────────────────────────────────────────────────────────────
# 记忆网络
# ─────────────────────────────────────────────────────────────
# 节点类型。★ 结构本身就是知识单元，不是脚手架 ——
#   学完一节课就是获得了一块知识，这跟划词提问获得一块知识是同一件事，
#   而且正文是主干、卡片只是旁支。原来这张网只画卡片，于是一个认真读完
#   十二节但不怎么划词的人，网络里几乎是空的 —— 他明明学了很多。
NODE_COURSE = "course"
NODE_CHAPTER = "chapter"
NODE_SECTION = "section"

# 结构节点的 id 前缀。
# ★ 卡片节点的 id 必须保持**裸 id**：第二大脑召回时点亮走的就是卡片 id
#   （brain.answer_stream 的 recall 事件），加了前缀就再也点不亮了。
#   所以前缀只加在结构节点上，顺带让前端能按前缀分派点击行为。
P_COURSE = "co:"
P_CHAPTER = "ch:"
P_SECTION = "sec:"

# 小节「掌握程度」的几档。
# ★ 这不是 FSRS 的 stability，是两种不同的量：卡片的强度来自真实复习记录，
#   小节的强度是学习进度的粗略代理。共用同一条亮度通道是刻意的（都在回答
#   「这块知识有多牢」），但 hover 文案必须分开说，不能管小节叫「记忆强度」。
SEC_READ = 0.35  # 生成过正文 = 至少读过
SEC_DONE = 0.70  # 标记学完
SEC_NOTE_BONUS = 0.30  # 收成过笔记 —— 亲手写过的那一节，记得最牢


def _card_strength(st: Any) -> float:
    """FSRS stability → 0~1。以天为单位，取对数压缩。"""
    stability = float(getattr(st, "stability", 0) or 0) if st else 0.0
    return min(1.0, math.log1p(max(stability, 0)) / math.log1p(120))


# 节点总量上限。
# ★ 力导向是 O(n²)（neural.ts 里有 300px 的距离剪枝，但量级不变）。
#   317 个节点约 5 万次配对/帧，还跑得动；20 门课 × 40 节 + 900 张卡 = 1700 个
#   节点就是 140 万次/帧，画面直接卡死。
#   超限时**先丢未点亮的小节** —— 它们信息量最低，而且丢了也不会失真：
#   它们所属的章还在，章上带着「已学 2/24 节」，「还有多少没走」这个信息不丢。
NODE_BUDGET = 620


async def memory_network(scope: UserScope, card_limit: int = 900) -> dict:
    """整张记忆网络的快照。

    ★ 骨架是课程结构，不是用户手建的连线

      原来的边只有两种来源：追问的父子链，和用户在卡片空间里手动拉的线。
      后者全库总共 3 条 —— 于是这张网实际画的是「你手动拉过几根线」，
      孤岛率 33%，连唯一那张永久笔记都被判成「孤岛（濒临遗忘）」，
      画成最小最暗的一点。系统里最有价值的单元，视觉上最不值钱。

      换成课程结构做骨架之后，孤岛问题**自动消失**：每张卡都属于某一节、
      每节属于某章、每章属于某课，任何节点都必然连在树上。而且信息量更大 ——
      一眼能看出「Transformer 上堆了一大团，CRISPR 只有孤零零三张」。

    ★ 为什么不是「同一章的卡两两相连」

      一章 20 张卡就是 190 条边，力导向会糊成一团黑，而斥力本身已经是 O(n²)。
      把章和节变成**真实节点**，边就退化成 O(n)：卡片挂在小节上，小节挂在章上，
      章按 idx 连成链。力导向自然形成「每章一个恒星，卡片围着转，章之间连成
      一串珠子」—— 视觉上就是一堆连在一起，但边数是线性的。

    ★ 章之间按 idx 连成链，而不是都连到课程中心
      那样能体现递进顺序，而顺序恰好是这套系统里最结构化的东西。
    """

    from app.models.card import CardLink
    from app.models.learning import ReviewState

    now = utcnow()
    neurons: list[dict] = []
    synapses: list[dict] = []

    # ── 1. 课程结构 ──
    rows = list(
        (
            await scope.session.execute(
                select(Course, Chapter, Section)
                .join(Chapter, Chapter.course_id == Course.id)
                .join(Section, Section.chapter_id == Chapter.id)
                .where(Course.user_id == scope.user_id)
                .order_by(Course.created_at, Chapter.idx, Section.idx)
            )
        ).all()
    )

    # 哪几节收成过笔记 —— 决定小节的掌握程度加成
    noted_sections = set(
        await scope.session.scalars(
            scope.select(Card, Card.source_section_id).where(
                Card.kind == KIND_NOTE,
                Card.state != STATE_ARCHIVED,
                Card.source_section_id.is_not(None),
            )
        )
    )

    # 小节 → 所属课程，供卡片着色时沿用
    course_of_section: dict[str, str] = {}
    # 章 → 它的小节强度，用于聚合
    sec_strength_of_chapter: dict[str, list[float]] = {}
    chap_of_course: dict[str, list[str]] = {}
    seen_course: dict[str, Course] = {}
    seen_chapter: dict[str, tuple[Chapter, Course]] = {}

    for course, chapter, section in rows:
        course_of_section[section.id] = course.id
        seen_course.setdefault(course.id, course)
        if chapter.id not in seen_chapter:
            seen_chapter[chapter.id] = (chapter, course)
            chap_of_course.setdefault(course.id, []).append(chapter.id)

        learned = bool(section.content_md)
        strength = 0.0
        if learned:
            strength = SEC_DONE if section.completed_at else SEC_READ
            if section.id in noted_sections:
                strength = min(1.0, strength + SEC_NOTE_BONUS)
        sec_strength_of_chapter.setdefault(chapter.id, []).append(strength)

        neurons.append(
            {
                "id": P_SECTION + section.id,
                "kind": NODE_SECTION,
                "label": section.summary or section.title,
                "term": f"{chapter.idx + 1}.{section.idx + 1} {section.title}",
                "depth": 0,
                "rewritten": section.id in noted_sections,  # 写过笔记的那一节
                "touch": section.regenerate_count,
                "degree": 0,
                "strength": round(strength, 3),
                "due": False,
                "learned": learned,
                "reps": 0,
                "created_at": (section.generated_at or course.created_at).isoformat(),
                "course_id": course.id,
                "tags": [str(k) for k in (section.key_concepts or [])][:4],
                # 前端点它跳讲解页
                "route": f"/courses/{course.id}/sections/{section.id}",
            }
        )
        synapses.append(
            {"a": P_CHAPTER + chapter.id, "b": P_SECTION + section.id, "kind": "structure"}
        )

    for chapter_id, (chapter, course) in seen_chapter.items():
        vals = sec_strength_of_chapter.get(chapter_id) or [0.0]
        neurons.append(
            {
                "id": P_CHAPTER + chapter_id,
                "kind": NODE_CHAPTER,
                "label": chapter.summary or chapter.title,
                "term": f"第 {chapter.idx + 1} 章 {chapter.title}",
                "depth": 0,
                "rewritten": False,
                "touch": 0,
                "degree": 0,
                "strength": round(sum(vals) / len(vals), 3),
                "due": False,
                "learned": any(v > 0 for v in vals),
                "reps": 0,
                "created_at": course.created_at.isoformat(),
                "course_id": course.id,
                "tags": [],
                "route": f"/courses/{course.id}",
                # 「已学 2/6 节」。超限丢掉未点亮的小节后，这个数字就是
                # 「还有多少没走」唯一的载体，所以它必须在结构节点上
                "lit": sum(1 for v in vals if v > 0),
                "total": len(vals),
            }
        )

    for course_id, course in seen_course.items():
        chapter_ids = chap_of_course.get(course_id) or []
        vals = [
            sum(sec_strength_of_chapter.get(ch) or [0.0])
            / max(len(sec_strength_of_chapter.get(ch) or [1]), 1)
            for ch in chapter_ids
        ] or [0.0]
        secs = [v for ch in chapter_ids for v in (sec_strength_of_chapter.get(ch) or [])]
        neurons.append(
            {
                "id": P_COURSE + course_id,
                "kind": NODE_COURSE,
                "label": course.description or course.topic,
                "term": course.title or course.topic,
                "depth": 0,
                "rewritten": False,
                "touch": 0,
                "degree": 0,
                "strength": round(sum(vals) / len(vals), 3),
                "due": False,
                "learned": any(v > 0 for v in vals),
                "reps": 0,
                "created_at": course.created_at.isoformat(),
                "course_id": course_id,
                "tags": [],
                "route": f"/courses/{course_id}",
                # ★ 「开了 8 门课只真正走了 1 门」是个诚实且有用的提醒，
                #   一门整个灰着的课 hover 上去会看到 0/24
                "lit": sum(1 for v in secs if v > 0),
                "total": len(secs),
            }
        )
        # 课程连到第一章，章之间按 idx 连成链 —— 一门课看起来像一串珠子
        if chapter_ids:
            synapses.append(
                {"a": P_COURSE + course_id, "b": P_CHAPTER + chapter_ids[0], "kind": "structure"}
            )
        for a, b in zip(chapter_ids, chapter_ids[1:], strict=False):
            synapses.append({"a": P_CHAPTER + a, "b": P_CHAPTER + b, "kind": "spine"})

    # ── 2. 卡片与笔记 ──
    # 取**最新**的 card_limit 张。原来是 order_by(created_at).limit(800)，
    # 拿的是最老的一批 —— 超过上限之后新学的东西反而不在网络里
    cards = list(
        reversed(
            await scope.all(
                scope.select(Card)
                .where(Card.state == STATE_VAULT)
                .order_by(Card.created_at.desc())
                .limit(card_limit)
            )
        )
    )
    ids = [c.id for c in cards]
    id_set = set(ids)

    review = {
        r.card_id: r
        for r in (
            await scope.all(
                select(ReviewState).where(
                    ReviewState.user_id == scope.user_id, ReviewState.card_id.in_(ids)
                )
            )
            if ids
            else []
        )
    }
    links = (
        await scope.all(
            scope.select(CardLink).where(
                CardLink.from_card_id.in_(ids),
                CardLink.to_card_id.in_(ids),
                CardLink.dismissed_at.is_(None),
            )
        )
        if ids
        else []
    )

    for c in cards:
        st = review.get(c.id)
        is_note = c.kind == KIND_NOTE
        neurons.append(
            {
                "id": c.id,  # ★ 裸 id：召回点亮靠它
                "kind": KIND_NOTE if is_note else "card",
                "label": c.summary or c.selected_text or c.question[:30],
                "term": (c.question if is_note else c.selected_text) or c.question[:30],
                "depth": c.depth,
                "rewritten": c.is_rewritten,
                "touch": c.touch_count,
                "degree": 0,
                "strength": round(_card_strength(st), 3),
                "due": bool(st and st.due_date <= now),
                "learned": True,  # 存在即学过
                "reps": st.reps if st else 0,
                "created_at": c.created_at.isoformat(),
                "course_id": course_of_section.get(c.source_section_id or "", ""),
                "tags": list(c.concept_tags or [])[:4],
                "route": "",  # 卡片走 Modal，不跳页
            }
        )
        # 根卡挂在它所属的小节上；子卡靠父子链挂上去，不重复连
        if c.parent_card_id is None and c.source_section_id in course_of_section:
            synapses.append(
                {"a": P_SECTION + c.source_section_id, "b": c.id, "kind": "origin"}
            )

    synapses += [
        {"a": c.parent_card_id, "b": c.id, "kind": "parent"}
        for c in cards
        if c.parent_card_id in id_set
    ]
    synapses += [
        {
            "a": link.from_card_id,
            "b": link.to_card_id,
            "kind": link.kind,
            "relation": link.relation,
        }
        for link in links
    ]

    if not neurons:
        return {"neurons": [], "synapses": [], "stats": {}, "generated_at": now.isoformat()}

    # ── 3. 超限降级：先丢未点亮的小节 ──
    dropped_unlit = 0
    if len(neurons) > NODE_BUDGET:
        over = len(neurons) - NODE_BUDGET
        # 未点亮的小节按「所在课程越荒废、越先丢」不划算：那会让荒废的课
        # 彻底消失，而「你开了课没走」正是该看见的。所以就按大纲顺序丢尾部，
        # 每门课都保留前面几节 —— 那几节才是他最可能接着学的
        victims = [n["id"] for n in neurons if n["kind"] == NODE_SECTION and not n["learned"]]
        doomed = set(victims[-over:]) if over < len(victims) else set(victims)
        dropped_unlit = len(doomed)
        neurons = [n for n in neurons if n["id"] not in doomed]
        # 边必须同步清掉：悬空的边在力导向里被静默丢弃，
        # 表现成「连线时有时无」，查起来毫无头绪
        synapses = [s for s in synapses if s["a"] not in doomed and s["b"] not in doomed]

    # ── 4. 度数（连线粗细与节点大小都用它）──
    degree: dict[str, int] = {n["id"]: 0 for n in neurons}
    for s in synapses:
        if s["a"] in degree:
            degree[s["a"]] += 1
        if s["b"] in degree:
            degree[s["b"]] += 1
    for n in neurons:
        n["degree"] = degree.get(n["id"], 0)

    by_kind: dict[str, int] = {}
    for n in neurons:
        by_kind[n["kind"]] = by_kind.get(n["kind"], 0) + 1
    lit = [n for n in neurons if n["learned"]]
    strengths = [n["strength"] for n in lit] or [0.0]

    return {
        "neurons": neurons,
        "synapses": synapses,
        "stats": {
            "neurons": len(neurons),
            "by_kind": by_kind,
            # 已点亮 = 真的学过/记下的；未点亮的小节是「还没走到的地方」，
            # 它们淡着，本身就是行动指引 —— 不该算进「我有多少知识」
            "lit": len(lit),
            # 因为超限被折叠掉的未点亮小节数。不显示出来的话，
            # 「章上写着 2/24 但只画了 6 个点」会像个 bug
            "folded": dropped_unlit,
            "synapses": len(synapses),
            "rewritten": sum(1 for n in neurons if n["rewritten"]),
            "due": sum(1 for n in neurons if n["due"]),
            "avg_strength": round(sum(strengths) / len(strengths), 3),
            "max_depth": max((n["depth"] for n in neurons), default=0),
        },
        "generated_at": now.isoformat(),
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
