import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { toast } from '@/lib/store'
import type { Card } from '@/lib/types'
import { Markdown } from '@/components/Markdown'
import { Badge, Button, Empty, Spinner, Textarea } from '@/components/ui'
import { cn, futureTime, relativeTime } from '@/lib/utils'

/**
 * FSRS 主动复习（PLAN §3.6）
 *
 * 关键：**复习不是弹原文，而是用卡片生成一道问题让用户回答，
 * AI 判分 → 反馈给 FSRS。**
 * 这一步让第二大脑从"被动问答"变成"主动教练"，投入产出比极高。
 */

type Phase = 'idle' | 'loading-q' | 'answering' | 'grading' | 'graded'

interface Graded {
  score: number
  rating: number
  feedback: string
  next_due: string
  interval_days: number
}

const RATING_LABEL: Record<number, string> = {
  1: '完全没答上来',
  2: '有点吃力',
  3: '答得不错',
  4: '轻松准确',
}

export default function ReviewPage() {
  const qc = useQueryClient()
  const [idx, setIdx] = useState(0)
  const [phase, setPhase] = useState<Phase>('idle')
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState('')
  const [graded, setGraded] = useState<Graded | null>(null)
  const [reveal, setReveal] = useState(false)

  const { data: stats } = useQuery({
    queryKey: ['review-stats'],
    queryFn: () => api.get<{ scheduled: number; vaulted: number; due: number; reviews: number; avg_score: number | null }>('/review/stats'),
  })

  const { data: dueData, isLoading } = useQuery({
    queryKey: ['review-due'],
    queryFn: () => api.get<{ count: number; cards: Card[] }>('/review/due?limit=20'),
  })

  const cards = dueData?.cards ?? []
  const card = cards[idx]

  // 进入下一张卡时自动出题
  useEffect(() => {
    if (!card || phase !== 'idle') return
    setPhase('loading-q')
    setQuestion('')
    setAnswer('')
    setGraded(null)
    setReveal(false)
    api
      .post<{ question: string }>(`/review/question?card_id=${card.id}`)
      .then((r) => {
        setQuestion(r.question)
        setPhase('answering')
      })
      .catch(() => {
        setQuestion(card.question || `用你自己的话解释一下「${card.selected_text}」。`)
        setPhase('answering')
      })
  }, [card, phase])

  const submit = async () => {
    if (!card || !answer.trim()) return
    setPhase('grading')
    try {
      const g = await api.post<Graded>('/review/answer', {
        card_id: card.id,
        question,
        answer: answer.trim(),
      })
      setGraded(g)
      setReveal(true)
      setPhase('graded')
    } catch (e: any) {
      toast.error(e?.message ?? '判分失败')
      setPhase('answering')
    }
  }

  const selfRate = async (rating: number) => {
    if (!card) return
    setPhase('grading')
    try {
      const g = await api.post<Graded>('/review/rate', { card_id: card.id, rating })
      setGraded({ ...g, score: rating / 4, rating, feedback: '' })
      setReveal(true)
      setPhase('graded')
    } catch (e: any) {
      toast.error(e?.message ?? '提交失败')
      setPhase('answering')
    }
  }

  const next = () => {
    if (idx + 1 >= cards.length) {
      qc.invalidateQueries({ queryKey: ['review-due'] })
      qc.invalidateQueries({ queryKey: ['review-stats'] })
      setIdx(0)
    } else {
      setIdx((i) => i + 1)
    }
    setPhase('idle')
  }

  if (isLoading) {
    return (
      <div className="max-w-[720px] mx-auto px-8 py-12">
        <div className="skeleton h-6 w-40" />
        <div className="skeleton h-32 w-full mt-8" />
      </div>
    )
  }

  return (
    <div className="max-w-[720px] w-full mx-auto px-8 py-10 pb-24">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.018em]">复习</h1>
          <p className="text-[13px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
            不是把原文再给你看一遍 —— 而是出一道题，检验你是不是真的记住了。
          </p>
        </div>
        {!!stats && (
          <div className="flex gap-5 shrink-0 text-right">
            {[
              { label: '待复习', v: stats.due, accent: stats.due > 0 },
              { label: '已排程', v: stats.scheduled },
              { label: '复习次数', v: stats.reviews },
            ].map((s) => (
              <div key={s.label}>
                <div className="text-[11px] text-[var(--text-subtle)]">{s.label}</div>
                <div
                  className={cn(
                    'text-[19px] font-semibold tabular-nums tracking-[-0.02em]',
                    s.accent && 'text-[var(--sem-due)]',
                  )}
                >
                  {s.v}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {!cards.length ? (
        <Empty
          icon={
            <svg viewBox="0 0 48 48" className="size-9" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="24" cy="24" r="17" />
              <path d="m16 24 6 6 11-12" />
            </svg>
          }
          title="今天没有要复习的卡"
          hint={
            stats?.scheduled
              ? `${stats.scheduled} 张卡都在排程里，到期时会自动出现在这里。间隔重复的意义就在于——不到时候不打扰你。`
              : '把卡片收进仓库后，它们会自动进入复习排程。'
          }
        />
      ) : (
        <div className="mt-8">
          {/* 进度 */}
          <div className="flex items-center gap-2 mb-5">
            {cards.map((_, i) => (
              <span
                key={i}
                className={cn(
                  'h-1 grow rounded-full transition-colors',
                  i < idx
                    ? 'bg-[var(--sem-ok)]'
                    : i === idx
                      ? 'bg-[var(--accent)]'
                      : 'bg-[var(--bg-sunken)]',
                )}
              />
            ))}
            <span className="text-[11.5px] text-[var(--text-subtle)] tabular-nums shrink-0 ml-1">
              {idx + 1}/{cards.length}
            </span>
          </div>

          {card && (
            <div className="border border-[var(--border)] rounded-[var(--radius-lg)] overflow-hidden">
              {/* 题目 */}
              <div className="px-5 py-4 bg-[var(--bg-sunken)] border-b border-[var(--border)]">
                <div className="flex items-center gap-2 mb-2.5">
                  <span className="font-mono text-[10px] text-[var(--text-subtle)]">
                    {card.luhmann_id}
                  </span>
                  <Badge tone="due">
                    {card.due_date ? `到期 ${relativeTime(card.due_date)}` : '待复习'}
                  </Badge>
                  {card.is_rewritten && <Badge tone="rewritten">己见卡</Badge>}
                  <div className="grow" />
                  <span className="text-[11px] text-[var(--text-subtle)]">
                    {card.origin_info?.course_title ?? ''}
                  </span>
                </div>

                {phase === 'loading-q' ? (
                  <div className="flex items-center gap-2 text-[13px] text-[var(--text-muted)] py-1">
                    <Spinner className="size-3.5 text-[var(--accent)]" />
                    正在出题…
                  </div>
                ) : (
                  <div className="text-[15px] font-medium leading-[1.6]">{question}</div>
                )}
              </div>

              {/* 作答 */}
              <div className="p-5">
                {!reveal ? (
                  <>
                    <Textarea
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
                      }}
                      rows={5}
                      placeholder="凭记忆回答，不要翻看原卡。答不上来也没关系，说出你记得的部分。"
                      disabled={phase !== 'answering'}
                      autoFocus
                    />
                    <div className="flex items-center gap-2 mt-3">
                      <Button
                        variant="primary"
                        size="sm"
                        onClick={submit}
                        loading={phase === 'grading'}
                        disabled={!answer.trim() || phase !== 'answering'}
                      >
                        提交作答
                      </Button>
                      <span className="text-[11px] text-[var(--text-subtle)]">⌘/Ctrl + Enter</span>
                      <div className="grow" />
                      <span className="text-[11px] text-[var(--text-subtle)]">或直接自评：</span>
                      {[1, 2, 3, 4].map((r) => (
                        <button
                          key={r}
                          onClick={() => selfRate(r)}
                          disabled={phase !== 'answering'}
                          title={RATING_LABEL[r]}
                          className="size-6 text-[11.5px] font-medium rounded-[var(--radius-sm)] border border-[var(--border)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] disabled:opacity-40 transition-colors tabular-nums"
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                  </>
                ) : (
                  <div className="space-y-5">
                    {graded && (
                      <div
                        className={cn(
                          'px-4 py-3 rounded-[var(--radius)] border',
                          graded.rating >= 3
                            ? 'border-[color-mix(in_oklch,var(--sem-ok)_35%,transparent)] bg-[color-mix(in_oklch,var(--sem-ok)_7%,transparent)]'
                            : 'border-[color-mix(in_oklch,var(--sem-due)_35%,transparent)] bg-[color-mix(in_oklch,var(--sem-due)_7%,transparent)]',
                        )}
                      >
                        <div className="flex items-center gap-2.5">
                          <span
                            className={cn(
                              'text-[13.5px] font-semibold',
                              graded.rating >= 3
                                ? 'text-[var(--sem-ok)]'
                                : 'text-[var(--sem-due)]',
                            )}
                          >
                            {RATING_LABEL[graded.rating]}
                          </span>
                          <span className="text-[12px] text-[var(--text-muted)] tabular-nums">
                            {Math.round(graded.score * 100)} 分
                          </span>
                          <div className="grow" />
                          <span className="text-[11.5px] text-[var(--text-subtle)]">
                            下次复习：{futureTime(graded.next_due)}
                          </span>
                        </div>
                        {graded.feedback && (
                          <p className="text-[12.5px] leading-relaxed text-[var(--text-muted)] mt-2">
                            {graded.feedback}
                          </p>
                        )}
                      </div>
                    )}

                    {answer.trim() && (
                      <div>
                        <div className="text-[11px] text-[var(--text-subtle)] mb-1.5">你的回答</div>
                        <div className="text-[13px] leading-relaxed whitespace-pre-wrap text-[var(--text-muted)] border-l-2 border-[var(--border-strong)] pl-3">
                          {answer}
                        </div>
                      </div>
                    )}

                    <div>
                      <div className="text-[11px] text-[var(--text-subtle)] mb-1.5">
                        原卡 · ⟨{card.selected_text}⟩
                      </div>
                      <Markdown variant="card">{card.ai_answer}</Markdown>
                      {card.user_note && (
                        <div className="mt-3 border-l-2 border-[var(--sem-rewritten)] pl-3 py-1 text-[12.5px] leading-relaxed whitespace-pre-wrap bg-[color-mix(in_oklch,var(--sem-rewritten)_6%,transparent)] rounded-r-[var(--radius-sm)]">
                          {card.user_note}
                        </div>
                      )}
                    </div>

                    <Button variant="primary" size="md" onClick={next} className="w-full">
                      {idx + 1 >= cards.length ? '完成这一轮' : '下一张'}
                    </Button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
