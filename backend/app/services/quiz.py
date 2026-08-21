"""章节刷题 —— 复习的主入口。

★ 为什么复习要从「到期卡队列」改成「选一章刷题」

  原来的复习是：FSRS 把到期的卡推给你，一张一张出简答题，你打字，AI 判分。
  每题十几秒，而且必须打字 —— 用户很容易在第三题就放弃。
  于是间隔重复最需要的东西（**持续的复习数据**）反而最稀缺。

  改成选择题为主之后：一题两三秒、判对错是客观的（不是 AI 估的分、也不是
  用户自评的「我觉得还行」）。同样十分钟能过十几道题，喂给 FSRS 的数据
  又多又准。所以这不是把复习做简单了，是把它做**可持续**了。

★ FSRS 没有被取代，它降级成了「信号 + 记账」

  · 信号：哪一章该刷 —— 章节列表上的「待复习强度」就是它算的
  · 记账：每道能溯源到卡片的题，答完都回喂 apply_review，排程照常更新，
    记忆网络的节点亮度也照常变化
  它不再需要一个「今天没有要复习的卡」的空页面。

★ 出题「有考究」靠的不是模型聪明，是素材组织

  同样一个模型，喂「这一章的正文」和喂「这一章里他问过什么、他写的理解是
  什么、他自己说哪里没搞懂、哪些卡快忘了」，出来的题不是一个量级。
  这份素材只有这个产品攒得出来 —— 见 _material()。
"""

from __future__ import annotations

import logging
import re
from typing import Any

from sqlalchemy import func, select

from app.core.config import TIER_SMALL, TIER_STANDARD
from app.core.scope import UserScope
from app.core.types import new_id, utcnow
from app.llm import Message, chat_json
from app.models.card import KIND_NOTE, STATE_VAULT, Card
from app.models.course import Chapter, Course, Section
from app.models.learning import Quiz, ReviewState
from app.services import prompts, review as review_svc

log = logging.getLogger(__name__)

# 题量。按素材多少浮动 —— 一章只有两张卡还硬出 12 道题，
# 后面几道必然是从正文平铺出来的凑数题
CHOICE_MIN, CHOICE_MAX = 6, 12
SHORT_MAX = 2

# 笔记里那一节是用户**自己承认的缺口**，出题时权重最高。
# 标题是 NOTE_SYSTEM 固定输出的（见 prompts）。
#
# ⚠️ 两个细节都是踩出来的：
#   · 标题行尾只能吃 [ \t]*\n，不能用 \s*\n —— 后者会把标题下面的空行也吃掉，
#     于是「这一节是空的」这种情况会越过下一个小标题，把**下一节的标题**
#     当成内容抠出来（测试里 "## 我还没搞懂的\n\n## 下一节" 就会误标成有缺口）
#   · 结束位置用 ^## 配 re.M（行首的小标题），而不是 \n##
_UNSURE = re.compile(r"##[ \t]*我还没搞懂的[ \t]*\n(.*?)(?=^##|\Z)", re.S | re.M)

# 正文节选的字数预算。整章八节全文两万多字，全塞进去又慢又贵，
# 而且模型会平均用力 —— 反而稀释了「他卡在哪」这个信号
EXCERPT_BUDGET = 900


def _unsure_of(text: str) -> str:
    """从笔记里抠出「我还没搞懂的」。"""
    m = _UNSURE.search(text or "")
    if not m:
        return ""
    body = m.group(1).strip()
    # 空节的两种写法都要认：模型有时留空行，有时写「（暂无）」
    return "" if len(body) < 4 or body.startswith(("（无", "(无", "（暂无")) else body[:400]


def _excerpt(content: str, terms: list[str], budget: int = EXCERPT_BUDGET) -> str:
    """正文节选：**他划过词的那些段落优先**。

    这一步是「有考究」在正文侧的落地。按顺序截前 900 字是最省事的做法，
    但那等于假设「开头最重要」；而实际上最值得出题的地方是他停下来划词提问的
    那几段 —— 那是他自己标记出来的难点。
    """
    if not content:
        return ""
    paras = [p.strip() for p in content.split("\n\n") if len(p.strip()) > 40]
    if not paras:
        return content[:budget]

    picked: list[str] = []
    used: set[int] = set()
    for t in terms:
        if not t:
            continue
        for i, p in enumerate(paras):
            if i not in used and t in p:
                picked.append(p)
                used.add(i)
                break
        if sum(len(x) for x in picked) > budget:
            break
    # 一个词都没命中（比如这一节他没划过）时补上开头，保证有基本语境
    for i, p in enumerate(paras):
        if sum(len(x) for x in picked) > budget:
            break
        if i not in used:
            picked.append(p)
            used.add(i)
    return "\n".join(picked)[:budget]


