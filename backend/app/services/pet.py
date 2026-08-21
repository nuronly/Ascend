"""桌宠该说什么。

★ 桌宠真正的价值不是「能陪你聊天」，是**它能主动开口**

  第二大脑是你问它才答；桌宠常驻在屏幕角上，可以自己冒泡。而「主动」这件事
  正是防坟场缺的那一环 —— 收藏夹的问题从来不是收不进去，是收了没人提。

  所以这里不接任何新的 AI 链路，只做一件事：**从已有数据里挑出此刻最该说的
  那一句**。数据一行都不用新加 —— 到期排程、划了词没收成笔记的小节、
  笔记里他自己写的「我还没搞懂的」、荒废的课，全都已经在库里。

★ 为什么不让它「闲聊」

  第二大脑的立身之本是「只回答你自己学过的东西，检索不到就直说」。
  桌宠一旦能用通用知识兜底，用户就分不清哪句话是从他的记录里来的 ——
  可溯源这个最贵的资产当场作废。
  所以桌宠的「聊」全部转给第二大脑（带引用），它自己只负责**提起**：
  提起该复习了、提起哪一节还没收尾、提起他三个月前的困惑。
"""

from __future__ import annotations

import logging
import re
from datetime import timedelta
from typing import Any

from sqlalchemy import func, select

from app.core.scope import UserScope
from app.core.types import utcnow
from app.models.card import KIND_NOTE, STATE_VAULT, Card
from app.models.course import Chapter, Course, Section
from app.models.learning import POMO_COMPLETED, Pomodoro, ReviewState

log = logging.getLogger(__name__)

# 「我还没搞懂的」抠法与出题那边共用一个规矩（quiz._unsure_of 的孪生）。
# ⚠️ 标题行尾只能吃 [ \t]*\n：用 \s*\n 会把空行也吃掉，于是空的那一节
#    会越过下一个小标题，把**下一节的标题**当成内容抠出来
_UNSURE = re.compile(r"##[ \t]*我还没搞懂的[ \t]*\n(.*?)(?=^##|\Z)", re.S | re.M)

# 多久没动算「荒废」。三天是个平衡：太短会在正常的周末打扰人，
# 太长就错过了还能捡回来的窗口
STALE_DAYS = 3


def _unsure_of(text: str) -> str:
    m = _UNSURE.search(text or "")
    if not m:
        return ""
    body = m.group(1).strip()
    return "" if len(body) < 4 or body.startswith(("（无", "(无", "（暂无")) else body


async def _pomodoro_tail(scope: UserScope) -> dict | None:
    """刚跑完的番茄还没回顾。

    这一条排最前是因为它有**时效**：番茄刚结束那几分钟，脑子里还热着，
    此时回顾的效果和半小时后完全不是一回事。
    """
    row = await scope.one_or_none(
        scope.select(Pomodoro)
        .where(Pomodoro.status == POMO_COMPLETED, Pomodoro.reviewed_at.is_(None))
        .order_by(Pomodoro.ended_at.desc())
        .limit(1)
    )
    if row is None or row.ended_at is None:
        return None
    if (utcnow() - row.ended_at) > timedelta(minutes=40):
        return None  # 过了这个劲儿就别提了，改说别的
    n = 0
    if row.section_id:
        n = await scope.count(
            scope.select(Card, Card.id).where(
                Card.source_section_id == row.section_id,
                Card.created_at >= row.started_at,
            )
        )
    return {
        "kind": "pomodoro",
        "text": (
            f"刚才那 {row.planned_minutes} 分钟你收了 {n} 张卡，趁热回顾一下？"
            if n
            else "番茄跑完了。刚才那一节，有什么记下来的吗？"
        ),
        "route": f"/courses//sections/{row.section_id}" if row.section_id else "",
        "cta": "去看看",
    }


async def _due_review(scope: UserScope) -> dict | None:
    """有卡到期了 —— FSRS 退到后台之后，提醒这件事就落在桌宠身上。"""
    n = await scope.session.scalar(
        select(func.count(ReviewState.card_id))
        .join(Card, Card.id == ReviewState.card_id)
        .where(
            ReviewState.user_id == scope.user_id,
            Card.user_id == scope.user_id,
            Card.state == STATE_VAULT,
            ReviewState.due_date <= utcnow(),
        )
    )
    if not n:
        return None
    return {
        "kind": "due",
        "text": f"有 {int(n)} 张卡到复习时间了。挑一章刷一轮，几分钟的事。",
        "route": "/review",
        "cta": "去刷题",
    }


