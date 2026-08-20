"""★ 卡片系统 —— 整个产品的核心表。
注释已人工处理

字段必须一次埋齐：v0.4 第二大脑的质量 = 前三期沉淀数据的质量，
字段现在没埋，历史数据永远补不回来。
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

# ── cards.kind：卡片的层级 ──
# ★ 卢曼卡片盒的三层，这里用同一张表表达（PLAN §1.1 的自然延伸）：
#     划词提问        → 闪念笔记（fleeting）   kind=card, state=draft
#     回答 + 己见     → 文献笔记（literature） kind=card, state=vault
#     一节学完汇流成  → **永久笔记**（permanent） kind=note
#   为什么不另建 notes 表：笔记卡在语义上就是「更高层级的卡片」，复用这张表
#   等于免费继承划词追问（在自己的笔记里划词又能提问，这是最有价值的闭环）、
#   问题图、FSRS 复习、FTS 检索、导出。新建表会把这些能力全部切断，
#   再一个个重接回来。
KIND_CARD = "card"
KIND_NOTE = "note"

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

    id: Mapped[str] = pk()  # 主键，uuid hex
    # 归属用户；注销级联删除。用户一切资产的根外键
    user_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )

    # 层级：card（划词卡）/ note（一节汇流成的笔记卡）。见上面 KIND_* 的说明
    kind: Mapped[str] = mapped_column(String(10), default=KIND_CARD, nullable=False)

    # ── 内容 ──
    question: Mapped[str] = mapped_column(Text, default="", nullable=False)  # 卡片的问题（划词时用户问的）
    # AI 首轮回答；后续追问在 card_messages。
    # ★ 笔记卡用它存 **AI 原稿快照**：用户改了也不动这份，随时能「看看 AI 原来写的」——
    #   知道原版还在，用户才敢大胆删改。
    ai_answer: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # user_note = 己见。Folium："卡片应该是处理过的思考，而不是摘抄堆积"（PLAN §1.3）
    # 进度图「绿球 = 写过己见」看的就是它非空。
    # ★ 笔记卡用它存**用户的终稿**，初始留空（不预填 AI 原稿）：
    #   展示走 user_note or ai_answer，这样 is_rewritten 仍然如实表示
    #   「用户真的动手改过」，己见率这个指标不会被自动生成的内容注水。
    user_note: Mapped[str] = mapped_column(Text, default="", nullable=False)
    is_rewritten: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)  # 是否写过己见的冗余标记（查询方便）

    # ★ 笔记卡吸收了哪些划词卡（id 数组）。
    #   卡片不再是独立存在的东西 —— 它绑定在「小节」和「笔记」上：
    #   小节靠 source_section_id，笔记靠这个字段。有了它，笔记才能反向展开
    #   「我当时问过什么」，卡片也才第一次有了阅读语境。
    note_sources: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)

    # ── 写入期抽取（PLAN §3.6 第 1 步：把检索难度前移到写入期）──
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)  # 入 vault 时 AI 抽的一句话摘要，供第二大脑检索
    concept_tags: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)  # 概念标签列表，关联概念图用
    enriched_at: Mapped[datetime | None] = mapped_column(TZDateTime)  # 抽取完成时间；NULL = 未 enrich（draft 卡）

    # ── 来源 ──
    # 从哪划的：course（课程正文）/ doc（文档）/ brain（第二大脑）
    source_type: Mapped[str] = mapped_column(String(20), default=SRC_COURSE, nullable=False)
    # 来源小节。SET NULL：删课不删卡，只丢来源指针（课程可再生，卡片不可再生）
    source_section_id: Mapped[str | None] = mapped_column(
        IdType, ForeignKey("sections.id", ondelete="SET NULL"), index=True
    )
    # 来源文档块（与 source_section_id 二选一，看 source_type）
    source_doc_block_id: Mapped[str | None] = mapped_column(
        IdType, ForeignKey("doc_blocks.id", ondelete="SET NULL"), index=True
    )
    selected_text: Mapped[str] = mapped_column(Text, default="", nullable=False)  # 划中的那个词，如「softmax」
    # 原文语境（划中词所在的整句），供卡片头部"引："展示
    context_text: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # 精确回跳定位（JSON）：course 记 {prefix, suffix, start, end}；doc 记 {page, block_id, char_offset}
    # 前端靠它在原文里画高亮下划线、点击回跳
    text_anchor: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)

    # ── ★ 套娃来源 ──
    # 这张卡怎么来的：source_text（原文划词→根卡）/ parent_answer（在 AI 回答里
    # 划词→子卡，铁律 #1）/ parent_note（在自己的己见里划词）/ manual（手动新建）
    origin: Mapped[str] = mapped_column(String(20), default=ORIGIN_SOURCE_TEXT, nullable=False)
    # 当 origin=parent_answer：划中的是父卡的哪一条回答（card_messages.id）
    origin_message_id: Mapped[str | None] = mapped_column(IdType)
    # 在那条回答文本里的 {start, end} 偏移（JSON），用于父卡内高亮「这个词被子卡追问过」
    origin_offset: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)

    # ── ★ 画布位置（用户拖过就要记住，PLAN §3.2.0）──
    canvas_x: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)  # 卡片空间里的 x 坐标
    canvas_y: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)  # y 坐标
    collapsed: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)  # 是否折叠（只显示标题）
    # 用户是否手动拖动过；没拖过的卡跟随自动布局
    pinned: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # ── 结构：parent_card_id + depth 表达追问树 ──
    # 父卡（自引用）。CASCADE：删父卡连同子卡一起删 —— 追问链是父子一体的
    parent_card_id: Mapped[str | None] = mapped_column(
        IdType, ForeignKey("cards.id", ondelete="CASCADE"), index=True
    )
    depth: Mapped[int] = mapped_column(Integer, default=0, nullable=False)  # 链深：0=根卡，追问越深越大

    # ── 行为关联（PLAN §3.3）──
    # 建卡时正开着哪颗番茄；番茄结束时的「卡片回顾」就按它捞这批卡。SET NULL：番茄删除不带走卡
    pomodoro_id: Mapped[str | None] = mapped_column(
        IdType, ForeignKey("pomodoros.id", ondelete="SET NULL"), index=True
    )

    # ── 状态 ──
    # 状态机：draft（草稿）→ vault（确认入仓：进图谱、第二大脑、FSRS）/ archived（未整理）
    state: Mapped[str] = mapped_column(String(20), default=STATE_DRAFT, nullable=False)
    vaulted_at: Mapped[datetime | None] = mapped_column(TZDateTime)  # 入仓时间；NULL = 还没进仓库
    touch_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)  # 被翻出来看过的次数
    last_touched_at: Mapped[datetime | None] = mapped_column(TZDateTime)  # 最近被触碰时间

    # 自引用关系：子卡列表 / 父卡。noload = 不自动加载，追问树由查询显式组装
    children: Mapped[list[Card]] = relationship(
        back_populates="parent",
        cascade="all, delete-orphan",
        lazy="noload",
    )
    parent: Mapped[Card | None] = relationship(
        back_populates="children", remote_side="Card.id", lazy="noload"
    )
    # 卡内多轮对话，按轮次排序；selectin 一次预加载（卡片详情必带对话）
    messages: Mapped[list[CardMessage]] = relationship(
        back_populates="card",
        cascade="all, delete-orphan",
        order_by="CardMessage.seq",
        lazy="selectin",
    )

    __table_args__ = (
        # 仓库页：某用户按状态筛、按时间排
        Index("ix_cards_user_state_created", "user_id", "state", "created_at"),
        # 小节页：某用户在这节建的卡；也用于「这一节有没有笔记卡」
        Index("ix_cards_user_section_kind", "user_id", "source_section_id", "kind"),
        # 追问树：查某卡的全部子卡
        Index("ix_cards_parent", "parent_card_id"),
        # 番茄回顾：某用户某颗番茄产出的卡
        Index("ix_cards_user_pomodoro", "user_id", "pomodoro_id"),
    )

    @property
    def is_root(self) -> bool:
        """是否根卡（从原文划的，不是追问出来的）。"""
        return self.parent_card_id is None


class CardMessage(Base):
    """卡片内的对话轮次 —— 一张卡可多轮（PLAN §3.2.0）。"""

    __tablename__ = "card_messages"

    id: Mapped[str] = pk()  # 主键；子卡的 origin_message_id 指向这里
    # 属于哪张卡；删卡级联删对话
    card_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("cards.id", ondelete="CASCADE"), nullable=False, index=True
    )
    seq: Mapped[int] = mapped_column(Integer, default=0, nullable=False)  # 第几轮（展示排序）
    role: Mapped[str] = mapped_column(String(16), nullable=False)  # user | assistant
    content: Mapped[str] = mapped_column(Text, default="", nullable=False)  # 这一轮的内容（Markdown）
    # 流式生成中途的消息标记为 pending，完成后转 done；失败为 failed —— 前端靠它渲染「正在输入」
    status: Mapped[str] = mapped_column(String(16), default="done", nullable=False)
    token_usage: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)  # 本轮 token 用量（JSON）
    created_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False)

    card: Mapped[Card] = relationship(back_populates="messages")

    __table_args__ = (Index("ix_card_messages_card_seq", "card_id", "seq"),)  # 按卡取对话、按轮次排序


class CardLink(Base):
    """★ real / potential 两层分离（PLAN §1.1）。

    AI 只能产生 potential，只有用户点"提升"才变成 real link。
    用户的图永远是用户自己的图，AI 只负责提示可能遗漏的关联。
    不这么做，图很快会变成噪音网（PLAN §7 风险 #3）。
    """

    __tablename__ = "card_links"

    id: Mapped[str] = pk()  # 主键
    # 归属用户（连线也是用户资产；CASCADE 随用户删除）
    user_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # 起点卡；任一端卡被删，连线随之消失（CASCADE）
    from_card_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("cards.id", ondelete="CASCADE"), nullable=False
    )
    to_card_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("cards.id", ondelete="CASCADE"), nullable=False
    )  # 终点卡
    # real（用户亲手建的长期关联）/ potential（AI 建议，「是问题不是事实」）
    kind: Mapped[str] = mapped_column(String(16), default=LINK_REAL, nullable=False)
    # 语义关系：continuation 延续 / contrast 对照 / evidence 证据 / consequence 结果 / tension 张力
    relation: Mapped[str] = mapped_column(String(20), default=REL_CONTINUATION, nullable=False)
    note: Mapped[str] = mapped_column(Text, default="", nullable=False)  # 连线的备注说明（可选）
    confidence: Mapped[float | None] = mapped_column(Float)  # AI 对建议的置信度，仅 potential 有
    created_by: Mapped[str] = mapped_column(String(10), default="user", nullable=False)  # user / ai —— AI 只能产 potential
    promoted_at: Mapped[datetime | None] = mapped_column(TZDateTime)  # 用户把 potential「提升」为 real 的时间
    # 用户明确拒绝过的 potential，不再重复推荐
    dismissed_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    created_at: Mapped[datetime] = mapped_column(TZDateTime, nullable=False, index=True)

    __table_args__ = (
        # 从焦点卡出发/到达焦点卡的连线（问题图渲染）
        Index("ix_card_links_from_kind", "from_card_id", "kind"),
        Index("ix_card_links_to_kind", "to_card_id", "kind"),
        # 某用户的某类连线列表
        Index("ix_card_links_user", "user_id", "kind"),
        # 同一对卡同一层只允许一条 —— 防重复建链
        Index("uq_card_links_pair", "from_card_id", "to_card_id", "kind", unique=True),
    )