async def _material(scope: UserScope, chapter: Chapter) -> tuple[list[dict], list[dict]]:
    """收集并**标注**这一章的出题素材。

    返回 (sections, cards)。每条素材都带来源与状态标注 —— prompt 里那些
    「他问过」「他标了还没搞懂」「快忘了」不是装饰，是出题的指令。
    """
    sections = list(
        await scope.session.scalars(
            select(Section).where(Section.chapter_id == chapter.id).order_by(Section.idx)
        )
    )
    sec_ids = [s.id for s in sections]
    if not sec_ids:
        return [], []

    cards = await scope.all(
        scope.select(Card)
        .where(Card.source_section_id.in_(sec_ids), Card.state == STATE_VAULT)
        .order_by(Card.created_at)
    )
    # FSRS 状态：「快忘了」这个标注的来源
    states = {
        r.card_id: r
        for r in await scope.all(
            select(ReviewState).where(
                ReviewState.user_id == scope.user_id,
                ReviewState.card_id.in_([c.id for c in cards] or [""]),
            )
        )
    }

    now = utcnow()
    card_out: list[dict] = []
    # 划过的词按小节归拢，供正文节选定位
    terms_of: dict[str, list[str]] = {}
    for c in cards:
        st = states.get(c.id)
        tags: list[str] = []
        body = c.user_note or c.ai_answer  # 笔记看终稿，终稿没有才看原稿
        if c.kind == KIND_NOTE:
            tags.append("这是他自己收的笔记")
        else:
            tags.append("他问过")
        if c.is_rewritten and c.user_note:
            tags.append("他写过自己的理解")
        if st and st.due_date <= now:
            tags.append("快忘了")
        elif st and (st.stability or 0) < 3:
            tags.append("记得还不牢")
        if st and st.lapses >= 2:
            tags.append(f"复习时错过 {st.lapses} 次")
        if c.touch_count >= 3:
            tags.append(f"回看过 {c.touch_count} 次")

        item: dict[str, Any] = {"id": c.id, "tags": tags}
        if c.selected_text:
            item["划的词"] = c.selected_text[:120]
            terms_of.setdefault(c.source_section_id or "", []).append(c.selected_text)
        if c.question:
            item["他问的"] = c.question[:200]
        if c.kind == KIND_NOTE:
            item["当时的解答"] = (body or "")[:1200]
        elif c.ai_answer:
            item["当时的解答"] = c.ai_answer[:600]
        if c.is_rewritten and c.user_note and c.kind != KIND_NOTE:
            item["他自己写的理解"] = c.user_note[:400]
        if gap := _unsure_of(body or ""):
            item["他说还没搞懂"] = gap
            item["tags"].append("他标了还没搞懂")
        card_out.append(item)

    noted = {c.source_section_id for c in cards if c.kind == KIND_NOTE}
    sec_out: list[dict] = []
    for s in sections:
        marks: list[str] = []
        if not s.content_md:
            marks.append("这一节他还没读")
        elif s.completed_at:
            marks.append("已学完")
        if s.id in noted:
            marks.append("收成过笔记")
        if s.regenerate_count:
            marks.append(f"他重读过 {s.regenerate_count} 次")
        sec_out.append(
            {
                "title": f"{chapter.idx + 1}.{s.idx + 1} {s.title}",
                "summary": s.summary[:300],
                "concepts": [str(k) for k in (s.key_concepts or [])][:8],
                "excerpt": _excerpt(s.content_md or "", terms_of.get(s.id, [])),
                "marks": marks,
            }
        )
    return sec_out, card_out


