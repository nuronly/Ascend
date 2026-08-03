"""★ 卡片系统 —— 整个产品的核心表（PLAN §3.2 / §5）。

字段必须一次埋齐：v0.4 第二大脑的质量 = 前三期沉淀数据的质量，
字段现在没埋，历史数据永远补不回来（PLAN §7 风险 #1，🔴 最高）。
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base
from app.core.types import IdType, JSONType, TZDateTime
from app.models._common import TimestampMixin, pk

# ── cards.source_type ──
SRC_COURSE = "course"
SRC_DOC = "doc"
SRC_BRAIN = "brain"

# ── cards.origin：套娃来源，区分「从原文划的」还是「从父卡答案里划的」──
ORIGIN_SOURCE_TEXT = "source_text"  # 在原文划词 → 根卡
ORIGIN_PARENT_ANSWER = "parent_answer"  # 在 AI 回答里划词 → 子卡（铁律 #1）
ORIGIN_PARENT_NOTE = "parent_note"  # 在自己写的己见里划词 → 子卡
ORIGIN_MANUAL = "manual"  # 手动新建

# ── cards.state：状态机（PLAN §3.2.1）──
# draft ──确认/改写──▶ vault（进图谱、进第二大脑、进 FSRS）
#   └──超时未确认──▶ archived（"未整理"，7 天后可批量清理）
STATE_DRAFT = "draft"
STATE_VAULT = "vault"
STATE_ARCHIVED = "archived"

# ── card_links.kind：real / potential 两层分离（Folium 核心借鉴，PLAN §1.1）──
LINK_REAL = "real"  # 用户明确建立，"这两张卡应该长期思维相邻"
LINK_POTENTIAL = "potential"  # 系统建议，"是问题，不是事实"

# ── card_links.relation（PLAN §3.4）──
REL_CONTINUATION = "continuation"  # 延续
REL_CONTRAST = "contrast"  # 对照
REL_EVIDENCE = "evidence"  # 证据
REL_CONSEQUENCE = "consequence"  # 结果
REL_TENSION = "tension"  # 有价值的张力
RELATIONS = (REL_CONTINUATION, REL_CONTRAST, REL_EVIDENCE, REL_CONSEQUENCE, REL_TENSION)


class Card(Base, TimestampMixin):
    __tablename__ = "cards"

    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )

    # ── 内容 ──
    question: Mapped[str] = mapped_column(Text, default="", nullable=False)
    ai_answer: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # user_note = 己见。Folium："卡片应该是处理过的思考，而不是摘抄堆积"（PLAN §1.3）
    user_note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    is_rewritten: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # ── 写入期抽取（PLAN §3.6 第 1 步：把检索难度前移到写入期）──
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    concept_tags: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    enriched_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    # ── 来源 ──
    source_type: Mapped[str] = mapped_column(String(20), default=SRC_COURSE, nullable=False)
    source_section_id: Mapped[str | None] = mapped_column(
        IdType, ForeignKey("sections.id", ondelete="SET NULL"), index=True
    )
    source_doc_block_id: Mapped[str | None] = mapped_column(
        IdType, ForeignKey("doc_blocks.id", ondelete="SET NULL"), index=True
    )
    selected_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # 原文语境（划中词所在的整句），供卡片头部"引："展示
    context_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # 精确回跳定位：course 记 {prefix, suffix, start, end}；doc 记 {page, block_id, char_offset}
    text_anchor: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)

    # ── ★ 套娃来源 ──
    origin: Mapped[str] = mapped_column(String(20), default=ORIGIN_SOURCE_TEXT, nullable=False)
    # 当 origin=parent_answer：划中的是父卡的哪一条回答
    origin_message_id: Mapped[str | None] = mapped_column(IdType)
    # 在那条回答文本里的 start/end 偏移，用于父卡内高亮
    origin_offset: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)

    # ── ★ 画布位置（用户拖过就要记住，PLAN §3.2.0）──
    canvas_x: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    canvas_y: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    collapsed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # 用户是否手动拖动过；没拖过的卡跟随自动布局
    pinned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # ── 结构：Luhmann 编号，1 / 1a / 1a1 / 1a1b（PLAN §1.4）──
    parent_card_id: Mapped[str | None] = mapped_column(
        IdType, ForeignKey("cards.id", ondelete="CASCADE"), index=True
    )
    luhmann_id: Mapped[str] = mapped_column(String(64), default="", nullable=False)
    depth: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # ── 行为关联（PLAN §3.3）──
    pomodoro_id: Mapped[str | None] = mapped_column(
        IdType, ForeignKey("pomodoros.id", ondelete="SET NULL"), index=True
    )

    # ── 状态 ──
    state: Mapped[str] = mapped_column(String(20), default=STATE_DRAFT, nullable=False)
    vaulted_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    touch_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    last_touched_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    children: Mapped[list[Card]] = relationship(
        back_populates="parent",
        cascade="all, delete-orphan",
        lazy="noload",
    )
    parent: Mapped[Card | None] = relationship(
        back_populates="children", remote_side="Card.id", lazy="noload"
    )
    messages: Mapped[list[CardMessage]] = relationship(
        back_populates="card",
        cascade="all, delete-orphan",
        order_by="CardMessage.seq",
        lazy="selectin",
    )

    __table_args__ = (
        Index("ix_cards_user_state_created", "user_id", "state", "created_at"),
        Index("ix_cards_user_section", "user_id", "source_section_id"),
        Index("ix_cards_parent", "parent_card_id"),
        Index("ix_cards_user_pomodoro", "user_id", "pomodoro_id"),
    )

    @property
    def is_root(self) -> bool:
        return self.parent_card_id is None


class CardMessage(Base):
    """卡片内的对话轮次 —— 一张卡可多轮（PLAN §3.2.0）。"""

    __tablename__ = "card_messages"

    id: Mapped[str] = pk()
    card_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("cards.id", ondelete="CASCADE"), nullable=False, index=True
    )
    seq: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    role: Mapped[str] = mapped_column(String(16), nullable=False)  # user | assistant
    content: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # 流式生成中途的消息标记为 pending，完成后转 done；失败为 failed
    status: Mapped[str] = mapped_column(String(16), default="done", nullable=False)
    token_usage: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)

    card: Mapped[Card] = relationship(back_populates="messages")

    __table_args__ = (Index("ix_card_messages_card_seq", "card_id", "seq"),)


class CardLink(Base):
    """★ real / potential 两层分离（PLAN §1.1）。

    AI 只能产生 potential，只有用户点"提升"才变成 real link。
    用户的图永远是用户自己的图，AI 只负责提示可能遗漏的关联。
    不这么做，图很快会变成噪音网（PLAN §7 风险 #3）。
    """

    __tablename__ = "card_links"

    id: Mapped[str] = pk()
    user_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    from_card_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("cards.id", ondelete="CASCADE"), nullable=False
    )
    to_card_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("cards.id", ondelete="CASCADE"), nullable=False
    )
    kind: Mapped[str] = mapped_column(String(16), default=LINK_REAL, nullable=False)
    relation: Mapped[str] = mapped_column(String(20), default=REL_CONTINUATION, nullable=False)
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    confidence: Mapped[float | None] = mapped_column(Float)  # 仅 potential 有
    created_by: Mapped[str] = mapped_column(String(10), default="user", nullable=False)
    promoted_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    # 用户明确拒绝过的 potential，不再重复推荐
    dismissed_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False, index=True)

    __table_args__ = (
        Index("ix_card_links_from_kind", "from_card_id", "kind"),
        Index("ix_card_links_to_kind", "to_card_id", "kind"),
        Index("ix_card_links_user", "user_id", "kind"),
        Index("uq_card_links_pair", "from_card_id", "to_card_id", "kind", unique=True),
    )
