import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth, toast } from '@/lib/store'
import type { Course, VaultOverview } from '@/lib/types'
// level 已降级为「由学习边界反推」的派生值，这里只当一个粗略的深浅标签用
import { LEVEL_LABELS } from '@/lib/types'
import { Button, Empty, Input, Progress, Spinner } from '@/components/ui'
import { cn, relativeTime } from '@/lib/utils'

export default function HomePage() {
  const nav = useNavigate()
  const user = useAuth((s) => s.user)

  const [topic, setTopic] = useState('')
  const [extra, setExtra] = useState('')
  const [showExtra, setShowExtra] = useState(false)

  const { data: courses, isLoading } = useQuery({
    queryKey: ['courses'],
    queryFn: () => api.get<Course[]>('/courses'),
  })

  const { data: overview } = useQuery({
    queryKey: ['vault-overview'],
    queryFn: () => api.get<VaultOverview>('/vault/overview'),
  })

  const { data: suggestions } = useQuery({
    queryKey: ['topic-suggestions'],
    queryFn: () => api.get<{ topics: string[] }>('/courses/meta/suggestions'),
    staleTime: 10 * 60_000,
  })

  /** 先去划边界，再建课 —— 难度等级已废除，理由见 pages/Calibrate.tsx */
  const start = () => {
    const t = topic.trim()
    if (t.length < 2) {
      toast.error('主题太短了，说具体一点')
      return
    }
    const qs = new URLSearchParams({ topic: t })
    if (extra.trim()) qs.set('extra', extra.trim())
    nav(`/new?${qs}`)
  }

  return (
    <div className="max-w-[880px] w-full mx-auto px-8 py-12">
      {/* ── 开课 ── */}
      <div>
        <h1 className="text-[26px] font-semibold tracking-[-0.02em] leading-tight">
          想学点什么，{user?.name}？
        </h1>
        <p className="text-[13.5px] text-[var(--text-muted)] mt-2 leading-relaxed">
          说一个主题，我先问你几个问题弄清你的底子，再给你一份贴着你边界的大纲。
          正文按需生成 —— 点进哪一节才写哪一节。
        </p>

        <div className="mt-6">
          <div className="flex gap-2">
            <Input
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && start()}
              placeholder="比如：Transformer 注意力机制、拜占庭将军问题、宋代文官制度…"
              className="h-10 text-[14px]"
            />
            <Button variant="primary" size="md" onClick={start} className="h-10 px-5 shrink-0">
              开课
            </Button>
          </div>

          <div className="flex items-center gap-3 mt-3">
            <span className="text-[12px] text-[var(--text-subtle)]">
              下一步会让你勾一下已经会的东西，约 20 秒
            </span>
            <button
              onClick={() => setShowExtra((v) => !v)}
              className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
            >
              {showExtra ? '收起' : '补充说明'}
            </button>
          </div>

          {showExtra && (
            <Input
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="想侧重什么？有什么背景？比如「我懂线性代数但没学过概率」"
              className="mt-2.5"
            />
          )}

          {!!suggestions?.topics?.length && !topic && (
            <div className="flex flex-wrap gap-1.5 mt-4">
              {suggestions.topics.map((t) => (
                <button
                  key={t}
                  onClick={() => setTopic(t)}
                  className={cn(
                    'h-6 px-2.5 text-[12px] rounded-full',
                    'border border-[var(--border)] text-[var(--text-muted)]',
                    'hover:border-[var(--border-strong)] hover:text-[var(--text)] transition-colors',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── 认知资产概览 ──
           以笔记为口径。己见率撤了：它当初挂在卡片上，而现在「整理」发生在笔记里
           （笔记的「我的理解」那一节），再按卡片算比例既不准也没人看。 */}
      {!!(overview?.notes || overview?.total) && (
        <button
          onClick={() => nav('/notes')}
          className="mt-12 w-full grid grid-cols-2 sm:grid-cols-4 gap-px bg-[var(--border)] border border-[var(--border)] rounded-[var(--radius-lg)] overflow-hidden text-left hover:border-[var(--border-strong)] transition-colors"
        >
          {[
            { label: '笔记', value: overview?.notes ?? 0, hint: '每节学完留下的' },
            { label: '已收进', value: overview?.notes_done ?? 0, hint: '进了检索与复习' },
            { label: '疑问', value: overview?.total ?? 0, hint: '划词问过的' },
            { label: '手建关联', value: overview?.real_links ?? 0, hint: '你亲自连的线' },
          ].map((s) => (
            <div key={s.label} className="bg-[var(--bg)] px-4 py-3.5">
              <div className="text-[11px] text-[var(--text-subtle)]">{s.label}</div>
              <div className="text-[22px] font-semibold tabular-nums leading-tight mt-0.5 tracking-[-0.02em]">
                {s.value}
              </div>
              <div className="text-[10.5px] text-[var(--text-subtle)] mt-0.5">{s.hint}</div>
            </div>
          ))}
        </button>
      )}

      {/* ── 课程列表 ── */}
      <div className="mt-12">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-[14px] font-semibold">我的课程</h2>
          {!!courses?.length && (
            <span className="text-[12px] text-[var(--text-subtle)] tabular-nums">
              {courses.length} 门
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton h-[68px]" />
            ))}
          </div>
        ) : !courses?.length ? (
          <Empty
            icon={
              <svg viewBox="0 0 48 48" className="size-9" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M8 11a2 2 0 0 1 2-2h10a5 5 0 0 1 5 5v22a4 4 0 0 0-4-4H10a2 2 0 0 1-2-2V11Z" />
                <path d="M40 11a2 2 0 0 0-2-2H28a5 5 0 0 0-5 5v22a4 4 0 0 1 4-4h11a2 2 0 0 0 2-2V11Z" />
              </svg>
            }
            title="还没有课程"
            hint="在上面输入一个主题，几十秒就能得到一份结构化的大纲。"
          />
        ) : (
          <div className="space-y-2">
            {courses.map((c) => {
              const done = c.stats.completed ?? 0
              const total = c.stats.sections ?? 0
              const pct = total ? done / total : 0
              return (
                <button
                  key={c.id}
                  onClick={() => nav(`/courses/${c.id}`)}
                  className={cn(
                    'group w-full flex items-center gap-4 px-4 py-3.5 text-left',
                    'border border-[var(--border)] rounded-[var(--radius-lg)]',
                    'hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
                    'transition-colors',
                  )}
                >
                  <div className="min-w-0 grow">
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-medium truncate">{c.title || c.topic}</span>
                      {c.status === 'outlining' && (
                        <span className="flex items-center gap-1 text-[11px] text-[var(--accent)] shrink-0">
                          <Spinner className="size-3" />
                          正在设计大纲
                        </span>
                      )}
                      {c.status === 'failed' && (
                        <span className="text-[11px] text-[var(--sem-danger)] shrink-0">生成失败</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2.5 mt-1 text-[11.5px] text-[var(--text-subtle)]">
                      <span>{LEVEL_LABELS[c.level] ?? c.level}</span>
                      {total > 0 && (
                        <>
                          <span className="opacity-40">·</span>
                          <span className="tabular-nums">
                            {done}/{total} 节
                          </span>
                        </>
                      )}
                      <span className="opacity-40">·</span>
                      <span>{relativeTime(c.created_at)}</span>
                    </div>
                    {total > 0 && <Progress value={pct} className="mt-2.5 max-w-[280px]" />}
                  </div>
                  <svg
                    viewBox="0 0 24 24"
                    className="size-4 shrink-0 text-[var(--text-subtle)] opacity-0 group-hover:opacity-100 transition-opacity"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