# ─────────────────────────────────────────────────────────────
# 章节列表：FSRS 在这里发挥「信号」的作用
# ─────────────────────────────────────────────────────────────
async def chapter_targets(scope: UserScope) -> list[dict]:
    """能刷的章 + **该刷的理由**。

    ★ 这就是 FSRS 退到后台之后的新位置：它不再是一个待办队列，
      而是回答「我今天该刷哪一章」。到期卡多、平均 stability 低的章排前面 ——
      「不到时候不打扰你」这个价值就是靠这个排序保住的。
    """
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
    if not rows:
        return []

    # 卡片与到期数按小节统计，再归到章上
    now = utcnow()
    counts = dict(
        (
            await scope.session.execute(
                select(Card.source_section_id, func.count(Card.id))
                .where(
                    Card.user_id == scope.user_id,
                    Card.state == STATE_VAULT,
                    Card.source_section_id.is_not(None),
                )
                .group_by(Card.source_section_id)
            )
        ).all()
    )
    due_counts = dict(
        (
            await scope.session.execute(
                select(Card.source_section_id, func.count(Card.id))
                .join(ReviewState, ReviewState.card_id == Card.id)
                .where(
                    Card.user_id == scope.user_id,
                    Card.state == STATE_VAULT,
                    ReviewState.user_id == scope.user_id,
                    ReviewState.due_date <= now,
                    Card.source_section_id.is_not(None),
                )
                .group_by(Card.source_section_id)
            )
        ).all()
    )
    # 最近刷过没有 —— 刚刷完的章不该继续排在最前面
    last_quiz = dict(
        (
            await scope.session.execute(
                select(Quiz.chapter_id, func.max(Quiz.created_at))
                .where(Quiz.user_id == scope.user_id)
                .group_by(Quiz.chapter_id)
            )
        ).all()
    )

    out: dict[str, dict] = {}
    for course, chapter, section in rows:
        it = out.setdefault(
            chapter.id,
            {
                "chapter_id": chapter.id,
                "chapter_title": f"第 {chapter.idx + 1} 章 {chapter.title}",
                "summary": chapter.summary[:160],
                "course_id": course.id,
                "course_title": course.title or course.topic,
                "sections": 0,
                "read": 0,
                "cards": 0,
                "due": 0,
                "last_quiz_at": (
                    last_quiz[chapter.id].isoformat() if last_quiz.get(chapter.id) else None
                ),
            },
        )
        it["sections"] += 1
        if section.content_md:
            it["read"] += 1
        it["cards"] += int(counts.get(section.id, 0))
        it["due"] += int(due_counts.get(section.id, 0))

    items = [v for v in out.values() if v["read"] > 0]  # 一节都没读过的章没什么可考的
    # 排序：到期卡多的优先，其次卡片多的（素材足），最后是读过的节数
    items.sort(key=lambda v: (-v["due"], -v["cards"], -v["read"]))
    return items


# ─────────────────────────────────────────────────────────────
# 出题
# ─────────────────────────────────────────────────────────────
def _plan(n_sections: int, n_cards: int) -> tuple[int, int]:
    """题量。素材少就少出 —— 硬凑的题必然是从正文平铺出来的。"""
    n = CHOICE_MIN + n_cards // 2 + max(0, n_sections - 2)
    n_choice = max(CHOICE_MIN, min(n, CHOICE_MAX))
    n_short = 0 if n_cards == 0 else (1 if n_cards < 4 else SHORT_MAX)
    return n_choice, n_short


def _clean(items: Any, n_choice: int, n_short: int) -> list[dict]:
    """把模型输出洗成可信的题目列表。

    ⚠️ 选择题的 answer 必须是**合法下标**。模型偶尔会给字符串（"A"）或者越界 ——
       不校验的话前端判分永远判错，而且不报错，只是所有人都答错。
    """
    out: list[dict] = []
    for raw in items if isinstance(items, list) else []:
        if not isinstance(raw, dict):
            continue
        q = str(raw.get("q") or "").strip()
        if not q:
            continue
        kind = "short" if str(raw.get("kind")) == "short" else "choice"
        item: dict[str, Any] = {
            "kind": kind,
            "q": q[:600],
            "explain": str(raw.get("explain") or "")[:800],
            "concept": str(raw.get("concept") or "")[:80],
            "card_id": str(raw.get("card_id") or "")[:64],
            "why": str(raw.get("why") or "")[:200],
        }
        if kind == "choice":
            opts = [str(o).strip()[:300] for o in (raw.get("options") or []) if str(o).strip()]
            if len(opts) < 2:
                continue  # 少于两个选项不成题
            ans = raw.get("answer")
            if isinstance(ans, str):
                # "A"/"B" 或者 "0"/"1" 都见过
                ans = (
                    ord(ans.strip().upper()[0]) - 65
                    if ans.strip()[:1].isalpha()
                    else int(ans.strip() or 0)
                )
            try:
                ans = int(ans)
            except (TypeError, ValueError):
                continue
            if not 0 <= ans < len(opts):
                continue
            item["options"] = opts[:6]
            item["answer"] = ans
        else:
            item["answer"] = str(raw.get("answer") or "")[:1200]
            if not item["answer"]:
                continue
        out.append(item)

    # 顺序：选择题在前、简答在后。刷题的节奏要先起来，
    # 一上来就让人打字，爽感直接没了
    choices = [i for i in out if i["kind"] == "choice"][: n_choice + 2]
    shorts = [i for i in out if i["kind"] == "short"][:n_short]
    return choices + shorts


