import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { usePomodoro, toast } from '@/lib/store'
import { useCardSpace } from '@/lib/cardSpace'
import type { Card } from '@/lib/types'
import { cn, mmss, truncate } from '@/lib/utils'
import { Button, Modal } from './ui'

/**
 * 番茄钟（PLAN §3.3）
 *
 * 不做独立小工具，只做课程结构的计量单位：
 *   · 开始一节 → 自动起番茄，时长 = 用户设置 > 25 分钟
 *   · 番茄进行中产生的卡片自动打上 pomodoro_id
 *   · 结束**不弹「休息一下」**，而是弹本颗番茄的卡片回顾 ——
 *     这是最自然的卡片整理时机
 */

export function PomodoroPill({ compact = false }: { compact?: boolean }) {
  const { active, remaining, finish, extend } = usePomodoro()
  const [menu, setMenu] = useState(false)

  if (!active) return null

  const total = active.planned_minutes * 60
  const ratio = total > 0 ? 1 - remaining / total : 1
  const overdue = remaining <= 0

  return (
    <div className="relative">
      <button
        onClick={() => setMenu((v) => !v)}
        className={cn(
          'flex items-center gap-2 h-7 pl-1.5 pr-2.5 rounded-full',
          'border transition-colors',
          overdue
            ? 'border-[color-mix(in_oklch,var(--sem-due)_50%,transparent)] bg-[color-mix(in_oklch,var(--sem-due)_12%,transparent)]'
            : 'border-[var(--border)] hover:bg-[var(--bg-hover)]',
        )}
      >
        {/* 环形进度：比进度条更省空间，也更像"一颗番茄" */}
        <svg viewBox="0 0 20 20" className="size-4 -rotate-90 shrink-0">
          <circle cx="10" cy="10" r="8" fill="none" stroke="var(--border)" strokeWidth="3" />
          <circle
            cx="10"
            cy="10"
            r="8"
            fill="none"
            stroke={overdue ? 'var(--sem-due)' : 'var(--accent)'}
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${Math.min(ratio, 1) * 50.26} 50.26`}
            className="transition-[stroke-dasharray] duration-1000 ease-linear"
          />
        </svg>
        <span
          className={cn(
            'text-[12.5px] font-medium tabular-nums',
            overdue && 'text-[var(--sem-due)]',
          )}
        >
          {overdue ? '时间到' : mmss(remaining)}
        </span>
        {!compact && !overdue && (
          <span className="text-[11px] text-[var(--text-subtle)]">专注中</span>
        )}
      </button>

      {menu && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setMenu(false)} />
          <div className="absolute right-0 top-9 z-30 w-44 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded-[var(--radius)] shadow-[var(--shadow-pop)]">
            <div className="px-3 py-1.5 text-[11px] text-[var(--text-subtle)] border-b border-[var(--border)]">
              第 {active.planned_minutes} 分钟番茄
            </div>
            {[5, 10].map((m) => (
              <button
                key={m}
                onClick={() => {
                  extend(m)
                  setMenu(false)
                }}
                className="w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-[var(--bg-hover)]"
              >
                延长 {m} 分钟
              </button>
            ))}
            <div className="my-1 h-px bg-[var(--border)]" />
            <button
              onClick={() => {
                finish(false)
                setMenu(false)
              }}
              className="w-full px-3 py-1.5 text-left text-[12.5px] hover:bg-[var(--bg-hover)]"
            >
              结束并回顾
            </button>
            <button
              onClick={() => {
                finish(true)
                setMenu(false)
                toast.info('已放弃这颗番茄')
              }}
              className="w-full px-3 py-1.5 text-left text-[12.5px] text-[var(--sem-danger)] hover:bg-[color-mix(in_oklch,var(--sem-danger)_10%,transparent)]"
            >
              放弃
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * ★ 番茄结束回顾。
 *
 * 刻意不是「休息一下」的鸡汤弹窗，而是把这颗番茄里产生的
 * draft 卡片摊开让用户勾选：哪些值得留、哪些是随口一问。
 * 不做这个筛选，灵感仓库很快就会被垃圾卡淹没（PLAN §3.2.1 状态机）。
 */
export function PomodoroReview() {
  const { finishedPrompt, active, dismissPrompt, finish } = usePomodoro()
  const [cards, setCards] = useState<Card[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [saving, setSaving] = useState(false)
  const [pomoId, setPomoId] = useState<string | null>(null)
  const reloadSpace = useCardSpace((s) => s.load)
  const sectionId = useCardSpace((s) => s.sectionId)

  useEffect(() => {
    if (!finishedPrompt || !active) return
    const id = active.id
    setPomoId(id)
    api
      .post<{ cards: Card[] }>(`/pomodoros/${id}/finish`)
      .then((r) => {
        setCards(r.cards)
        // 默认勾上写过己见的 —— 那些明显是想过的
        setPicked(new Set(r.cards.filter((c) => c.is_rewritten).map((c) => c.id)))
      })
      .catch(() => setCards([]))
  }, [finishedPrompt, active])

  const close = async () => {
    dismissPrompt()
    await finish(false).catch(() => {})
    setCards(null)
    setPicked(new Set())
  }

  const save = async () => {
    setSaving(true)
    try {
      const ids = [...picked]
      if (ids.length) {
        await api.post('/cards/bulk-state', { card_ids: ids, state: 'vault' })
      }
      const rest = (cards ?? []).filter((c) => !picked.has(c.id)).map((c) => c.id)
      if (rest.length) {
        await api.post('/cards/bulk-state', { card_ids: rest, state: 'archived' })
      }
      if (pomoId) await api.post(`/pomodoros/${pomoId}/reviewed`).catch(() => {})
      toast.ok(ids.length ? `${ids.length} 张卡已收进仓库` : '已整理完毕')
      if (sectionId) await reloadSpace(sectionId)
    } finally {
      setSaving(false)
      await close()
    }
  }

  if (!finishedPrompt) return null

  const list = cards ?? []

  return (
    <Modal
      open
      onClose={close}
      closeOnBackdrop={false}
      width="max-w-2xl"
      title="这颗番茄结束了"
      subtitle={
        list.length
          ? `你在这段时间里问了 ${list.length} 个问题。哪些值得留在仓库里？没勾的会进「未整理」，不会进图谱和第二大脑。`
          : '这颗番茄里没有产生新卡片。'
      }
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={saving}>
            稍后再说
          </Button>
          <Button variant="primary" onClick={save} loading={saving}>
            {picked.size ? `收进仓库（${picked.size}）` : '全部丢弃'}
          </Button>
        </>
      }
    >
      {cards === null ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton h-14" />
          ))}
        </div>
      ) : !list.length ? (
        <div className="py-6 text-center text-[13px] text-[var(--text-muted)]">
          休息一会儿，或者直接开始下一节。
        </div>
      ) : (
        <div className="space-y-1.5">
          {list.map((c) => {
            const on = picked.has(c.id)
            return (
              <button
                key={c.id}
                onClick={() =>
                  setPicked((s) => {
                    const n = new Set(s)
                    n.has(c.id) ? n.delete(c.id) : n.add(c.id)
                    return n
                  })
                }
                className={cn(
                  'w-full flex items-start gap-2.5 p-2.5 text-left rounded-[var(--radius)]',
                  'border transition-colors',
                  on
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                    : 'border-[var(--border)] hover:bg-[var(--bg-hover)]',
                )}
              >
                <span
                  className={cn(
                    'mt-0.5 size-4 shrink-0 rounded-[4px] border flex items-center justify-center',
                    on
                      ? 'bg-[var(--accent)] border-[var(--accent)]'
                      : 'border-[var(--border-strong)]',
                  )}
                >
                  {on && (
                    <svg viewBox="0 0 24 24" className="size-3 text-[var(--accent-text)]" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m5 12 5 5L20 7" />
                    </svg>
                  )}
                </span>
                <div className="min-w-0 grow">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13px] font-medium text-[var(--accent)] truncate">
                      ⟨{c.selected_text}⟩
                    </span>
                    {c.is_rewritten && (
                      <span
                        className="size-1.5 rounded-full bg-[var(--sem-rewritten)] shrink-0"
                        title="你写过自己的理解"
                      />
                    )}
                  </div>
                  <div className="text-[12px] text-[var(--text-muted)] mt-0.5 line-clamp-2 leading-relaxed">
                    {c.summary || c.question || truncate(c.ai_answer, 110)}
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}
    </Modal>
  )
}
