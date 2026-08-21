import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { toast } from '@/lib/store'
import {
  byConcept,
  isRight,
  nextUnanswered,
  streaks,
  tally,
  verdict,
  type ChapterTarget,
  type QuizData,
} from '@/lib/quiz'
import { Button, Empty, Modal, Spinner, Textarea } from '@/components/ui'
import { cn, relativeTime } from '@/lib/utils'

/**
 * 复习 = 选一章刷题。
 *
 * ★ 为什么从「到期卡队列」改成这个
 *   原来是 FSRS 把到期的卡一张张推给你，每张出一道简答题，你打字、等 AI 判分。
 *   一题十几秒，而且必须打字 —— 很容易在第三题就放弃。于是间隔重复最需要的
 *   东西（**持续的复习数据**）反而最稀缺。
 *   选择题即时判之后，一题两三秒、对错是客观的，同样十分钟能过十几道。
 *
 * ★ FSRS 没有消失，它退到了后台
 *   章节列表上的「N 张待复习」就是它算的（该刷哪一章），
 *   而每道能溯源到卡片的题答完都会回喂排程。
 *
 * ★ 爽感的来源是键盘节奏，不是特效
 *   数字键选 → 对了自动进下一题 → 错了停住看解析、Enter 继续。
 *   手不离键盘、不用点、不用等。动画只做四件小事（见 index.css 的 quiz-*）。
 */

type Stage = 'pick' | 'making' | 'quiz' | 'done'

/** 选对之后停留多久再自动进下一题。太快看不清对错，太慢打断节奏 */
const AUTO_NEXT_MS = 620