async def generate(scope: UserScope, chapter: Chapter, *, quota: int | None = None) -> Quiz:
    """给一章出一套题并落库。"""
    sections, cards = await _material(scope, chapter)
    if not sections:
        raise ValueError("这一章还没有内容可考")

    n_choice, n_short = _plan(len(sections), len(cards))
    course = await scope.session.get(Course, chapter.course_id)

    data = await chat_json(
        [
            Message(role="system", content=prompts.QUIZ_SYSTEM),
            Message(
                role="user",
                content=prompts.quiz_user(
                    course_title=(course.title or course.topic) if course else "",
                    chapter_title=f"第 {chapter.idx + 1} 章 {chapter.title}",
                    sections=sections,
                    cards=cards,
                    n_choice=n_choice,
                    n_short=n_short,
                ),
            ),
        ],
        scene="quiz_make",
        # ★ 中档 + 关思考链，不是省钱，是权衡：
        #   出题质量的大头在**素材组织**（见 _material），不在模型多想几轮。
        #   而思考链在这里有实际害处 —— 它和 json_mode 抢 max_tokens，
        #   吃光之后整份题目变成空的（大纲上踩过两次）。
        #   而且用户在这一步是干等着进入刷题的，延迟直接劝退。
        tier=TIER_STANDARD,
        user_id=scope.user_id,
        temperature=0.7,
        max_tokens=6000,
        quota=quota,
        thinking=False,
    )

    items = _clean((data or {}).get("items"), n_choice, n_short)
    if not items:
        raise ValueError("出题失败，请再试一次")

    quiz = Quiz(
        id=new_id(),
        user_id=scope.user_id,
        chapter_id=chapter.id,
        chapter_title=f"第 {chapter.idx + 1} 章 {chapter.title}",
        course_id=chapter.course_id,
        course_title=(course.title or course.topic) if course else "",
        items=items,
        summary={},
        created_at=utcnow(),
    )
    scope.add(quiz)
    await scope.commit()
    return quiz


# ─────────────────────────────────────────────────────────────
# 答题
# ─────────────────────────────────────────────────────────────
def _rating_of(item: dict, correct: bool) -> int:
    """答题结果 → FSRS 评级。

    ★ 两个选项答对**不能给满分**：蒙也有一半概率对。
      给 4（轻松准确）会让间隔被不当地拉长，下次该问的时候不问了 ——
      排程失准是静默的，等发现时已经忘了一片。
    """
    if not correct:
        return 1
    return 3 if len(item.get("options") or []) <= 2 else 4


async def record(
    scope: UserScope,
    quiz: Quiz,
    idx: int,
    *,
    picked: int | None = None,
    reply: str = "",
    quota: int | None = None,
) -> dict:
    """记一道题的作答：判对错 → 回喂 FSRS → 落库。

    选择题在这里是**纯本地判断**（答案出题时就有了），所以前端可以先自己判、
    立刻给反馈，这个请求只负责记账 —— 刷题的即时感就是这么来的。
    """
    items = list(quiz.items or [])
    if not 0 <= idx < len(items):
        raise ValueError("题号不存在")
    item = dict(items[idx])

    out: dict[str, Any] = {"index": idx, "kind": item["kind"]}
    if item["kind"] == "choice":
        correct = picked is not None and int(picked) == int(item.get("answer", -1))
        item["picked"] = picked
        item["correct"] = correct
        out.update(correct=correct, answer=item.get("answer"), explain=item.get("explain", ""))
    else:
        graded = await _grade_short(scope, item, reply, quota=quota)
        correct = graded["score"] >= 0.6
        item.update(reply=reply[:4000], correct=correct, **graded)
        out.update(correct=correct, **graded, answer=item.get("answer", ""))

    items[idx] = item
    quiz.items = items  # JSON 列必须整体赋值，原地改 list 不会被 ORM 认作脏
    await scope.commit()

    # ★ 能溯源到卡片的题才喂 FSRS。从正文出的题没有排程可更新 ——
    #   硬造一条会污染「哪块知识牢」的判断
    if cid := item.get("card_id"):
        card = await scope.get(Card, str(cid))
        if card is not None:
            await review_svc.apply_review(
                scope,
                card,
                rating=_rating_of(item, correct),
                question=item.get("q", ""),
                answer=(str(picked) if item["kind"] == "choice" else reply)[:2000],
                score=out.get("score"),
                feedback=out.get("feedback", ""),
            )
            out["scheduled"] = True
    return out


