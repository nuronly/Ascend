import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, sse } from '@/lib/api'
import type { Course } from '@/lib/types'
import { LEVEL_LABELS } from '@/lib/types'
import { Badge, Button, Progress, Spinner } from '@/components/ui'
import SectionTree from '@/components/SectionTree'
import RunTimeline, { ResourceList } from '@/components/RunTimeline'
import { settleStep, toolStep, type ToolStep } from '@/lib/tools'
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

  /** 哪几节已经有笔记卡 —— 课程页是回看笔记最自然的入口 */
  const { data: notes } = useQuery({
    queryKey: ['course-notes', courseId],
    queryFn: () =>
      api.get<{ notes: Record<string, { card_id: string; state: string; edited: boolean }> }>(
        `/courses/${courseId}/notes`,
      ),
    enabled: !!courseId,
  })

  /* ── 大纲流式生成（PLAN §3.1）──
     旗舰模型设计一门课要两分钟以上，同步等 = 白屏两分半。
     这里逐章推送已经定下来的标题，让等待可见、可预期。 */
  const [outlining, setOutlining] = useState(false)
  const [progress, setProgress] = useState<string[]>([])
  const [thinking, setThinking] = useState(0)
  const [thinkingText, setThinkingText] = useState('')
  const [tools, setTools] = useState<ToolStep[]>([])
  const started = useRef(false)
  // 窄屏下路径图折叠（左右各一半在手机上没法看）
  const [treeOpen, setTreeOpen] = useState(true)

  /** 首次生成与重试共用一套事件处理 —— 两份拷贝迟早会漏掉新事件 */
  const runOutline = useCallback(
    (force = false) => {
      setOutlining(true)
      setProgress([])
      setThinking(0)
      setThinkingText('')
      setTools([])

      sse(`/courses/${courseId}/outline/stream${force ? '?force=true' : ''}`, {
        onEvent: (ev, data) => {
          if (ev === 'progress' && data?.title) {
            setProgress((p) => (p.includes(data.title) ? p : [...p, data.title]))
          }
          // 推理模型的思维链阶段：正文 JSON 还没开始吐，先把它在想什么摊出来
          if (ev === 'thinking') {
            setThinking(data?.chars ?? 0)
            // 一次推理能上万字，只留尾部：DOM 不无限长，而用户看的本来也只是最新几行
            if (data?.text) setThinkingText((t) => (t + data.text).slice(-4000))
          }
          if (ev === 'tool_call') {
            setTools((t) => [...t, toolStep(data?.name ?? '', data?.detail)])
          }
          if (ev === 'tool_result' || ev === 'tool_error') {
            setTools((t) => settleStep(t, ev === 'tool_result', data))
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
    },
    [courseId, qc],
  )

  useEffect(() => {
    if (!course || started.current) return
    if (course.status !== 'outlining' && course.chapters.length) return
    if (course.status === 'failed') return
    started.current = true
    runOutline()
  }, [course, runOutline])

  const retry = () => {
    started.current = false
    runOutline(true)
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
            <Button size="sm" variant="ghost" onClick={() => nav('/notes')}>
              笔记
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

      {/* ── 大纲生成中：把每一步摆出来，不让人对着转圈傻等 ── */}
      {outlining && (
        <div className="mt-10 p-5 border border-dashed border-[var(--border-strong)] rounded-[var(--radius-lg)]">
          <div className="flex items-center gap-2 text-[13.5px] font-medium">
            <Spinner className="size-4 text-[var(--accent)]" />
            正在设计课程结构…
          </div>
          <p className="text-[12.5px] text-[var(--text-muted)] mt-1.5">
            这一步用的是最强的模型，大约需要一到两分钟。它会先联网核对这个领域的知识体系，
            再规划章节递进和小节之间的前置依赖。
          </p>
          <RunTimeline
            thinking={thinking}
            thinkingText={thinkingText}
            tools={tools}
            titles={progress}
            className="mt-4"
          />
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

      {/* ── 这门课是按什么边界定制的 ──
           把它摊出来有两个用处：让用户确认「AI 真的按我说的来了」，
           以及在他发现自己勾错时能看出问题出在哪（重生成会重新走一遍边界）。*/}
      {!outlining && !!(course.boundary?.known?.length || course.boundary?.goal) && (
        <div className="mt-9 p-4 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-sunken)]">
          <div className="text-[12.5px] font-medium">按你的边界定制</div>
          {course.boundary?.goal && (
            <div className="text-[12.5px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
              目标 · {course.boundary.goal}
            </div>
          )}
          {!!course.boundary?.known?.length && (
            <BoundaryRow label="不再讲" items={course.boundary.known} />
          )}
          {!!course.boundary?.shaky?.length && (
            <BoundaryRow label="回顾一句" items={course.boundary.shaky} />
          )}
          {!!course.boundary?.demoted?.length && (
            <div className="text-[11.5px] text-[var(--text-subtle)] mt-2 leading-relaxed">
              其中 {course.boundary.demoted.join('、')} 我会顺手带你回顾 —— 抽查的回答不太确定。
            </div>
          )}
        </div>
      )}

      {/* ── 覆盖缺口：集合约束才能这样机械校验 ── */}
      {!outlining && !!course.coverage_gap?.length && (
        <div className="mt-6 p-4 rounded-[var(--radius-lg)] border border-[color-mix(in_oklch,var(--accent)_35%,transparent)] bg-[color-mix(in_oklch,var(--accent)_6%,transparent)]">
          <div className="text-[13px] font-medium">这份大纲漏了几个你说不会的概念</div>
          <p className="text-[12.5px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
            {course.coverage_gap.join('、')} 没有对应的小节。
            要么重新生成一份，要么就这样开始 —— 遇到时可以直接划词追问。
          </p>
          <Button size="sm" variant="outline" onClick={retry} className="mt-2.5">
            重新生成大纲
          </Button>
        </div>
      )}

      {/* ── AI 检索到的参考资料 ── */}
      {!!course.resources?.length && (
        <ResourceList items={course.resources} className="mt-9" />
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
                        {notes?.notes?.[s.id] && (
                          <span
                            title={
                              notes.notes[s.id].state === 'vault'
                                ? '这一节的笔记已收进仓库'
                                : '这一节有笔记草稿，还没收进仓库'
                            }
                            className={cn(
                              'shrink-0 text-[10.5px] px-1.5 py-[1px] rounded-[4px]',
                              notes.notes[s.id].state === 'vault'
                                ? 'bg-[color-mix(in_oklch,var(--sem-ok)_14%,transparent)] text-[var(--sem-ok)]'
                                : 'bg-[var(--bg-sunken)] text-[var(--text-muted)]',
                            )}
                          >
                            笔记{notes.notes[s.id].state === 'vault' ? '' : '·草稿'}
                          </span>
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
      {/* ── 左：学习路径树 ── */}
      <div
        className={cn(
          'shrink-0 bg-[var(--bg-sunken)] border-[var(--border)]',
          // 带连线的树需要横向空间：一层挤 5~6 个节点时会到 800px 上下，
          // 放不下的部分交给容器自己横向滚动（图本来就是可以拖着看的）
          'lg:w-[46%] lg:min-w-[340px] lg:max-w-[580px] lg:h-full lg:border-r lg:border-b-0',
          treeOpen ? 'h-[340px] border-b' : 'h-0 overflow-hidden',
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

/** 边界里的一组概念。多了就折起来 —— 这块是给人扫一眼确认的，不是清单 */
function BoundaryRow({ label, items }: { label: string; items: string[] }) {
  const shown = items.slice(0, 8)
  const rest = items.length - shown.length
  return (
    <div className="flex items-baseline gap-2 mt-2 flex-wrap">
      <span className="text-[11px] text-[var(--text-subtle)] shrink-0">{label}</span>
      {shown.map((k) => (
        <span
          key={k}
          className="text-[11.5px] px-1.5 py-[1px] rounded-[4px] bg-[var(--bg-raised)] border border-[var(--border)] text-[var(--text-muted)]"
        >
          {k}
        </span>
      ))}
      {rest > 0 && <span className="text-[11px] text-[var(--text-subtle)]">+{rest}</span>}
    </div>
  )
}
