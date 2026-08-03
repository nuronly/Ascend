"""勋章墙（PLAN §3.7）。

设计要点：
  · **条件不只看「学完」，更要看质量** —— 学完一门课只是完成类，
    真正值钱的是己见率、追问深度、手建关联这些「你确实想过」的证据
  · **异步生图**：达成即刻发放占位勋章，图生成好了再替换。
    生图有延迟和失败率，绝不能同步阻塞（PLAN §7 风险 #9）
  · prompt 模板化保证视觉风格统一，失败则退化为程序生成的兜底图案
"""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import Integer, func, select

from app.core.scope import UserScope
from app.core.types import new_id, utcnow
from app.models.card import LINK_REAL, STATE_VAULT, Card, CardLink
from app.models.course import Chapter, Course, Section
from app.models.learning import POMO_COMPLETED, Badge, Pomodoro, ReviewLog

log = logging.getLogger(__name__)

KIND_COMPLETION = "completion"
KIND_DEPTH = "depth"
KIND_PERSISTENCE = "persistence"
KIND_EXPLORATION = "exploration"

KIND_LABEL = {
    KIND_COMPLETION: "完成",
    KIND_DEPTH: "深度",
    KIND_PERSISTENCE: "坚持",
    KIND_EXPLORATION: "探索",
}

# 统一视觉风格 —— 整面墙要看起来像一套东西，而不是拼盘
STYLE = (
    "极简主义徽章设计，扁平矢量插画，正圆形构图，居中对称，单一主体，"
    "几何线条简洁，柔和的金属质感，深色背景上的浅色图形，边缘干净，"
    "低饱和度配色，高级感，博物馆藏品气质。"
    "画面中不要出现任何文字、字母、数字或符号。"
)


@dataclass(frozen=True)
class BadgeDef:
    code: str
    kind: str
    title: str
    description: str
    """生图主体描述，接在统一风格之后"""
    motif: str
    """从统计数据算出当前进度 (已完成, 目标)"""
    progress: Callable[[dict], tuple[float, float]]

    def prompt(self) -> str:
        return f"{self.motif}。{STYLE}"


# ─────────────────────────────────────────────────────────────
# 勋章定义
# ─────────────────────────────────────────────────────────────
BADGES: list[BadgeDef] = [
    # ── 完成类 ──
    BadgeDef(
        code="first_section",
        kind=KIND_COMPLETION,
        title="第一级台阶",
        description="学完第一节课",
        motif="一级向上的石阶，阶面有柔和的光",
        progress=lambda s: (s["sections_done"], 1),
    ),
    BadgeDef(
        code="first_course",
        kind=KIND_COMPLETION,
        title="登顶一门",
        description="完整学完一门课程的所有小节",
        motif="一座极简的山峰轮廓，顶端一个小圆点",
        progress=lambda s: (s["courses_done"], 1),
    ),
    BadgeDef(
        code="courses_3",
        kind=KIND_COMPLETION,
        title="三座山",
        description="学完三门课程",
        motif="三座高低错落的极简山峰",
        progress=lambda s: (s["courses_done"], 3),
    ),
    BadgeDef(
        code="sections_30",
        kind=KIND_COMPLETION,
        title="三十级",
        description="累计学完 30 个小节",
        motif="一段螺旋上升的阶梯，俯视视角",
        progress=lambda s: (s["sections_done"], 30),
    ),
    # ── 深度类：真正值钱的部分 ──
    BadgeDef(
        code="rewrite_10",
        kind=KIND_DEPTH,
        title="用自己的话",
        description="有 10 张卡写下了你自己的理解",
        motif="一支笔尖，笔尖下方是一圈涟漪",
        progress=lambda s: (s["rewritten"], 10),
    ),
    BadgeDef(
        code="rewrite_rate_50",
        kind=KIND_DEPTH,
        title="过半己见",
        description="己见率超过 50%（至少 20 张卡）——比学习时长诚实得多的指标",
        motif="一个圆被一条曲线分成明暗两半，明的一半有细密纹理",
        progress=lambda s: (
            s["rewrite_rate"] * 100 if s["vaulted"] >= 20 else 0.0,
            50,
        ),
    ),
    BadgeDef(
        code="deep_course",
        kind=KIND_DEPTH,
        title="啃透一门",
        description="在同一门课里写下 8 张己见卡",
        motif="一颗被剖开的几何形果实，内部结构清晰",
        progress=lambda s: (s["max_course_rewritten"], 8),
    ),
    BadgeDef(
        code="review_30",
        kind=KIND_DEPTH,
        title="回想三十次",
        description="完成 30 次主动复习 —— 记住东西靠的是回想，不是重读",
        motif="一个由虚线构成的环，环上有三个实心节点",
        progress=lambda s: (s["reviews"], 30),
    ),
    # ── 坚持类 ──
    BadgeDef(
        code="streak_7",
        kind=KIND_PERSISTENCE,
        title="七日不辍",
        description="连续 7 天都有专注学习",
        motif="七个等距排列的小圆点连成一道弧线",
        progress=lambda s: (s["streak"], 7),
    ),
    BadgeDef(
        code="deep_week",
        kind=KIND_PERSISTENCE,
        title="深水周",
        description="连续 7 天，每天至少 4 颗番茄",
        motif="一个日晷的极简剖面，投影落在刻度上",
        progress=lambda s: (s["deep_streak"], 7),
    ),
    BadgeDef(
        code="pomodoro_50",
        kind=KIND_PERSISTENCE,
        title="五十次专注",
        description="累计完成 50 颗番茄",
        motif="五十个微小方块排成的紧密网格，其中几个发光",
        progress=lambda s: (s["pomodoros"], 50),
    ),
    # ── 探索类 ──
    BadgeDef(
        code="depth_5",
        kind=KIND_EXPLORATION,
        title="打破砂锅",
        description="一条追问链深达 5 层 —— 你真正卡住的往往不是最初那个词",
        motif="一条向下延伸的链条，每一环比上一环小一点",
        progress=lambda s: (s["max_depth"] + 1, 5),
    ),
    BadgeDef(
        code="links_20",
        kind=KIND_EXPLORATION,
        title="织网人",
        description="亲手建立 20 条卡片关联 —— AI 只能建议，连线得你自己来",
        motif="一张由细线交织成的不规则网，节点疏密有致",
        progress=lambda s: (s["real_links"], 20),
    ),
    BadgeDef(
        code="cards_100",
        kind=KIND_EXPLORATION,
        title="百问",
        description="累计沉淀 100 张卡片",
        motif="一百个大小不一的圆点组成的星云",
        progress=lambda s: (s["vaulted"], 100),
    ),
    BadgeDef(
        code="concepts_50",
        kind=KIND_EXPLORATION,
        title="概念猎手",
        description="你的卡片覆盖了 50 个不同的概念",
        motif="散布的多面体晶体，彼此有细线相连",
        progress=lambda s: (s["concepts"], 50),
    ),
]

