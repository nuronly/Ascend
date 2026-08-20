import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, sse } from '@/lib/api'
import type { Course } from '@/lib/types'
import { LEVEL_LABELS } from '@/lib/types'
import { Badge, Button, Progress, Spinner } from '@/components/ui'
import SectionTree from '@/components/SectionTree'
import { cn } from '@/lib/utils'
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
  const [thinking, setThinking] = useState(0)
  const started = useRef(false)
  // 窄屏下路径图折叠（左右各一半在手机上没法看）
  const [treeOpen, setTreeOpen] = useState(true)

  useEffect(() => {
    if (!course || started.current) return
    if (course.status !== 'outlining' && course.chapters.length) return
    if (course.status === 'failed') return

    started.current = true
    setOutlining(true)
    setProgress([])
    setThinking(0)

    sse(`/courses/${courseId}/outline/stream`, {
      onEvent: (ev, data) => {
        if (ev === 'progress' && data?.title) {
          setProgress((p) => (p.includes(data.title) ? p : [...p, data.title]))
        }
        // 推理模型的思维链阶段：正文 JSON 还没开始吐，先让等待可见
        if (ev === 'thinking') setThinking(data?.chars ?? 0)
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
    setThinking(0)
    sse(`/courses/${courseId}/outline/stream?force=true`, {
      onEvent: (ev, data) => {
        if (ev === 'progress' && data?.title) setProgress((p) => [...p, data.title])
        if (ev === 'thinking') setThinking(data?.chars ?? 0)
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

  /** 下一步该学哪节：路径图上用蓝框标出来，给一个明确的行动指引 */
  const nextId = useMemo(() => {
    for (const ch of course?.chapters ?? []) {
      for (const s of ch.sections) if (!s.completed) return s.id
    }
    return undefined
  }, [course])

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
  const hasTree = course.chapters.length > 0

  const detail = (
    <div className={cn('w-full px-7 py-10 pb-24', hasTree ? 'max-w-[680px]' : 'max-w-[820px] mx-auto')}>
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
                {!!course.stats.cards && <Badge tone="accent">{course.stats.cards} 张卡</Badge>}
              </>
            )}
          </div>
        </div>

        {hasTree && (
          <div className="flex gap-1.5 shrink-0">
            <Button size="sm" variant="ghost" onClick={() => nav(`/graph/${courseId}`)}>
              问题图
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
            这一步用的是最强的模型，大约需要一到两分钟。它在规划章节的递进关系和小节之间的前置依赖。
          </p>
          {/* 推理模型先跑思维链再吐大纲 JSON —— 思考阶段把状态亮出来，不像断了 */}
          {thinking > 0 && progress.length === 0 && (
            <p className="flex items-center gap-1.5 text-[12px] text-[var(--text-subtle)] mt-2.5">
              <span className="size-1.5 rounded-full bg-[var(--accent)] animate-pulse shrink-0" />
              AI 正在深入思考…（已推理 {thinking.toLocaleString()} 字）
            </p>
          )}
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
      {hasTree && (
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
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )

  // 大纲还没出来时保持单列 —— 那会儿路径图是空的，分栏只会留一半空白
  if (!hasTree) return <div className="w-full">{detail}</div>

  return (
    <div className="h-full flex flex-col lg:flex-row">
      {/* ── 左：学习路径 ── */}
      <div
        className={cn(
          'shrink-0 bg-[var(--bg-sunken)] border-[var(--border)]',
          // 列表形态不需要半屏那么宽；也给个上限，免得宽屏上左栏空一大片
          'lg:w-[38%] lg:min-w-[300px] lg:max-w-[440px] lg:h-full lg:border-r lg:border-b-0',
          treeOpen ? 'h-[320px] border-b' : 'h-0 overflow-hidden',
        )}
      >
        <SectionTree
          chapters={course.chapters}
          activeId={nextId}
          onSelect={(id) => nav(`/courses/${courseId}/sections/${id}`)}
          className="size-full"
        />
      </div>

      {/* 窄屏折叠开关。桌面用不上，那里左右分栏本来就放得下 */}
      <button
        onClick={() => setTreeOpen((v) => !v)}
        className="lg:hidden shrink-0 flex items-center justify-center gap-1.5 py-1.5 text-[11.5px] text-[var(--text-muted)] border-b border-[var(--border)] bg-[var(--bg-sunken)]"
      >
        <svg
          viewBox="0 0 24 24"
          className={cn('size-3 transition-transform', treeOpen && 'rotate-180')}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
        {treeOpen ? '收起学习路径' : '展开学习路径'}
      </button>

      {/* ── 右：课程详情 ── */}
      <div className="grow min-w-0 min-h-0 overflow-y-auto">{detail}</div>
    </div>
  )
}
