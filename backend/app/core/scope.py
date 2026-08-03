"""★ 用户数据隔离层（PLAN §4.2 / §7 风险 #12）。

登录页一天就写完了，难的是数据隔离不能漏。本模块是唯一的数据访问入口：

  · 所有查询强制带 user 过滤，业务层禁止裸写不带 scope 的 SQL
  · 拿不到 / 不属于当前用户的资源一律 404（而非 403 —— 不泄露存在性）
  · 对没有 user_id 列的从属表（chapters / sections / card_messages …），
    必须沿外键回溯到 owner 校验，不能靠"反正 id 猜不到"
  · 图遍历特别危险：沿 card_links 走 1~2 跳时每跳都要校验 owner，
    否则一条脏数据就能把别人的卡拉进你的第二大脑
"""

from __future__ import annotations

from typing import Any, TypeVar

from fastapi import HTTPException, status
from sqlalchemy import Select, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.card import Card, CardMessage
from app.models.course import Chapter, Course, Section
from app.models.document import DocBlock, Document

T = TypeVar("T")


def not_found(what: str = "资源") -> HTTPException:
    return HTTPException(status.HTTP_404_NOT_FOUND, f"{what}不存在")


class UserScope:
    """绑定到单个用户的数据访问句柄。"""

    __slots__ = ("session", "user_id")

    def __init__(self, session: AsyncSession, user_id: str) -> None:
        self.session = session
        self.user_id = user_id

    # ── 直接带 user_id 列的表 ──
    def select(self, model: type[T], *cols: Any) -> Select:
        """返回已注入 user_id 过滤的 select。业务层一律用它起手。"""
        stmt = select(*cols) if cols else select(model)
        return stmt.where(model.user_id == self.user_id)  # type: ignore[attr-defined]

    async def get(self, model: type[T], obj_id: str | None) -> T | None:
        if not obj_id:
            return None
        obj = await self.session.get(model, obj_id)
        if obj is None or getattr(obj, "user_id", None) != self.user_id:
            return None
        return obj

    async def require(self, model: type[T], obj_id: str | None, what: str = "资源") -> T:
        obj = await self.get(model, obj_id)
        if obj is None:
            raise not_found(what)
        return obj

    async def all(self, stmt: Select) -> list[Any]:
        return list((await self.session.scalars(stmt)).all())

    async def one_or_none(self, stmt: Select) -> Any:
        return (await self.session.scalars(stmt)).first()

    async def count(self, stmt: Select) -> int:
        from sqlalchemy import func

        return int(
            await self.session.scalar(
                select(func.count()).select_from(stmt.subquery())
            )
            or 0
        )

    # ── 从属表：沿外键回溯校验 owner ──
    async def require_chapter(self, chapter_id: str) -> Chapter:
        stmt = (
            select(Chapter)
            .join(Course, Course.id == Chapter.course_id)
            .where(Chapter.id == chapter_id, Course.user_id == self.user_id)
        )
        obj = (await self.session.scalars(stmt)).first()
        if obj is None:
            raise not_found("章节")
        return obj

    async def require_section(self, section_id: str) -> Section:
        stmt = (
            select(Section)
            .join(Chapter, Chapter.id == Section.chapter_id)
            .join(Course, Course.id == Chapter.course_id)
            .where(Section.id == section_id, Course.user_id == self.user_id)
        )
        obj = (await self.session.scalars(stmt)).first()
        if obj is None:
            raise not_found("小节")
        return obj

    async def section_course(self, section_id: str) -> tuple[Section, Chapter, Course]:
        stmt = (
            select(Section, Chapter, Course)
            .join(Chapter, Chapter.id == Section.chapter_id)
            .join(Course, Course.id == Chapter.course_id)
            .where(Section.id == section_id, Course.user_id == self.user_id)
        )
        row = (await self.session.execute(stmt)).first()
        if row is None:
            raise not_found("小节")
        return row[0], row[1], row[2]

    async def require_card(self, card_id: str) -> Card:
        return await self.require(Card, card_id, "卡片")

    async def require_card_message(self, message_id: str) -> CardMessage:
        stmt = (
            select(CardMessage)
            .join(Card, Card.id == CardMessage.card_id)
            .where(CardMessage.id == message_id, Card.user_id == self.user_id)
        )
        obj = (await self.session.scalars(stmt)).first()
        if obj is None:
            raise not_found("对话")
        return obj

    async def require_doc_block(self, block_id: str) -> DocBlock:
        stmt = (
            select(DocBlock)
            .join(Document, Document.id == DocBlock.doc_id)
            .where(DocBlock.id == block_id, Document.user_id == self.user_id)
        )
        obj = (await self.session.scalars(stmt)).first()
        if obj is None:
            raise not_found("文档段落")
        return obj

    # ── 图遍历：每跳校验 owner ──
    async def neighbor_card_ids(
        self, card_ids: list[str], *, kinds: tuple[str, ...] = ("real",), limit: int = 200
    ) -> set[str]:
        """沿 card_links 走一跳。

        三重保险：link 自身带 user_id 过滤 + 两端卡片都 join 回 cards 校验 owner。
        单靠 link.user_id 是不够的 —— 一条被篡改的 link 行就能越界。
        """
        if not card_ids:
            return set()
        from sqlalchemy import or_

        from app.models.card import CardLink

        src = select(Card.id).where(Card.id == CardLink.from_card_id, Card.user_id == self.user_id)
        dst = select(Card.id).where(Card.id == CardLink.to_card_id, Card.user_id == self.user_id)
        stmt = (
            select(CardLink.from_card_id, CardLink.to_card_id)
            .where(
                CardLink.user_id == self.user_id,
                CardLink.kind.in_(kinds),
                or_(
                    CardLink.from_card_id.in_(card_ids),
                    CardLink.to_card_id.in_(card_ids),
                ),
                src.exists(),
                dst.exists(),
            )
            .limit(limit)
        )
        found: set[str] = set()
        for a, b in await self.session.execute(stmt):
            found.add(a)
            found.add(b)
        return found - set(card_ids)

    async def commit(self) -> None:
        await self.session.commit()

    def add(self, obj: Any) -> None:
        self.session.add(obj)

    async def flush(self) -> None:
        await self.session.flush()