BADGE_BY_CODE = {b.code: b for b in BADGES}


# ─────────────────────────────────────────────────────────────
# 统计
# ─────────────────────────────────────────────────────────────
async def collect_stats(scope: UserScope) -> dict:
    """一次性把所有勋章条件需要的指标算出来。"""
    s = scope.session
    uid = scope.user_id

    vaulted, rewritten, max_depth = (
        await s.execute(
            select(
                func.count(Card.id),
                func.coalesce(func.sum(func.cast(Card.is_rewritten, Integer)), 0),
                func.coalesce(func.max(Card.depth), 0),
            ).where(Card.user_id == uid, Card.state == STATE_VAULT)
        )
    ).one()
    vaulted = int(vaulted or 0)
    rewritten = int(rewritten or 0)

    real_links = int(
        await s.scalar(
            select(func.count(CardLink.id)).where(
                CardLink.user_id == uid, CardLink.kind == LINK_REAL
            )
        )
        or 0
    )

    sections_done = int(
        await s.scalar(
            select(func.count(Section.id))
            .join(Chapter, Chapter.id == Section.chapter_id)
            .join(Course, Course.id == Chapter.course_id)
            .where(Course.user_id == uid, Section.completed_at.is_not(None))
        )
        or 0
    )

    # 完整学完的课程数：所有小节都标记完成，且至少有一节
    per_course = list(
        (
            await s.execute(
                select(
                    Course.id,
                    func.count(Section.id),
                    func.coalesce(
                        func.sum(func.cast(Section.completed_at.is_not(None), Integer)), 0
                    ),
                )
                .join(Chapter, Chapter.course_id == Course.id)
                .join(Section, Section.chapter_id == Chapter.id)
                .where(Course.user_id == uid)
                .group_by(Course.id)
            )
        ).all()
    )
    courses_done = sum(1 for _, total, done in per_course if total > 0 and total == done)

    # 单门课里的己见卡最大值
    course_rewritten = list(
        (
            await s.execute(
                select(Course.id, func.count(Card.id))
                .join(Chapter, Chapter.course_id == Course.id)
                .join(Section, Section.chapter_id == Chapter.id)
                .join(Card, Card.source_section_id == Section.id)
                .where(
                    Course.user_id == uid,
                    Card.user_id == uid,
                    Card.is_rewritten.is_(True),
                    Card.state == STATE_VAULT,
                )
                .group_by(Course.id)
            )
        ).all()
    )
    max_course_rewritten = max((int(n) for _, n in course_rewritten), default=0)

    pomodoros = int(
        await s.scalar(
            select(func.count(Pomodoro.id)).where(
                Pomodoro.user_id == uid, Pomodoro.status == POMO_COMPLETED
            )
        )
        or 0
    )

    # 连续天数 + 连续「每天 ≥4 颗」天数
    days: dict[str, int] = {}
    for (started,) in await s.execute(
        select(Pomodoro.started_at).where(
            Pomodoro.user_id == uid, Pomodoro.status == POMO_COMPLETED
        )
    ):
        k = started.date().isoformat()
        days[k] = days.get(k, 0) + 1

    def _streak(min_count: int) -> int:
        n = 0
        cursor = utcnow().date()
        if days.get(cursor.isoformat(), 0) < min_count:
            cursor -= timedelta(days=1)  # 今天还没学不算断签
        while days.get(cursor.isoformat(), 0) >= min_count:
            n += 1
            cursor -= timedelta(days=1)
        return n

    reviews = int(
        await s.scalar(select(func.count(ReviewLog.id)).where(ReviewLog.user_id == uid)) or 0
    )

    concepts: set[str] = set()
    for (tags,) in await s.execute(
        select(Card.concept_tags).where(Card.user_id == uid, Card.state == STATE_VAULT)
    ):
        for t in tags or []:
            concepts.add(str(t).strip().lower())

    return {
        "vaulted": vaulted,
        "rewritten": rewritten,
        "rewrite_rate": (rewritten / vaulted) if vaulted else 0.0,
        "max_depth": int(max_depth or 0),
        "real_links": real_links,
        "sections_done": sections_done,
        "courses_done": courses_done,
        "max_course_rewritten": max_course_rewritten,
        "pomodoros": pomodoros,
        "streak": _streak(1),
        "deep_streak": _streak(4),
        "reviews": reviews,
        "concepts": len(concepts),
    }


