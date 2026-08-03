import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, sse } from '@/lib/api'
import type { Course } from '@/lib/types'
import { LEVEL_LABELS } from '@/lib/types'
import { Badge, Button, Progress, Spinner } from '@/components/ui'
import { cn, humanMinutes } from '@/lib/utils'
import { toast } from '@/lib/store'

export default function CoursePage() {
  const { courseId = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()

  const { data: course, isLoading } = useQuery({
    queryKey: ['course', courseId],
    queryFn: () => api.get<Course>(`/courses/${courseId}`),
  })

  /* ── 大纲流式生成（PLAN §3.1）──
     旗舰模型设计一门课要两分钟以上，同步等 = 白屏两分半。
     这里逐章推送已经定下来的标题，让等待可见、可预期。 */
  const [outlining, setOutlining] = useState(false)
  const [progress, setProgress] = useState<string[]>([])
  const started = useRef(false)

  useEffect(() => {
    if (!course || started.current) return
    if (course.status !== 'outlining' && course.chapters.length) return
    if (course.status === 'failed') return

    started.current = true
    setOutlining(true)
    setProgress([])

    sse(`/courses/${courseId}/outline/stream`, {
      onEvent: (ev, data) => {
        if (ev === 'progress' && data?.title) {
          setProgress((p) => (p.includes(data.title) ? p : [...p, data.title]))
        }
      },
      onDone: () => {
        setOutlining(false)
        qc.invalidateQueries({ queryKey: ['course', courseId] })
        qc.invalidateQueries({ queryKey: ['courses'] })
      },
      onError: (m) => {
        setOutlining(false)
        toast.error(m)
        qc.invalidateQueries({ queryKey: ['course', courseId] })
      },
    }).catch(() => setOutlining(false))
  }, [course, courseId, qc])

  const retry = () => {
    started.current = false
    setOutlining(true)
    setProgress([])
    sse(`/courses/${courseId}/outline/stream?force=true`, {
      onEvent: (ev, data) => {
        if (ev === 'progress' && data?.title) setProgress((p) => [...p, data.title])
      },
      onDone: () => {
        setOutlining(false)
        qc.invalidateQueries({ queryKey: ['course', courseId] })
      },
      onError: (m) => {
        setOutlining(false)
        toast.error(m)
      },
    }).catch(() => setOutlining(false))
  }

  const remove = async () => {
    if (!confirm('删除这门课？所有小节正文会一并删除（卡片会保留在仓库里）。')) return
    await api.del(`/courses/${courseId}`)
    qc.invalidateQueries({ queryKey: ['courses'] })
    nav('/')
  }

  if (isLoading) {
    return (
      <div className="max-w-[820px] w-full mx-auto px-8 py-12 space-y-3">
        <div className="skeleton h-8 w-2/3" />
        <div className="skeleton h-4 w-full" />
        <div className="skeleton h-40 w-full mt-8" />
      </div>
    )
  }
  if (!course) return null

  const done = course.stats.completed ?? 0
  const total = course.stats.sections ?? 0

  return (
    <div className="max-w-[820px] w-full mx-auto px-8 py-12 pb-24">
      <button
        onClick={() => nav('/')}
        className="flex items-center gap-1 text-[12.5px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors mb-6"
      >
        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
        全部课程
      </button>

      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-[27px] font-semibold tracking-[-0.022em] leading-[1.25]">
            {course.title || course.topic}
          </h1>
          {course.description && (
            <p className="text-[14px] text-[var(--text-muted)] leading-[1.7] mt-3 max-w-[64ch]">
              {course.description}
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 mt-4">
            <Badge>{LEVEL_LABELS[course.level] ?? course.level}</Badge>
            {total > 0 && (
              <>
                <Badge>{total} 节</Badge>
                <Badge>{humanMinutes(course.stats.est_minutes ?? 0)}</Badge>
                {!!course.stats.cards && <Badge tone="accent">{course.stats.cards} 张卡</Badge>}
              </>
            )}
          </div>
        </div>

        {course.chapters.length > 0 && (
          <div className="flex gap-1.5 shrink-0">
            <Button size="sm" variant="ghost" onClick={() => nav(`/graph/${courseId}`)}>
              图谱
            </Button>
            <Button size="sm" variant="ghost" onClick={remove}>
              删除
            </Button>
          </div>
        )}
      </div>

      {total > 0 && (
        <div className="mt-6 flex items-center gap-3">
          <Progress value={total ? done / total : 0} className="grow max-w-[320px]" />
          <span className="text-[12px] text-[var(--text-subtle)] tabular-nums">
            {done}/{total}
          </span>
        </div>
      )}

      {/* ── 大纲生成中 ── */}
      {outlining && (
        <div className="mt-10 p-5 border border-dashed border-[var(--border-strong)] rounded-[var(--radius-lg)]">
          <div className="flex items-center gap-2 text-[13.5px] font-medium">
            <Spinner className="size-4 text-[var(--accent)]" />
            正在设计课程结构…
          </div>
          <p className="text-[12.5px] text-[var(--text-muted)] mt-1.5">
            这一步用的是最强的模型，大约需要一到两分钟。它在规划章节之间的递进关系。
          </p>
          {progress.length > 0 && (
            <div className="mt-4 space-y-1 max-h-[280px] overflow-y-auto">
              {progress.map((t, i) => (
                <div
                  key={`${t}-${i}`}
                  className="flex items-center gap-2 text-[12.5px] text-[var(--text-muted)] animate-fade-up"
                >
                  <span className="size-1 rounded-full bg-[var(--accent)] shrink-0" />
                  <span className="truncate">{t}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── 失败 ── */}
      {!outlining && course.status === 'failed' && (
        <div className="mt-10 p-5 border border-[color-mix(in_oklch,var(--sem-danger)_35%,transparent)] rounded-[var(--radius-lg)] bg-[color-mix(in_oklch,var(--sem-danger)_6%,transparent)]">
          <div className="text-[13.5px] font-medium text-[var(--sem-danger)]">大纲生成失败</div>
          <p className="text-[12.5px] text-[var(--text-muted)] mt-1.5 leading-relaxed break-words">
            {course.error || '模型没有返回可用的结构。'}
          </p>
          <Button size="sm" variant="outline" onClick={retry} className="mt-3">
            重新生成
          </Button>
        </div>
      )}

      {/* ── 章节列表 ── */}
      {course.chapters.length > 0 && (
        <div className="mt-10 space-y-8">
          {course.chapters.map((ch) => (
            <section key={ch.id}>
              <div className="flex items-baseline gap-2.5">
                <span className="font-mono text-[12px] text-[var(--text-subtle)] tabular-nums shrink-0">
                  {String(ch.idx + 1).padStart(2, '0')}
                </span>
                <h2 className="text-[16px] font-semibold tracking-[-0.012em]">{ch.title}</h2>
              </div>
              {ch.summary && (
                <p className="text-[12.5px] text-[var(--text-muted)] mt-1 ml-[30px] leading-relaxed">
                  {ch.summary}
                </p>
              )}

              <div className="mt-3 ml-[30px] border-l border-[var(--border)]">
                {ch.sections.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => nav(`/courses/${courseId}/sections/${s.id}`)}
                    className={cn(
                      'group relative w-full flex items-start gap-3 py-2.5 pl-4 pr-3 text-left',
                      'hover:bg-[var(--bg-hover)] transition-colors',
                    )}
                  >
                    {/* 完成状态标记：实心 = 学过 */}
                    <span
                      className={cn(
                        'absolute left-0 top-[15px] -translate-x-1/2 size-[7px] rounded-full border-2 border-[var(--bg)]',
                        s.completed
                          ? 'bg-[var(--sem-ok)]'
                          : s.content_status === 'ready'
                            ? 'bg-[var(--border-strong)]'
                            : 'bg-[var(--border)]',
                      )}
                    />
                    <div className="min-w-0 grow">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span
                          className={cn(
                            'text-[13.5px]',
                            s.completed ? 'text-[var(--text-muted)]' : 'font-medium',
                          )}
                        >
                          {ch.idx + 1}.{s.idx + 1} {s.title}
                        </span>
                        {s.card_count > 0 && (
                          <Badge tone="accent" className="shrink-0">
                            {s.card_count} 卡
                          </Badge>
                        )}
                      </div>
                      {s.summary && (
                        <div className="text-[12px] text-[var(--text-subtle)] mt-0.5 leading-relaxed line-clamp-2">
                          {s.summary}
                        </div>
                      )}
                    </div>
                    <span className="text-[11.5px] text-[var(--text-subtle)] tabular-nums shrink-0 mt-0.5">
                      {s.est_minutes}′
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}
