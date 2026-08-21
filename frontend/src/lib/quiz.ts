/**
 * 刷题的纯逻辑：判对错、连击、总结聚合。
 *
 * 抽出来是因为这几件事**必须能单测**：
 *   · 选择题在前端本地判 —— 判错了不会报错，只会让所有人答错
 *   · 连击是爽感的核心，断连的时机错了体感立刻不对
 *   · 「哪里还薄弱」是按知识点聚合的，聚错了总结页就在胡说
 */

export type QuizKind = 'choice' | 'short'

export interface QuizItem {
  index: number
  kind: QuizKind
  q: string
  options: string[]
  concept: string
  /** 为什么出这道题（他问过 / 他写的理解有偏差 / 快忘了…）—— 答完才给他看 */
  why: string
  /** 选择题的正确下标。随题下发，所以本地就能判 */
  answer?: number
  explain?: string
  picked?: number | null
  correct?: boolean | null
}

export interface QuizData {
  id: string
  chapter_id: string
  chapter_title: string
  course_id: string | null
  course_title: string
  items: QuizItem[]
  summary: Record<string, unknown>
}

export interface ChapterTarget {
  chapter_id: string
  chapter_title: string
  summary: string
  course_id: string
  course_title: string
  sections: number
  read: number
  cards: number
  due: number
  last_quiz_at: string | null
  /**
   * 这一章还有没刷完的题。
   * 出一套题要几十秒，人随时会被打断 —— 走开之后不该让那套题白丢。
   */
  pending: { id: string; answered: number; total: number } | null
}

/**
 * 选择题判对错。
 *
 * ⚠️ `answer` 可能是 undefined（简答题，或者后端没下发答案）。
 *    这时**绝不能**当成答对 —— 那会让 FSRS 收到一串假的「记住了」，
 *    间隔被不当拉长，而且完全看不出来。
 */
export function isRight(item: QuizItem, picked: number): boolean {
  return typeof item.answer === 'number' && item.answer === picked
}

/** 已答的题数与对的题数。 */
export function tally(items: QuizItem[]): { answered: number; right: number } {
  let answered = 0
  let right = 0
  for (const it of items) {
    if (it.correct === null || it.correct === undefined) continue
    answered += 1
    if (it.correct) right += 1
  }
  return { answered, right }
}

/**
 * 当前连击与历史最佳。
 *
 * ★ 连击只看**已答的题**，跳过没答的 —— 中途离开再回来接着刷，
 *   不该因为中间有空题就把连击清零。
 */
export function streaks(items: QuizItem[]): { current: number; best: number } {
  let current = 0
  let best = 0
  for (const it of items) {
    if (it.correct === true) {
      current += 1
      best = Math.max(best, current)
    } else if (it.correct === false) {
      current = 0
    }
  }
  return { current, best }
}

export interface ConceptStat {
  concept: string
  total: number
  right: number
}

/**
 * 按知识点聚合。
 *
 * ★ 总结页的价值就在这一步：列一遍错题是重复劳动（用户刚看过），
 *   而「你在缩放点积上错了两道」才是可行动的结论。
 *   排序把正确率低的放前面 —— 那是他该回去补的地方。
 */
export function byConcept(items: QuizItem[]): ConceptStat[] {
  const map = new Map<string, ConceptStat>()
  for (const it of items) {
    if (it.correct === null || it.correct === undefined) continue
    const key = (it.concept || '其它').trim() || '其它'
    const slot = map.get(key) ?? { concept: key, total: 0, right: 0 }
    slot.total += 1
    if (it.correct) slot.right += 1
    map.set(key, slot)
  }
  return [...map.values()].sort(
    (a, b) => a.right / a.total - b.right / b.total || b.total - a.total,
  )
}

/** 一句话评价这一轮。分档刻意粗 —— 精确的百分比在上面已经有了。 */
export function verdict(right: number, total: number): string {
  if (!total) return '还没开始'
  const r = right / total
  if (r === 1) return '全对，这一章你是真的过关了'
  if (r >= 0.8) return '掌握得不错，只有零星几处要补'
  if (r >= 0.6) return '主干是通的，细节还得再走一遍'
  if (r >= 0.4) return '有印象但不牢，建议回去重读一遍再来'
  return '这一章基本还没沉下来，别急着往后学'
}

/**
 * 下一道该跳到哪。
 *
 * 优先往后找没答的；后面没有了再从头找 —— 支持「跳过某题、最后回来补」。
 * 返回 -1 表示全答完了。
 */
export function nextUnanswered(items: QuizItem[], from: number): number {
  const unanswered = (i: QuizItem) => i.correct === null || i.correct === undefined
  for (let i = from + 1; i < items.length; i++) if (unanswered(items[i])) return i
  for (let i = 0; i <= from && i < items.length; i++) if (unanswered(items[i])) return i
  return -1
}
