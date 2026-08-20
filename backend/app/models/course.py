"""课程 / 章 / 节（PLAN §3.1 / §5）。

核心约束：小节正文 **懒生成** —— 只有用户点进去才生成，生成后缓存。
content_status 就是这套懒生成状态机的载体。
已人工修订注释
"""

from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.db import Base
from app.core.types import IdType, JSONType, TZDateTime
from app.models._common import TimestampMixin, pk

# courses.status
COURSE_DRAFT = "draft"  # 刚建，大纲还没出来
COURSE_OUTLINING = "outlining"  # 大纲生成中
COURSE_READY = "ready"  # 大纲已就绪，小节按需生成
COURSE_FAILED = "failed"
# 注意：课程没有归档态。课程是可再生资源，删除走硬删（delete_course），
# 课上长出的卡片由外键 ondelete=SET NULL 保护，不会被带走

# sections.content_status —— 懒生成状态机
SECTION_PENDING = "pending"  # 还没生成过
SECTION_GENERATING = "generating"  # 正在流式生成
SECTION_READY = "ready"  # 已缓存，直接读库
SECTION_FAILED = "failed"


class Course(Base, TimestampMixin):
    __tablename__ = "courses"

    id: Mapped[str] = pk()  # 主键
    # 归属用户；用户注销时该用户的课程级联删除
    user_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # 用户输入的原始主题，如「Transformer 注意力机制」；建课时的第一手输入
    topic: Mapped[str] = mapped_column(String(500), nullable=False)
    # AI 生成的正式课程标题；大纲出来前先用 topic 占位（default=""）
    title: Mapped[str] = mapped_column(String(500), nullable=False, default="")
    # AI 生成的课程简介，展示在课程卡片/详情页
    description: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # 状态机：draft-刚健 → outlining大纲生成中 → ready 大纲就绪/ failed 生成失败/ archived软删除）
    status: Mapped[str] = mapped_column(String(20), default=COURSE_DRAFT, nullable=False)
    # 难度等级，三选一：beginner / intermediate / advanced。
    # 生成时经 prompts.LEVEL_HINT 映射成一句中文难度描述（如「面向零基础读者，多用类比」），
    level: Mapped[str] = mapped_column(String(20), default="intermediate", nullable=False)
    # 大纲生成失败时的错误信息，成功后置回 None；配合 status=failed 展示给用户
    error: Mapped[str | None] = mapped_column(Text)
    # 杂项扩展字段（JSON）。目前存建课时的 extra 附加要求，如 {"extra": "偏重工程实现"}
    meta: Mapped[dict[str, Any]] = mapped_column(JSONType, default=dict, nullable=False)
    # AI 联网检索后推荐的参考资料（JSON 数组）。
    # 每项：{title, url, source, kind, authority, why}
    # ★ 落库前会做 url 白名单校验：只有本次检索里真实出现过的链接才留下。
    #   模型编造一个看起来对的 url，学习者点进去发现 404，比不给链接严重得多。
    resources: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)

    # 关联的章节，删课级联删章
    chapters: Mapped[list[Chapter]] = relationship(
        back_populates="course",
        cascade="all, delete-orphan",
        order_by="Chapter.idx",
        lazy="selectin",
    )

    # 复合索引
    __table_args__ = (Index("ix_courses_user_status", "user_id", "status", "created_at"),)

#OUTLINE_SYSTEM 要求，4~8 个章节，每章 3~6 个小节。章节之间必须有真实的递进关系，不是同级概念的平行罗列。
class Chapter(Base):
    __tablename__ = "chapters"

    id: Mapped[str] = pk()  # 主键
    # 所属课程；删课级联删章
    course_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 章在课程内的顺序号（从 0 起），决定展示与「上一节/下一节」导航的排序
    idx: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    # 章标题（AI 生成）
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)
    # 章导读/摘要
    # 注意：Chapter 没有 TimestampMixin —— 它是纯结构层，随课程整体生成，不单独追踪时间

    course: Mapped[Course] = relationship(back_populates="chapters")  # 反向指回课程
    # 关联小节，按 idx 升序；删章级联删节
    sections: Mapped[list[Section]] = relationship(
        back_populates="chapter",
        cascade="all, delete-orphan",
        order_by="Section.idx",
        lazy="selectin",
    )


class Section(Base):
    __tablename__ = "sections"

    id: Mapped[str] = pk()  # 主键；也是卡片 source_section_id、番茄钟 section_id 的指向
    # 所属章；删章级联删节
    chapter_id: Mapped[str] = mapped_column(
        IdType, ForeignKey("chapters.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # 小节在本章内的顺序号（从 0 起）
    idx: Mapped[int] = mapped_column(Integer, nullable=False)
    title: Mapped[str] = mapped_column(String(500), nullable=False)  # 小节标题（大纲阶段生成）
    summary: Mapped[str] = mapped_column(Text, default="", nullable=False)  # 小节要点摘要（大纲阶段生成）
    # 注意：曾有 est_minutes（AI 估计的阅读耗时）——AI 估不准个体速度，已删除。
    # 番茄钟时长走「用户设置 default_pomodoro_minutes > 25」

    # ── 懒生成产物 ──
    # 生成好的正文 Markdown（已剥离尾部概念块）；未生成时为 NULL，是懒生成缓存的本体
    content_md: Mapped[str | None] = mapped_column(Text)
    # 懒生成状态机：pending（没生成过）→ generating（流式中）→ ready（已缓存）/ failed
    content_status: Mapped[str] = mapped_column(
        String(20), default=SECTION_PENDING, nullable=False
    )
    # 本节涉及的关键概念名列表（JSON）。大纲阶段先给种子，正文生成时用模型抽出的概念覆盖，
    # 供 AI 概念图抽取节点，避免二次调用（PLAN §3.1）
    key_concepts: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    # 前置知识点 id 列表（JSON），撑起概念图的「前置」分层关系，决定学习顺序
    prerequisite_ids: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    # 正文首次生成完成的时间戳；NULL 表示尚未生成
    generated_at: Mapped[datetime | None] = mapped_column(TZDateTime)
    # 用户点过「讲浅一点/深一点/换个例子」强制重生成的次数，用于展示「已重生成 N 次」
    regenerate_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # 本节的延伸阅读（JSON 数组，同 Course.resources 的结构）。
    # 正文生成时若模型联网核实过，检索到的权威结果会落在这里
    resources: Mapped[list[Any]] = mapped_column(JSONType, default=list, nullable=False)
    # 学习进度：用户标记学完的时间戳；NULL = 未完成。课程详情页据此算完成度
    completed_at: Mapped[datetime | None] = mapped_column(TZDateTime)

    chapter: Mapped[Chapter] = relationship(back_populates="sections")  # 反向指回章

    # 复合索引：按 (章, 节序) 快速取全课的小节顺序，支撑导航与列表
    __table_args__ = (Index("ix_sections_chapter_idx", "chapter_id", "idx"),)