async def _unfinished_note(scope: UserScope) -> dict | None:
    """划了好几个词、却没收成笔记的小节。

    ★ 这是沉淀链路断掉的地方，也是这个产品最想推动的动作：
      卡片散着是素材，收成笔记才算内化。有 3 张以上卡还没收的小节，
      正是「差最后一步」的那种。
    """
    noted = select(Card.source_section_id).where(
        Card.user_id == scope.user_id, Card.kind == KIND_NOTE
    )
    rows = list(
        (
            await scope.session.execute(
                select(Card.source_section_id, func.count(Card.id))
                .where(
                    Card.user_id == scope.user_id,
                    Card.state == STATE_VAULT,
                    Card.kind != KIND_NOTE,
                    Card.source_section_id.is_not(None),
                    Card.source_section_id.not_in(noted),
                )
                .group_by(Card.source_section_id)
                .having(func.count(Card.id) >= 3)
                .order_by(func.count(Card.id).desc())
                .limit(1)
            )
        ).all()
    )
    if not rows:
        return None
    sec_id, n = rows[0]
    found = (
        await scope.session.execute(
            select(Section, Chapter, Course)
            .join(Chapter, Chapter.id == Section.chapter_id)
            .join(Course, Course.id == Chapter.course_id)
            .where(Section.id == sec_id, Course.user_id == scope.user_id)
        )
    ).first()
    if found is None:
        return None
    section, chapter, course = found
    return {
        "kind": "note",
        "text": (
            f"「{chapter.idx + 1}.{section.idx + 1} {section.title}」你划了 {int(n)} 个词，"
            "还没收成笔记 —— 差最后一步。"
        ),
        "route": f"/courses/{course.id}/sections/{section.id}",
        "cta": "去收尾",
    }


async def _own_gap(scope: UserScope) -> dict | None:
    """他自己在笔记里写过「我还没搞懂的」。

    这是最有分量的一条：**是他自己承认的缺口，不是系统猜的**。
    通用助手永远说不出这句话 —— 它没有他三个月前的困惑。
    """
    notes = await scope.all(
        scope.select(Card)
        .where(Card.kind == KIND_NOTE, Card.state == STATE_VAULT)
        .order_by(Card.created_at.desc())
        .limit(12)
    )
    for note in notes:
        gap = _unsure_of(note.user_note or note.ai_answer or "")
        if not gap:
            continue
        # 只取第一句 —— 气泡里放不下一段
        first = re.split(r"[。；\n]", gap)[0].strip("-•· ")[:60]
        if len(first) < 6:
            continue
        route = ""
        if note.source_section_id:
            found = (
                await scope.session.execute(
                    select(Course.id)
                    .join(Chapter, Chapter.course_id == Course.id)
                    .join(Section, Section.chapter_id == Chapter.id)
                    .where(Section.id == note.source_section_id, Course.user_id == scope.user_id)
                )
            ).first()
            if found:
                route = f"/courses/{found[0]}/sections/{note.source_section_id}"
        return {
            "kind": "gap",
            "text": f"你在笔记里写过「{first}」。现在想通了吗？",
            "route": route,
            "cta": "回去看看",
            "ask": f"关于{first}，我当时的困惑是什么？",
        }
    return None


async def _stale_course(scope: UserScope) -> dict | None:
    """开了课但荒废了。

    ⚠️ 措辞刻意不带责备。「你已经三天没学了」只会让人关掉桌宠 ——
       提起它停在哪，比提起他偷懒有用。
    """
    rows = list(
        (
            await scope.session.execute(
                select(Course.id, Course.title, Course.topic, func.max(Section.generated_at))
                .join(Chapter, Chapter.course_id == Course.id)
                .join(Section, Section.chapter_id == Chapter.id)
                .where(Course.user_id == scope.user_id, Section.content_md.is_not(None))
                .group_by(Course.id)
            )
        ).all()
    )
    now = utcnow()
    stale = [
        r for r in rows if r[3] is not None and (now - r[3]) > timedelta(days=STALE_DAYS)
    ]
    if not stale:
        return None
    stale.sort(key=lambda r: r[3])  # 停得最久的那门
    cid, title, topic, last = stale[0]
    days = int((now - last).total_seconds() // 86400)
    # 停在哪一节 —— 说清位置，比说「你荒废了」有用
    nxt = (
        await scope.session.execute(
            select(Section.id, Chapter.idx, Section.idx, Section.title)
            .join(Chapter, Chapter.id == Section.chapter_id)
            .where(Chapter.course_id == cid, Section.content_md.is_(None))
            .order_by(Chapter.idx, Section.idx)
            .limit(1)
        )
    ).first()
    where = f"，下一节是 {nxt[1] + 1}.{nxt[2] + 1} {nxt[3]}" if nxt else ""
    return {
        "kind": "stale",
        "text": f"《{title or topic}》停了 {days} 天{where}。",
        "route": f"/courses/{cid}/sections/{nxt[0]}" if nxt else f"/courses/{cid}",
        "cta": "接着学",
    }


# 排在前面的先说。顺序就是「此刻最该被提起的事」的优先级：
#   时效性 > 系统排程 > 差最后一步 > 他自己的困惑 > 荒废提醒
_PICKERS = (_pomodoro_tail, _due_review, _unfinished_note, _own_gap, _stale_course)


async def nudge(scope: UserScope) -> dict[str, Any]:
    """挑此刻最该说的一句。

    每一路都可能返回 None（没这回事），按优先级取第一个命中的。
    全都没有 —— 说明他手上是干净的，那就别硬找话说。
    """
    for pick in _PICKERS:
        try:
            if hit := await pick(scope):
                return hit
        except Exception:
            # 一路查询挂了不该让桌宠整个哑掉
            log.warning("桌宠的 %s 这一路失败，跳过", pick.__name__, exc_info=True)
    return {
        "kind": "idle",
        "text": "手上都清了。想问我什么，或者开一门新课？",
        "route": "",
        "cta": "",
    }