async def _grade_short(
    scope: UserScope, item: dict, reply: str, *, quota: int | None = None
) -> dict:
    if not reply.strip():
        return {"score": 0.0, "rating": 1, "feedback": "这道题没有作答。"}
    own = ""
    if cid := item.get("card_id"):
        card = await scope.get(Card, str(cid))
        if card is not None and card.is_rewritten:
            own = card.user_note
    try:
        data = await chat_json(
            [
                Message(role="system", content=prompts.QUIZ_GRADE_SYSTEM),
                Message(
                    role="user",
                    content=prompts.quiz_grade_user(
                        item.get("q", ""), str(item.get("answer") or ""), reply, own
                    ),
                ),
            ],
            scene="quiz_grade",
            tier=TIER_SMALL,
            user_id=scope.user_id,
            temperature=0.2,
            max_tokens=600,
            quota=quota,
            # 判个分不需要思考链，而用户正等着看反馈
            thinking=False,
        )
    except Exception:
        log.warning("简答判分失败，按「答得不错」记账", exc_info=True)
        return {"score": 0.6, "rating": 3, "feedback": "本次未能自动判分，已按答对计入。"}

    try:
        rating = max(1, min(int(data.get("rating") or 3), 4))
    except (TypeError, ValueError):
        rating = 3
    return {
        "score": float(data.get("score") or 0.0),
        "rating": rating,
        "feedback": str(data.get("feedback") or "")[:1000],
    }


# ─────────────────────────────────────────────────────────────
# 总结
# ─────────────────────────────────────────────────────────────
async def finish(scope: UserScope, quiz: Quiz) -> dict:
    """刷完一轮的总结：考了什么、哪里还薄弱、从哪儿回去补。

    ★ 「薄弱」按**知识点**聚合，不按题目列
      列一遍错题只是重复劳动，用户自己刚看过。有价值的是把错题归到概念上 ——
      「你在缩放点积上错了两道」才是可行动的结论。
    """
    items = list(quiz.items or [])
    answered = [i for i in items if i.get("correct") is not None]
    right = [i for i in answered if i.get("correct")]

    # 连击：算最长的一段连对
    best = cur = 0
    for i in items:
        if i.get("correct") is True:
            cur += 1
            best = max(best, cur)
        elif i.get("correct") is False:
            cur = 0

    by_concept: dict[str, dict] = {}
    for i in answered:
        key = (i.get("concept") or "其它").strip() or "其它"
        slot = by_concept.setdefault(key, {"concept": key, "total": 0, "right": 0, "cards": []})
        slot["total"] += 1
        if i.get("correct"):
            slot["right"] += 1
        elif cid := i.get("card_id"):
            slot["cards"].append(str(cid))

    concepts = sorted(by_concept.values(), key=lambda v: (v["right"] / max(v["total"], 1), -v["total"]))
    weak = [c for c in concepts if c["right"] < c["total"]]

    # 回去补的入口：错题溯源的卡片 → 它所在的小节
    wrong_cards = [str(i["card_id"]) for i in answered if not i.get("correct") and i.get("card_id")]
    links: list[dict] = []
    if wrong_cards:
        rows = list(
            (
                await scope.session.execute(
                    select(Card, Section, Chapter)
                    .join(Section, Section.id == Card.source_section_id)
                    .join(Chapter, Chapter.id == Section.chapter_id)
                    .where(Card.id.in_(wrong_cards), Card.user_id == scope.user_id)
                )
            ).all()
        )
        seen: set[str] = set()
        for card, section, chap in rows:
            if section.id in seen:
                continue
            seen.add(section.id)
            links.append(
                {
                    "section_id": section.id,
                    "course_id": quiz.course_id,
                    "title": f"{chap.idx + 1}.{section.idx + 1} {section.title}",
                    "kind": "note" if card.kind == KIND_NOTE else "card",
                    "card_id": card.id,
                }
            )

    summary = {
        "total": len(items),
        "answered": len(answered),
        "right": len(right),
        "streak_best": best,
        "concepts": concepts,
        "weak": [w["concept"] for w in weak],
        "links": links,
        "scheduled": sum(1 for i in answered if i.get("card_id")),
    }
    quiz.summary = summary
    quiz.finished_at = utcnow()
    await scope.commit()
    return summary
