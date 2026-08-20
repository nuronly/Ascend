/** 后端数据类型。与 PLAN §5 的 schema 一一对应。 */

export interface User {
  id: string
  email: string
  name: string
  /** 游客账号：多人共享，数据互通 */
  is_guest?: boolean
  created_at?: string
  settings: {
    theme?: 'light' | 'dark' | 'system'
    daily_token_quota?: number
    default_pomodoro_minutes?: number
  }
}

/** AI 联网检索后推荐的参考资料。url 已经过后端白名单校验（不会是编造的） */
export interface Resource {
  title: string
  url: string
  /** 来源域名，直接展示给用户判断可信度 */
  source: string
  kind: 'paper' | 'doc' | 'article' | 'video'
  /** 0 普通 · 1 可信 · 2 权威（一手来源） */
  authority: number
  /** 一句话说明为什么值得读 */
  why?: string
}

export const RESOURCE_KIND_LABEL: Record<string, string> = {
  paper: '论文',
  doc: '文档',
  article: '文章',
  video: '视频',
}

export interface SectionBrief {
  id: string
  idx: number
  title: string
  summary: string
  content_status: 'pending' | 'generating' | 'ready' | 'failed'
  key_concepts: string[]
  /** 学习路径图的边：本节的前置小节 id。空数组 = 可以直接开始学 */
  prerequisite_ids: string[]
  completed: boolean
  card_count: number
}

export interface ChapterBrief {
  id: string
  idx: number
  title: string
  summary: string
  sections: SectionBrief[]
}

/* ── 学习边界（取代难度等级）──
   「入门 / 进阶 / 深入」是个谁也答不准的问题：写了十年后端的人学
   Transformer 该选哪个？而且「深入」对模型也不可执行 —— 它只会多写公式。
   所以换成三个集合：哪些词可以直接用、哪些要回顾一句、哪些必须从头讲。 */
export type ConceptState = 'known' | 'shaky' | 'unknown'

export interface CalibrateConcept {
  name: string
  /** 一句话人话解释 —— 认不出名字的人会误判成「没接触」 */
  gloss: string
  /** 1=外围基础 2=直接前置 3=主题内核心 */
  depth: 1 | 2 | 3
  /** 开放校验问题，只对最深档的「熟悉」抽查 */
  probe: string
  /** 命中用户已知边界时预勾成 known —— 学过的不该再问一遍 */
  preset: '' | 'known'
}

export interface CalibrateGoal {
  kind: string
  label: string
}

export interface Boundary {
  known?: string[]
  shaky?: string[]
  unknown?: string[]
  goal?: string
  goal_kind?: string
  /** 抽查没过、被从「熟悉」降到「半懂」的概念 */
  demoted?: string[]
  calibrated_at?: string
}

export const CONCEPT_STATE_LABEL: Record<ConceptState, string> = {
  known: '熟悉',
  shaky: '听过',
  unknown: '没接触',
}

export interface Course {
  id: string
  topic: string
  title: string
  description: string
  status: 'draft' | 'outlining' | 'ready' | 'failed'
  level: 'beginner' | 'intermediate' | 'advanced'
  error: string | null
  created_at: string
  chapters: ChapterBrief[]
  stats: { sections?: number; completed?: number; cards?: number }
  resources?: Resource[]
  boundary?: Boundary
  /** 大纲没铺到的「未掌握」概念。集合约束才能这样机械校验 */
  coverage_gap?: string[]
}

export interface SectionDetail {
  id: string
  title: string
  summary: string
  content_md: string | null
  content_status: SectionBrief['content_status']
  key_concepts: string[]
  prerequisite_ids: string[]
  resources?: Resource[]
  regenerate_count: number
  completed: boolean
  chapter: { id: string; title: string; idx: number }
  course: { id: string; title: string; level: string }
  nav: {
    prev: { id: string; title: string } | null
    next: { id: string; title: string } | null
    index: number
    total: number
  }
}

export interface CardMessage {
  id: string
  seq: number
  role: 'user' | 'assistant'
  content: string
  status: 'pending' | 'done' | 'failed'
  created_at: string
}

/** cards.origin —— 套娃来源，区分「从原文划的」还是「从父卡答案里划的」 */
export type CardOrigin = 'source_text' | 'parent_answer' | 'parent_note' | 'manual'
export type CardState = 'draft' | 'vault' | 'archived'

export interface Card {
  id: string
  /** card = 划词卡；note = 一节汇流成的笔记卡（永久笔记） */
  kind?: 'card' | 'note'
  question: string
  /** 笔记卡用它存 AI 原稿快照，用户改过之后仍然保留 */
  ai_answer: string
  user_note: string
  is_rewritten: boolean
  summary: string
  concept_tags: string[]
  source_type: 'course' | 'doc' | 'brain'
  source_section_id: string | null
  source_doc_block_id: string | null
  selected_text: string
  context_text: string
  text_anchor: Record<string, unknown>
  origin: CardOrigin
  origin_message_id: string | null
  origin_offset: { start?: number; end?: number }
  canvas_x: number
  canvas_y: number
  collapsed: boolean
  pinned: boolean
  parent_card_id: string | null
  depth: number
  pomodoro_id: string | null
  state: CardState
  touch_count: number
  created_at: string
  last_touched_at: string | null
  messages?: CardMessage[]
  depth_hint?: { depth: number; message: string }
  origin_info?: { section_title?: string; course_id?: string; course_title?: string }
  due_date?: string
}

/** 只保留 real：AI 建议（potential）机制已下线 */
export type LinkKind = 'real'
export type Relation = 'continuation' | 'contrast' | 'evidence' | 'consequence' | 'tension'

export interface CardLink {
  id: string
  from_card_id: string
  to_card_id: string
  kind: LinkKind
  relation: Relation
  note: string
  created_by: 'user' | 'ai'
}

export interface Pomodoro {
  id: string
  section_id: string | null
  status: 'running' | 'completed' | 'abandoned'
  planned_minutes: number
  started_at: string
  expected_end: string
  ended_at: string | null
  server_now: string
  remaining_seconds: number
  elapsed_seconds: number
  reviewed: boolean
  card_count?: number
}

export interface CardGraphNode {
  id: string
  label: string
  depth: number
  is_rewritten: boolean
  state: CardState
  parent_card_id: string | null
  concept_tags: string[]
  touch_count: number
  created_at: string
  section_id: string | null
}

export interface Citation {
  id: string
  label: string
  selected_text: string
  is_rewritten: boolean
  created_at: string
  origin: { section_id?: string; section_title?: string; course_id?: string; course_title?: string }
}

export interface VaultOverview {
  total: number
  vaulted: number
  drafts: number
  rewritten: number
  rewrite_rate: number
  real_links: number
  by_course: { id: string; title: string; count: number }[]
  top_concepts: { name: string; count: number }[]
}

export interface Usage {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cost_usd: number
  calls: number
  cache_hits: number
  quota: number
}

export const RELATION_LABELS: Record<Relation, string> = {
  continuation: '延续',
  contrast: '对照',
  evidence: '证据',
  consequence: '结果',
  tension: '张力',
}

export const RELATION_COLORS: Record<Relation, string> = {
  continuation: 'var(--rel-continuation)',
  contrast: 'var(--rel-contrast)',
  evidence: 'var(--rel-evidence)',
  consequence: 'var(--rel-consequence)',
  tension: 'var(--rel-tension)',
}

export const LEVEL_LABELS: Record<string, string> = {
  beginner: '入门',
  intermediate: '进阶',
  advanced: '深入',
}