# ─────────────────────────────────────────────────────────────
# 评估与发放
# ─────────────────────────────────────────────────────────────
async def evaluate(scope: UserScope) -> tuple[list[Badge], dict]:
    """检查有没有新达成的勋章。返回 (新发放的, 统计数据)。

    只发放、不撤回 —— 拿到手的成就不该因为后来删了几张卡就消失。
    """
    stats = await collect_stats(scope)
    owned = {
        b.code: b for b in await scope.all(scope.select(Badge))
    }

    fresh: list[Badge] = []
    for d in BADGES:
        if d.code in owned:
            continue
        done, target = d.progress(stats)
        if done < target:
            continue
        badge = Badge(
            id=new_id(),
            user_id=scope.user_id,
            kind=d.kind,
            code=d.code,
            title=d.title,
            description=d.description,
            criteria={"target": target, "reached": done},
            image_status="pending",
            earned_at=utcnow(),
        )
        scope.add(badge)
        fresh.append(badge)

    if fresh:
        await scope.commit()
        log.info("发放 %s 枚新勋章：%s", len(fresh), [b.code for b in fresh])
    return fresh, stats


async def render_image(user_id: str, badge_id: str) -> None:
    """后台生成勋章图。

    ★ 与发放解耦：勋章先以 pending 状态出现在墙上（用兜底图案），
      图片好了再替换。生图要几十秒且可能失败，绝不能让用户等。
    """
    from app.core.db import SessionLocal
    from app.llm.image import generate_image

    async with SessionLocal() as s:
        badge = await s.get(Badge, badge_id)
        if badge is None or badge.user_id != user_id or badge.image_status == "ready":
            return
        d = BADGE_BY_CODE.get(badge.code)
        if d is None:
            return
        badge.image_status = "generating"
        await s.commit()
        prompt = d.prompt()

    url = await generate_image(prompt, user_id=user_id, scene="badge_image")

    async with SessionLocal() as s:
        badge = await s.get(Badge, badge_id)
        if badge is None:
            return
        if url:
            badge.image_url = url
            badge.image_status = "ready"
        else:
            # 兜底：前端会按 code 画一个确定性的几何图案
            badge.image_status = "failed"
        await s.commit()


def progress_of(code: str, stats: dict) -> dict:
    d = BADGE_BY_CODE.get(code)
    if not d:
        return {"done": 0, "target": 1, "ratio": 0.0}
    done, target = d.progress(stats)
    return {
        "done": round(done, 1),
        "target": target,
        "ratio": round(min(1.0, done / target if target else 0), 3),
    }
