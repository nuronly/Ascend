#!/usr/bin/env python3
"""把某个真实用户的全部学习数据克隆到游客账号（比赛/演示用）。

用法：
    .venv/bin/python scripts/seed_guest.py                     # 自动选数据最多的用户
    .venv/bin/python scripts/seed_guest.py --from me@x.com     # 指定源用户

行为：先清空游客账号现有数据，再完整克隆 —— 重复执行等于「恢复出厂」，
天然幂等，不会产生重复数据。

克隆而非重新生成的原因：
  · 免费 —— 正文 AI 生成一门课约 90 秒 +  tokens，克隆是零成本复制
  · 真实 —— 真实使用长出来的数据（追问链、跨课关联、复习轨迹）
    比临时编造的自然得多，评委看到的才是产品真实的样子
  · 快 —— 几秒完成，生成要十几分钟

检索索引（分词 tsv / 向量 embedding）是内容相关的，与用户无关，
直接复制即可，不需要重新调用 embedding API。
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import delete, func, select  # noqa: E402

from app.api.auth import GUEST_EMAIL  # noqa: E402
from app.core.config import settings  # noqa: E402
from app.core.db import SessionLocal, dispose_db, init_db  # noqa: E402
from app.core.types import new_id  # noqa: E402
from app.models.card import Card, CardLink, CardMessage  # noqa: E402
from app.models.course import Chapter, Course, Section  # noqa: E402
from app.models.document import DocBlock, Document  # noqa: E402
from app.models.graph import CardConcept, Concept, ConceptEdge  # noqa: E402
from app.models.learning import Badge, Pomodoro, ReviewLog, ReviewState  # noqa: E402
from app.models.system import BlockSearch, CardSearch  # noqa: E402
from app.models.user import User  # noqa: E402

GUEST_NAME = "游客"


# ─────────────────────────────────────────────────────────────
# 工具
# ─────────────────────────────────────────────────────────────
def clone_row(obj, **overrides):
    """按 ORM 对象的列复制一行（不走 relationship，避免懒加载地雷）。"""
    data = {c.name: getattr(obj, c.name) for c in obj.__table__.columns}
    data.update(overrides)
    return obj.__class__(**data)


async def pick_source(session) -> User:
    """默认选卡片数最多的非游客用户 —— 展示当然要数据最丰满的那个。"""
    users = (await session.execute(select(User).where(User.is_guest.is_(False)))).scalars().all()
    if not users:
        sys.exit("库里还没有任何正式用户，先注册一个并学一会儿再来克隆")
    best, best_n = None, -1
    for u in users:
        n = await session.scalar(select(func.count(Card.id)).where(Card.user_id == u.id)) or 0
        if n > best_n:
            best, best_n = u, n
    assert best is not None
    return best


async def ensure_guest(session) -> User:
    guest = await session.scalar(select(User).where(User.email == GUEST_EMAIL))
    if guest is None:
        guest = User(
            id=new_id(),
            email=GUEST_EMAIL,
            name=GUEST_NAME,
            password_hash=None,
            email_verified=True,
            is_guest=True,
            settings={
                "theme": "system",
                "default_pomodoro_minutes": 25,
                "daily_token_quota": settings.guest_daily_token_quota,
            },
        )
        session.add(guest)
        await session.flush()
    return guest


async def wipe_guest(session, gid: str) -> None:
    """清空游客数据（保留账号本身）。按外键依赖倒序删，不依赖 CASCADE。"""
    card_ids = select(Card.id).where(Card.user_id == gid)
    block_ids = select(DocBlock.id).where(
        DocBlock.doc_id.in_(select(Document.id).where(Document.user_id == gid))
    )
    await session.execute(delete(ReviewLog).where(ReviewLog.user_id == gid))
    await session.execute(delete(ReviewState).where(ReviewState.user_id == gid))
    await session.execute(delete(CardConcept).where(CardConcept.user_id == gid))
    await session.execute(delete(CardLink).where(CardLink.user_id == gid))
    await session.execute(delete(CardMessage).where(CardMessage.card_id.in_(card_ids)))
    await session.execute(delete(CardSearch).where(CardSearch.user_id == gid))
    await session.execute(delete(Card).where(Card.user_id == gid))
    await session.execute(delete(ConceptEdge).where(ConceptEdge.user_id == gid))
    await session.execute(delete(Concept).where(Concept.user_id == gid))
    await session.execute(delete(Badge).where(Badge.user_id == gid))
    await session.execute(delete(Pomodoro).where(Pomodoro.user_id == gid))
    await session.execute(delete(BlockSearch).where(BlockSearch.user_id == gid))
    await session.execute(delete(DocBlock).where(DocBlock.id.in_(block_ids)))
    await session.execute(delete(Document).where(Document.user_id == gid))
    await session.execute(
        delete(Section).where(
            Section.chapter_id.in_(
                select(Chapter.id).where(
                    Chapter.course_id.in_(select(Course.id).where(Course.user_id == gid))
                )
            )
        )
    )
    await session.execute(
        delete(Chapter).where(
            Chapter.course_id.in_(select(Course.id).where(Course.user_id == gid))
        )
    )
    await session.execute(delete(Course).where(Course.user_id == gid))


# ─────────────────────────────────────────────────────────────
# 克隆
# ─────────────────────────────────────────────────────────────
async def clone_all(session, src: User, guest: User) -> dict[str, int]:
    gid = guest.id
    sid = src.id
    stats: dict[str, int] = {}
    m_doc: dict[str, str] = {}
    m_block: dict[str, str] = {}
    m_course: dict[str, str] = {}
    m_chapter: dict[str, str] = {}
    m_section: dict[str, str] = {}
    m_pomo: dict[str, str] = {}
    m_card: dict[str, str] = {}
    m_concept: dict[str, str] = {}

    # 文档 → 块
    for d in (await session.execute(select(Document).where(Document.user_id == sid))).scalars():
        nid = new_id()
        m_doc[d.id] = nid
        session.add(clone_row(d, id=nid, user_id=gid))
    for b in (
        await session.execute(
            select(DocBlock).where(
                DocBlock.doc_id.in_(select(Document.id).where(Document.user_id == sid))
            )
        )
    ).scalars():
        nid = new_id()
        m_block[b.id] = nid
        session.add(clone_row(b, id=nid, doc_id=m_doc[b.doc_id]))
    # cards.source_doc_block_id 和 block_search.block_id 都指向这里，
    # 必须先落库（见下方 pomodoros 的注释，同一个坑）
    await session.flush()
    stats["文档"] = len(m_doc)

    # 课程 → 章 → 节
    for c in (await session.execute(select(Course).where(Course.user_id == sid))).scalars():
        nid = new_id()
        m_course[c.id] = nid
        session.add(clone_row(c, id=nid, user_id=gid))
    await session.flush()  # chapters 外键指向 courses，先落库保证顺序
    for ch in (
        await session.execute(
            select(Chapter).where(Chapter.course_id.in_(m_course.keys()))
        )
    ).scalars():
        nid = new_id()
        m_chapter[ch.id] = nid
        session.add(clone_row(ch, id=nid, course_id=m_course[ch.course_id]))
    await session.flush()
    for s in (
        await session.execute(
            select(Section).where(Section.chapter_id.in_(m_chapter.keys()))
        )
    ).scalars():
        nid = new_id()
        m_section[s.id] = nid
        session.add(clone_row(s, id=nid, chapter_id=m_chapter[s.chapter_id]))
    stats["课程"] = len(m_course)
    stats["小节"] = len(m_section)

    # 番茄钟（卡片会引用）
    for p in (await session.execute(select(Pomodoro).where(Pomodoro.user_id == sid))).scalars():
        nid = new_id()
        m_pomo[p.id] = nid
        session.add(
            clone_row(
                p,
                id=nid,
                user_id=gid,
                section_id=m_section.get(p.section_id) if p.section_id else None,
            )
        )
    # ★ 必须先落库再克隆卡片。Card 与 Pomodoro 之间只有表级外键、
    # 没有 relationship —— 实测同批 flush 时 SQLAlchemy 的 UOW 不会把
    # pomodoros 排在 cards 前面，插入 cards 时外键直接炸（FOREIGN KEY
    # constraint failed）；分开 flush 则正常。凡是被后续表引用的新实体，
    # 克隆完就 flush，是最稳的纪律。
    await session.flush()
    stats["番茄钟"] = len(m_pomo)

    # 概念 → 边
    for c in (await session.execute(select(Concept).where(Concept.user_id == sid))).scalars():
        nid = new_id()
        m_concept[c.id] = nid
        session.add(
            clone_row(
                c,
                id=nid,
                user_id=gid,
                course_id=m_course.get(c.course_id) if c.course_id else None,
                section_id=m_section.get(c.section_id) if c.section_id else None,
            )
        )
    for e in (
        await session.execute(select(ConceptEdge).where(ConceptEdge.user_id == sid))
    ).scalars():
        if e.from_concept in m_concept and e.to_concept in m_concept:
            session.add(
                clone_row(
                    e,
                    id=new_id(),
                    user_id=gid,
                    course_id=m_course.get(e.course_id) if e.course_id else None,
                    from_concept=m_concept[e.from_concept],
                    to_concept=m_concept[e.to_concept],
                )
            )
    stats["概念"] = len(m_concept)

    # 卡片：先建（parent 暂空），再统一补追问链 —— 不依赖插入顺序
    cards = (
        await session.execute(
            select(Card).where(Card.user_id == sid).order_by(Card.created_at)
        )
    ).scalars().all()
    pending_parent: list[tuple[str, str]] = []
    for c in cards:
        nid = new_id()
        m_card[c.id] = nid
        if c.parent_card_id:
            pending_parent.append((nid, c.parent_card_id))
        session.add(
            clone_row(
                c,
                id=nid,
                user_id=gid,
                parent_card_id=None,
                source_section_id=(
                    m_section.get(c.source_section_id) if c.source_section_id else None
                ),
                source_doc_block_id=(
                    m_block.get(c.source_doc_block_id) if c.source_doc_block_id else None
                ),
                pomodoro_id=(m_pomo.get(c.pomodoro_id) if c.pomodoro_id else None),
            )
        )
    await session.flush()
    for nid, old_parent in pending_parent:
        if old_parent in m_card:
            await session.execute(
                Card.__table__.update()
                .where(Card.__table__.c.id == nid)
                .values(parent_card_id=m_card[old_parent])
            )
    stats["卡片"] = len(m_card)

    # 卡片消息
    n = 0
    for msg in (
        await session.execute(
            select(CardMessage).where(CardMessage.card_id.in_(m_card.keys()))
        )
    ).scalars():
        session.add(clone_row(msg, id=new_id(), card_id=m_card[msg.card_id]))
        n += 1
    stats["卡片消息"] = n

    # 卡片链接（real / potential）
    n = 0
    for lnk in (
        await session.execute(select(CardLink).where(CardLink.user_id == sid))
    ).scalars():
        if lnk.from_card_id in m_card and lnk.to_card_id in m_card:
            session.add(
                clone_row(
                    lnk,
                    id=new_id(),
                    user_id=gid,
                    from_card_id=m_card[lnk.from_card_id],
                    to_card_id=m_card[lnk.to_card_id],
                )
            )
            n += 1
    stats["卡片链接"] = n

    # 卡片-概念关联
    n = 0
    for cc in (
        await session.execute(select(CardConcept).where(CardConcept.user_id == sid))
    ).scalars():
        if cc.card_id in m_card and cc.concept_id in m_concept:
            session.add(
                CardConcept(
                    card_id=m_card[cc.card_id],
                    concept_id=m_concept[cc.concept_id],
                    user_id=gid,
                )
            )
            n += 1

    # 复习状态与日志
    n = 0
    for rs in (
        await session.execute(select(ReviewState).where(ReviewState.user_id == sid))
    ).scalars():
        if rs.card_id in m_card:
            session.add(clone_row(rs, card_id=m_card[rs.card_id], user_id=gid))
            n += 1
    stats["复习状态"] = n
    for rl in (
        await session.execute(select(ReviewLog).where(ReviewLog.user_id == sid))
    ).scalars():
        if rl.card_id in m_card:
            session.add(clone_row(rl, id=new_id(), card_id=m_card[rl.card_id], user_id=gid))

    # 勋章（图片路径是全局资源，直接复用）
    n = 0
    for b in (await session.execute(select(Badge).where(Badge.user_id == sid))).scalars():
        session.add(clone_row(b, id=new_id(), user_id=gid))
        n += 1
    stats["勋章"] = n

    # 检索索引：分词与向量都是内容相关，原样复制，零 API 成本
    n = 0
    for cs in (
        await session.execute(select(CardSearch).where(CardSearch.user_id == sid))
    ).scalars():
        if cs.card_id in m_card:
            session.add(
                CardSearch(
                    card_id=m_card[cs.card_id],
                    user_id=gid,
                    tsv=cs.tsv,
                    content_hash=cs.content_hash,
                    embedding=cs.embedding,
                    embedded_at=cs.embedded_at,
                )
            )
            n += 1
    stats["检索索引"] = n
    n = 0
    for bs in (
        await session.execute(select(BlockSearch).where(BlockSearch.user_id == sid))
    ).scalars():
        if bs.block_id in m_block:
            session.add(
                BlockSearch(
                    block_id=m_block[bs.block_id],
                    user_id=gid,
                    tsv=bs.tsv,
                    content_hash=bs.content_hash,
                    embedding=bs.embedding,
                    embedded_at=bs.embedded_at,
                )
            )
            n += 1

    return stats


async def rebuild_fts(session, gid: str) -> None:
    """FTS5 虚表没有触发器，克隆后要把分词文本补进去。"""
    from sqlalchemy import text

    from app.search.fts import BLOCK_FTS, CARD_FTS

    if not settings.is_sqlite:
        return
    # ★ 本项目 SessionLocal 是 autoflush=False（db.py，有意的显式 flush 风格）。
    # clone_all 里 add 的 CardSearch 还只在 session.new 里，
    # 不先 flush，下面的 select 查数据库只能得到 0 行，
    # 于是 FTS 表永远写不进去 —— 第二大脑对游客就搜不到任何卡片。
    await session.flush()
    rows = (
        await session.execute(
            select(CardSearch.card_id, CardSearch.tsv).where(CardSearch.user_id == gid)
        )
    ).all()
    for cid, tsv in rows:
        if tsv.strip():
            await session.execute(
                text(f"INSERT INTO {CARD_FTS} (card_id, user_id, content) VALUES (:c, :u, :t)"),
                {"c": cid, "u": gid, "t": tsv},
            )
    rows = (
        await session.execute(
            select(BlockSearch.block_id, BlockSearch.tsv).where(BlockSearch.user_id == gid)
        )
    ).all()
    for bid, tsv in rows:
        if tsv.strip():
            await session.execute(
                text(f"INSERT INTO {BLOCK_FTS} (block_id, user_id, content) VALUES (:b, :u, :t)"),
                {"b": bid, "u": gid, "t": tsv},
            )


async def main() -> None:
    ap = argparse.ArgumentParser(description="克隆真实用户数据到游客账号")
    ap.add_argument("--from", dest="from_email", default="", help="源用户邮箱（默认：卡片最多的用户）")
    ap.add_argument("--yes", action="store_true", help="跳过确认")
    args = ap.parse_args()

    # 先确保 schema 最新（is_guest 列的轻量迁移就在 init_db 里）
    await init_db()

    async with SessionLocal() as session:
        if args.from_email:
            src = await session.scalar(
                select(User).where(User.email == args.from_email.lower().strip())
            )
            if src is None:
                sys.exit(f"找不到用户 {args.from_email}")
        else:
            src = await pick_source(session)

        guest = await ensure_guest(session)
        n_cards = await session.scalar(select(func.count(Card.id)).where(Card.user_id == src.id)) or 0
        n_courses = await session.scalar(
            select(func.count(Course.id)).where(Course.user_id == src.id)
        ) or 0

        print(f"源用户：{src.email}（{n_courses} 门课程 · {n_cards} 张卡片）")
        if not args.yes:
            ans = input("将清空游客账号并克隆以上数据，继续？[y/N] ")
            if ans.strip().lower() != "y":
                sys.exit("已取消")

        await wipe_guest(session, guest.id)
        stats = await clone_all(session, src, guest)
        await rebuild_fts(session, guest.id)
        await session.commit()

        print("\n克隆完成：")
        for k, v in stats.items():
            print(f"  {k:<8} {v}")
        print(f"\n游客账号：{GUEST_EMAIL}")
        print("现在登录页点「游客模式进入」即可看到全部内容。")

    await dispose_db()


if __name__ == "__main__":
    asyncio.run(main())