export default function ReviewPage() {
  const qc = useQueryClient()
  const nav = useNavigate()
  const [stage, setStage] = useState<Stage>('pick')
  const [quiz, setQuiz] = useState<QuizData | null>(null)
  const [idx, setIdx] = useState(0)
  const [reply, setReply] = useState('')
  const [grading, setGrading] = useState(false)
  const [shortFb, setShortFb] = useState<{ score: number; feedback: string } | null>(null)
  const [fx, setFx] = useState<'right' | 'wrong' | null>(null)
  const timer = useRef<number | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['review-chapters'],
    queryFn: () => api.get<{ chapters: ChapterTarget[] }>('/review/chapters'),
  })

  const items = quiz?.items ?? []
  const item = items[idx]
  const { answered, right } = useMemo(() => tally(items), [items])
  const { current: streak, best } = useMemo(() => streaks(items), [items])

  useEffect(() => () => { if (timer.current) window.clearTimeout(timer.current) }, [])

  const start = async (t: ChapterTarget) => {
    setStage('making')
    try {
      const q = await api.post<QuizData>('/review/quiz', { chapter_id: t.chapter_id })
      setQuiz(q)
      setIdx(0)
      setReply('')
      setShortFb(null)
      setStage('quiz')
    } catch (e: any) {
      toast.error(e?.message ?? '出题失败')
      setStage('pick')
    }
  }

  /** 落一题的作答。选择题已经本地判过了，这个请求只负责记账 + 喂 FSRS */
  const persist = (index: number, picked: number | null, text = '') => {
    if (!quiz) return
    void api
      .post(`/review/quiz/${quiz.id}/answer`, { index, picked, reply: text })
      .catch(() => {})
  }

  const goNext = useCallback(() => {
    setFx(null)
    setShortFb(null)
    setReply('')
    setQuiz((q) => {
      if (!q) return q
      const to = nextUnanswered(q.items, idx)
      if (to < 0) {
        setStage('done')
        void api
          .post(`/review/quiz/${q.id}/finish`, {})
          .then(() => {
            qc.invalidateQueries({ queryKey: ['review-chapters'] })
            qc.invalidateQueries({ queryKey: ['review-stats'] })
          })
          .catch(() => {})
      } else {
        setIdx(to)
      }
      return q
    })
  }, [idx, qc])

  /** 选一个选项。本地判 → 立刻反馈 → 对了自动往下 */
  const pick = useCallback(
    (opt: number) => {
      if (!quiz || !item || item.kind !== 'choice') return
      if (item.correct !== null && item.correct !== undefined) return // 已答，别重复
      const ok = isRight(item, opt)
      setQuiz((q) => {
        if (!q) return q
        const next = [...q.items]
        next[idx] = { ...next[idx], picked: opt, correct: ok }
        return { ...q, items: next }
      })
      setFx(ok ? 'right' : 'wrong')
      persist(idx, opt)
      if (ok) {
        // 答对不用看解析，直接进下一题 —— 节奏就是这么来的
        if (timer.current) window.clearTimeout(timer.current)
        timer.current = window.setTimeout(goNext, AUTO_NEXT_MS)
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [quiz, item, idx, goNext],
  )

  const submitShort = async () => {
    if (!quiz || !item || !reply.trim()) return
    setGrading(true)
    try {
      const r = await api.post<{ correct: boolean; score: number; feedback: string }>(
        `/review/quiz/${quiz.id}/answer`,
        { index: idx, reply: reply.trim() },
      )
      setQuiz((q) => {
        if (!q) return q
        const next = [...q.items]
        next[idx] = { ...next[idx], correct: r.correct }
        return { ...q, items: next }
      })
      setShortFb({ score: r.score, feedback: r.feedback })
      setFx(r.correct ? 'right' : 'wrong')
    } catch (e: any) {
      toast.error(e?.message ?? '判分失败')
    } finally {
      setGrading(false)
    }
  }

  /* ── 键盘：刷题爽感的真正来源 ── */
  useEffect(() => {
    if (stage !== 'quiz' || !item) return
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) {
        // 简答题里 ⌘/Ctrl+Enter 提交，其余交给输入框
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault()
          void submitShort()
        }
        return
      }
      const settled = item.correct !== null && item.correct !== undefined
      if (item.kind === 'choice' && !settled) {
        const n = Number(e.key)
        if (n >= 1 && n <= item.options.length) {
          e.preventDefault()
          pick(n - 1)
          return
        }
      }
      if ((e.key === 'Enter' || e.key === ' ') && settled) {
        e.preventDefault()
        if (timer.current) window.clearTimeout(timer.current)
        goNext()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, item, idx, pick, goNext])

  /* ── 选章 ── */
  if (stage === 'pick' || stage === 'making') {
    const chapters = data?.chapters ?? []
    return (
      <div className="max-w-[820px] w-full mx-auto px-8 py-10 pb-24">
        <h1 className="text-[22px] font-semibold tracking-[-0.018em]">复习</h1>
        <p className="text-[13px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
          挑一章，我按你在这一章问过什么、写过什么、哪里说过没搞懂来出题 ——
          不是照着教材随便考你。
        </p>

        {isLoading ? (
          <div className="mt-8 space-y-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-[76px] w-full rounded-[var(--radius-lg)]" />
            ))}
          </div>
        ) : !chapters.length ? (
          <Empty
            icon={
              <svg viewBox="0 0 48 48" className="size-9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                <path d="M10 12h28M10 24h28M10 36h18" />
              </svg>
            }
            title="还没有能刷的章"
            hint="先去学一节课 —— 读过的小节才有东西可考。"
          />
        ) : (
          <div className="mt-7 space-y-2.5">
            {chapters.map((t) => (
              <button
                key={t.chapter_id}
                onClick={() => start(t)}
                disabled={stage === 'making'}
                className={cn(
                  'w-full text-left px-4 py-3.5 rounded-[var(--radius-lg)] border transition-colors',
                  'border-[var(--border)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
                  'disabled:opacity-50 disabled:cursor-wait',
                )}
              >
                <div className="flex items-center gap-2.5">
                  <span className="text-[14px] font-medium truncate">{t.chapter_title}</span>
                  {/* ★ FSRS 退到后台之后的新位置：它回答「今天该刷哪一章」 */}
                  {t.due > 0 && (
                    <span className="shrink-0 px-1.5 py-[1px] rounded-full text-[10.5px] tabular-nums bg-[color-mix(in_oklch,var(--sem-due)_14%,transparent)] text-[var(--sem-due)]">
                      {t.due} 张待复习
                    </span>
                  )}
                </div>
                <div className="text-[12px] text-[var(--text-muted)] mt-1 truncate">
                  {t.course_title}
                  {t.summary ? ` · ${t.summary}` : ''}
                </div>
                <div className="flex items-center gap-3 mt-1.5 text-[11px] text-[var(--text-subtle)] tabular-nums">
                  <span>
                    已读 {t.read}/{t.sections} 节
                  </span>
                  <span>{t.cards} 张卡</span>
                  {t.last_quiz_at && <span>上次刷于 {relativeTime(t.last_quiz_at)}</span>}
                </div>
              </button>
            ))}
          </div>
        )}

        {stage === 'making' && (
          <div className="fixed inset-0 z-30 flex items-center justify-center bg-[color-mix(in_oklch,var(--bg)_78%,transparent)] backdrop-blur-sm">
            <div className="text-center">
              <Spinner className="size-6 text-[var(--accent)] mx-auto" />
              <div className="text-[13.5px] font-medium mt-3">正在为你出题…</div>
              <div className="text-[12px] text-[var(--text-muted)] mt-1.5 max-w-[300px] leading-relaxed">
                在翻你这一章问过的问题、写下的理解，和你说过还没搞懂的地方。
              </div>
            </div>
          </div>
        )}
      </div>
    )
  }

  /* ── 总结 ── */
  if (stage === 'done' && quiz) {
    const stats = byConcept(items)
    const weak = stats.filter((c) => c.right < c.total)
    const links = (quiz.summary?.links as any[]) ?? []
    return (
      <Modal
        open
        onClose={() => {
          setQuiz(null)
          setStage('pick')
        }}
        width="max-w-lg"
        title="这一轮刷完了"
        subtitle={quiz.chapter_title}
        footer={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => { setQuiz(null); setStage('pick') }}>
              换一章
            </Button>
            <Button variant="primary" size="sm" onClick={() => nav(`/courses/${quiz.course_id}`)}>
              回到这门课
            </Button>
          </div>
        }
      >
        <div className="space-y-5">
          <div className="flex items-end gap-5">
            <div>
              <div className="text-[30px] font-semibold tabular-nums tracking-[-0.02em] leading-none">
                {right}
                <span className="text-[17px] text-[var(--text-subtle)]"> / {answered}</span>
              </div>
              <div className="text-[11px] text-[var(--text-subtle)] mt-1.5">答对</div>
            </div>
            {best >= 2 && (
              <div>
                <div className="text-[22px] font-semibold tabular-nums leading-none text-[var(--sem-ok)]">
                  {best}
                </div>
                <div className="text-[11px] text-[var(--text-subtle)] mt-1.5">最长连对</div>
              </div>
            )}
            <div className="grow" />
            <p className="text-[12.5px] text-[var(--text-muted)] text-right max-w-[190px] leading-relaxed">
              {verdict(right, answered)}
            </p>
          </div>

          {/* 知识点覆盖：正确率低的排前面 */}
          {!!stats.length && (
            <div>
              <div className="text-[11px] text-[var(--text-subtle)] mb-2">考到的知识点</div>
              <div className="space-y-1.5">
                {stats.map((c) => (
                  <div key={c.concept} className="flex items-center gap-2.5">
                    <span className="text-[12.5px] truncate grow">{c.concept}</span>
                    <div className="w-[84px] h-1 rounded-full bg-[var(--bg-sunken)] overflow-hidden shrink-0">
                      <div
                        className={cn(
                          'h-full rounded-full',
                          c.right === c.total ? 'bg-[var(--sem-ok)]' : 'bg-[var(--sem-due)]',
                        )}
                        style={{ width: `${(c.right / c.total) * 100}%` }}
                      />
                    </div>
                    <span className="text-[11px] text-[var(--text-subtle)] tabular-nums shrink-0 w-8 text-right">
                      {c.right}/{c.total}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!!weak.length && (
            <div className="px-3.5 py-3 rounded-[var(--radius)] border border-[color-mix(in_oklch,var(--sem-due)_32%,transparent)] bg-[color-mix(in_oklch,var(--sem-due)_6%,transparent)]">
              <div className="text-[12.5px] font-medium text-[var(--sem-due)]">
                还薄弱的地方
              </div>
              <p className="text-[12.5px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
                {weak.map((w) => w.concept).join('、')}
                —— 这几处答错了，建议回去把对应的地方再读一遍。
              </p>
            </div>
          )}

          {/* 回去补的入口 */}
          {!!links.length && (
            <div>
              <div className="text-[11px] text-[var(--text-subtle)] mb-2">从这里回去补</div>
              <div className="space-y-1">
                {links.map((l: any) => (
                  <button
                    key={l.section_id}
                    onClick={() => nav(`/courses/${l.course_id}/sections/${l.section_id}`)}
                    className="flex items-center gap-2 w-full text-left text-[12.5px] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                  >
                    <span className="size-1 rounded-full bg-[var(--border-strong)] shrink-0" />
                    <span className="truncate">{l.title}</span>
                    {l.kind === 'note' && (
                      <span className="shrink-0 text-[10px] text-[var(--sem-rewritten)]">笔记</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {(quiz.summary?.scheduled as number) > 0 && (
            <p className="text-[11.5px] text-[var(--text-subtle)] leading-relaxed">
              其中 {quiz.summary.scheduled as number} 道能对上你的卡片，
              这次的对错已经喂给间隔重复 —— 记得牢的会推远，答错的很快会再问你一次。
            </p>
          )}
        </div>
      </Modal>
    )
  }

  /* ── 刷题 ── */
  if (!item) return null
  const settled = item.correct !== null && item.correct !== undefined

  return (
    <div className="max-w-[720px] w-full mx-auto px-8 py-10 pb-24">
      {/* 顶栏：进度 + 连击 */}
      <div className="flex items-center gap-3">
        <button
          onClick={() => { setQuiz(null); setStage('pick') }}
          className="text-[12px] text-[var(--text-subtle)] hover:text-[var(--text)] transition-colors shrink-0"
        >
          ← 换一章
        </button>
        <div className="text-[12px] text-[var(--text-muted)] truncate">{quiz?.chapter_title}</div>
        <div className="grow" />
        {streak >= 2 && (
          <span
            key={streak}
            className="streak-pop text-[12px] font-semibold tabular-nums text-[var(--sem-ok)]"
          >
            {streak} 连对
          </span>
        )}
        <span className="text-[12px] text-[var(--text-subtle)] tabular-nums shrink-0">
          {answered} / {items.length}
        </span>
      </div>

      <div className="mt-3 h-1 rounded-full bg-[var(--bg-sunken)] overflow-hidden">
        <div
          className="h-full bg-[var(--accent)] rounded-full transition-[width] duration-300 ease-out"
          style={{ width: `${(answered / Math.max(items.length, 1)) * 100}%` }}
        />
      </div>

      <div
        key={idx}
        className={cn(
          'mt-7 border border-[var(--border)] rounded-[var(--radius-lg)] overflow-hidden animate-fade-up',
          fx === 'right' && 'quiz-right',
          fx === 'wrong' && 'quiz-wrong',
        )}
      >
        <div className="px-5 py-4">
          <div className="flex items-center gap-2 text-[11px] text-[var(--text-subtle)] mb-2.5">
            <span className="tabular-nums">第 {idx + 1} 题</span>
            {item.kind === 'short' && <span>· 简答</span>}
            {!!item.concept && <span className="truncate">· {item.concept}</span>}
          </div>
          <div className="text-[15.5px] font-medium leading-[1.6]">{item.q}</div>
        </div>

        {item.kind === 'choice' ? (
          <div className="px-5 pb-5 space-y-2">
            {item.options.map((opt, i) => {
              const chosen = item.picked === i
              const isAnswer = settled && item.answer === i
              return (
                <button
                  key={i}
                  onClick={() => pick(i)}
                  disabled={settled}
                  className={cn(
                    'flex w-full items-start gap-3 px-3.5 py-2.5 text-left rounded-[var(--radius)] border transition-colors',
                    'text-[13.5px] leading-relaxed',
                    !settled && 'border-[var(--border)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
                    settled && isAnswer &&
                      'border-[color-mix(in_oklch,var(--sem-ok)_45%,transparent)] bg-[color-mix(in_oklch,var(--sem-ok)_8%,transparent)]',
                    settled && chosen && !isAnswer &&
                      'border-[color-mix(in_oklch,var(--sem-danger)_45%,transparent)] bg-[color-mix(in_oklch,var(--sem-danger)_7%,transparent)]',
                    settled && !isAnswer && !chosen && 'border-[var(--border)] opacity-45',
                  )}
                >
                  {/* 数字键提示：手不离键盘是刷题的关键 */}
                  <span
                    className={cn(
                      'shrink-0 size-5 flex items-center justify-center rounded-[5px] text-[11px] font-semibold tabular-nums mt-[1px]',
                      settled && isAnswer
                        ? 'bg-[var(--sem-ok)] text-white'
                        : settled && chosen
                          ? 'bg-[var(--sem-danger)] text-white'
                          : 'bg-[var(--bg-sunken)] text-[var(--text-subtle)]',
                    )}
                  >
                    {i + 1}
                  </span>
                  <span className="grow">{opt}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <div className="px-5 pb-5">
            {!settled ? (
              <>
                <Textarea
                  value={reply}
                  onChange={(e) => setReply(e.target.value)}
                  rows={4}
                  placeholder="凭记忆答，说出你记得的部分就行。"
                  autoFocus
                />
                <div className="flex items-center gap-2 mt-3">
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={submitShort}
                    loading={grading}
                    disabled={!reply.trim()}
                  >
                    提交
                  </Button>
                  <span className="text-[11px] text-[var(--text-subtle)]">⌘/Ctrl + Enter</span>
                </div>
              </>
            ) : (
              <div className="text-[13px] leading-relaxed whitespace-pre-wrap text-[var(--text-muted)] border-l-2 border-[var(--border-strong)] pl-3">
                {reply}
              </div>
            )}
          </div>
        )}

        {/* 判完之后：正确答案 + 解析 + 为什么出这道题 */}
        {settled && (
          <div className="px-5 py-4 border-t border-[var(--border)] bg-[var(--bg-sunken)] animate-fade-up">
            <div
              className={cn(
                'text-[13px] font-semibold',
                item.correct ? 'text-[var(--sem-ok)]' : 'text-[var(--sem-danger)]',
              )}
            >
              {item.correct ? '对了' : '错了'}
              {shortFb && (
                <span className="ml-2 text-[12px] font-normal text-[var(--text-muted)] tabular-nums">
                  {Math.round(shortFb.score * 100)} 分
                </span>
              )}
            </div>

            {item.kind === 'short' && (
              <div className="mt-2 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
                {shortFb?.feedback}
              </div>
            )}
            {item.kind === 'choice' && !!item.explain && (
              <div className="mt-2 text-[12.5px] leading-relaxed text-[var(--text-muted)]">
                {item.explain}
              </div>
            )}

            {/* ★ 「为什么出这道题」放在答完之后 —— 提前给会泄题，
                   而答完再看到「因为你当时问过这个」很有分量 */}
            {!!item.why && (
              <div className="mt-2.5 text-[11.5px] text-[var(--text-subtle)] leading-relaxed">
                出这道题是因为：{item.why}
              </div>
            )}

            <Button variant="primary" size="sm" onClick={goNext} className="mt-3.5">
              {nextUnanswered(items, idx) < 0 ? '看总结' : '下一题'}
              <span className="ml-1.5 opacity-60">Enter</span>
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}
