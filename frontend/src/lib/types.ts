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

export interface SectionBrief {
  id: string
  idx: number
  title: string
  summary: string
  content_status: 'pending' | 'generating' | 'ready' | 'failed'
  key_concepts: string[]
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
}

export interface SectionDetail {
  id: string
  title: string
  summary: string
  content_md: string | null
  content_status: SectionBrief['content_status']
  key_concepts: string[]
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
  question: string
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

export interface ConceptNode {
  id: string
  label: string
  description: string
  section_id: string | null
  course_id: string | null
  card_count: number
  rewritten_count: number
}

export interface ConceptEdge {
  id: string
  from: string
  to: string
  relation: 'prerequisite' | 'part_of' | 'related' | 'contrast'
}

export interface OverlayData {
  nodes: ConceptNode[]
  edges: ConceptEdge[]
  attachments: Record<string, { card_id: string; is_rewritten: boolean; label: string }[]>
  blank_spots: { id: string; label: string }[]
  coverage: number
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
