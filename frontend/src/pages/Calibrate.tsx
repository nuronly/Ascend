import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { toast } from '@/lib/store'
import type { CalibrateConcept, CalibrateGoal, ConceptState, Course } from '@/lib/types'
import { Button, Input, Spinner, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'

/**
 * ★ 开课前的边界校准 —— 取代「入门 / 进阶 / 深入」
 *
 * 那三个选项是抽象且无法作答的：写了十年后端的人学 Transformer 算入门吗？
 * 他对梯度和矩阵乘法的底子远超刚学完线代的学生，却对注意力一无所知。
 * 「等级」丢掉的信息正是**已知边界的形状**，而那是唯一可执行的东西。
 * 对模型也一样：「深入」它只能理解成多写公式多写术语。
 *
 * 所以这一页做三件事，而且刻意**不做成考试**：
 *
 *   1. 三态勾选（熟悉 / 听过 / 没接触）—— 一屏 20 秒，零挫败。
 *      自评「我知道这个词」其实比答对一道题更可靠地表示「可以直接引用它」。
 *   2. 定学习目标 —— 它决定课程的**上界**。「能读懂论文公式」和
 *      「能自己写一个实现」应该是两份完全不同的大纲。
 *   3. 顺手抽查一两个最深的「熟悉」—— 只防自评虚高，可跳过，
 *      而且只会让课程多铺垫一句，不会说你答错了。
 *
 * 铁律：**永远给「直接开始」的出口**。点「开课」的那一秒是这个产品最珍贵的
 * 资源，任何东西都不许挡在它前面 —— 校准失败、模型超时、用户没耐心，
 * 一律能一键跳过，退化成旧行为。
 */

const STATES: { value: ConceptState; label: string; hint: string }[] = [
  { value: 'known', label: '熟悉', hint: '能直接用，不用再讲' },
  { value: 'shaky', label: '听过', hint: '有印象，回顾一句就行' },
  { value: 'unknown', label: '没接触', hint: '要从头讲清楚' },
]

const DEPTH_TITLE: Record<number, { title: string; hint: string }> = {
  1: { title: '外围基础', hint: '学这个主题需要的通识底子' },
  2: { title: '直接前置', hint: '不先懂它就看不懂核心机制' },
  3: { title: '主题内核心', hint: '这门课本身要教的东西' },
}

export default function CalibratePage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const topic = (params.get('topic') ?? '').trim()
  const extra = (params.get('extra') ?? '').trim()

  const [concepts, setConcepts] = useState<CalibrateConcept[]>([])
  const [goals, setGoals] = useState<CalibrateGoal[]>([])
  const [loading, setLoading] = useState(true)
  const [degraded, setDegraded] = useState(false)

  const [states, setStates] = useState<Record<string, ConceptState>>({})
  const [goalKind, setGoalKind] = useState('')
  const [goalText, setGoalText] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})

  useEffect(() => {
    if (!topic) {
      nav('/', { replace: true })
      return
    }
    let alive = true
    api
      .post<{ concepts: CalibrateConcept[]; goals: CalibrateGoal[]; degraded?: boolean }>(
        '/courses/calibrate',
        { topic, extra },
      )
      .then((d) => {
        if (!alive) return
        setConcepts(d.concepts ?? [])
        setGoals(d.goals ?? [])
        setDegraded(!!d.degraded)
        // 默认「没接触」：让用户只勾自己会的那几个，而不是逐条否认。
        // 保守方向也对 —— 多铺垫最多啰嗦，少铺垫他直接看不懂
        const init: Record<string, ConceptState> = {}
        for (const c of d.concepts ?? []) init[c.name] = c.preset === 'known' ? 'known' : 'unknown'
        setStates(init)
        setGoalKind(d.goals?.[0]?.kind ?? '')
      })
      .catch(() => alive && setDegraded(true))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, extra])

  /** 抽查只挑最深档里自评「熟悉」的两个：虚高只发生在天花板附近 */
  const probes = useMemo(
    () =>
      concepts
        .filter((c) => states[c.name] === 'known' && c.probe)
        .sort((a, b) => b.depth - a.depth)
        .slice(0, 2),
    [concepts, states],
  )

  const preset = useMemo(() => concepts.filter((c) => c.preset === 'known'), [concepts])

  /** 最深档全勾「熟悉」= 这门课对他太浅，得当场说出来而不是硬生成 */
  const tooShallow = useMemo(() => {
    const deep = concepts.filter((c) => c.depth === 3)
    return deep.length >= 3 && deep.every((c) => states[c.name] === 'known')
  }, [concepts, states])

  const counts = useMemo(() => {
    const c = { known: 0, shaky: 0, unknown: 0 }
    for (const v of Object.values(states)) c[v] += 1
    return c
  }, [states])

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.post<Course>('/courses', body),
    onSuccess: (c) => {
      qc.invalidateQueries({ queryKey: ['courses'] })
      nav(`/courses/${c.id}`, { replace: true })
    },
    onError: (e: any) => toast.error(e?.message ?? '建课失败'),
  })

  const goal = goalText.trim() || goals.find((g) => g.kind === goalKind)?.label || ''

  const start = () => {
    create.mutate({
      topic,
      extra,
      calibration: {
        concepts: concepts.map((c) => ({ name: c.name, state: states[c.name] ?? 'unknown' })),
        goal,
        goal_kind: goalText.trim() ? 'custom' : goalKind,
        probes: probes
          .filter((p) => (answers[p.name] ?? '').trim())
          .map((p) => ({ concept: p.name, question: p.probe, answer: answers[p.name].trim() })),
      },
    })
  }

  /** 出口：不校准直接开课，退化成旧行为 */
  const skip = () => create.mutate({ topic, extra })

  const grouped = [1, 2, 3]
    .map((d) => ({ depth: d, items: concepts.filter((c) => c.depth === d) }))
    .filter((g) => g.items.length > 0)

  return (
    <div className="max-w-[760px] w-full mx-auto px-8 py-12 pb-32">
      <button
        onClick={() => nav('/')}
        className="flex items-center gap-1 text-[12.5px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors mb-6"
      >
        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
        换个主题
      </button>

      <h1 className="text-[24px] font-semibold tracking-[-0.02em] leading-[1.3]">
        开始之前，先划一下你的边界
      </h1>
      <p className="text-[13.5px] text-[var(--text-muted)] mt-2.5 leading-[1.75]">
        我不问你是入门还是进阶 —— 那个问题谁也答不准。
        只要勾出下面这些你已经熟悉的东西，我就知道该从哪句话讲起、
        哪些必须先铺垫。<span className="text-[var(--text-subtle)]">大约 20 秒。</span>
      </p>

      {loading ? (
        <div className="mt-9 space-y-3">
          <div className="flex items-center gap-2 text-[13px] text-[var(--text-muted)] mb-5">
            <Spinner className="size-3.5 text-[var(--accent)]" />
            正在整理「{topic}」的概念地图…
          </div>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div key={i} className="skeleton h-[52px]" />
          ))}
        </div>
      ) : degraded || !concepts.length ? (
        <div className="mt-9 p-5 border border-dashed border-[var(--border-strong)] rounded-[var(--radius-lg)]">
          <div className="text-[13.5px] font-medium">这次没能生成概念地图</div>
          <p className="text-[12.5px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
            不影响开课 —— 直接开始，我会按通用的递进顺序来讲。
          </p>
          <Button variant="primary" size="sm" onClick={skip} loading={create.isPending} className="mt-3">
            直接开始
          </Button>
        </div>
      ) : (
        <>
          {!!preset.length && (
            <div className="mt-6 px-3.5 py-2.5 rounded-[var(--radius)] bg-[color-mix(in_oklch,var(--sem-ok)_8%,transparent)] border border-[color-mix(in_oklch,var(--sem-ok)_25%,transparent)]">
              <div className="text-[12.5px]">
                <span className="text-[var(--sem-ok)] font-medium">已经替你勾了 {preset.length} 个</span>
                <span className="text-[var(--text-muted)]">
                  {' '}
                  —— 你之前学过它们。学得越多，这一步要做的越少。
                </span>
              </div>
            </div>
          )}

          {/* ── 概念三态勾选 ── */}
          <div className="mt-8 space-y-7">
            {grouped.map((g) => (
              <section key={g.depth}>
                <div className="flex items-baseline gap-2.5">
                  <h2 className="text-[14px] font-semibold tracking-[-0.012em]">
                    {DEPTH_TITLE[g.depth].title}
                  </h2>
                  <span className="text-[11.5px] text-[var(--text-subtle)]">
                    {DEPTH_TITLE[g.depth].hint}
                  </span>
                </div>
                <div className="mt-2.5 divide-y divide-[var(--border)] border-y border-[var(--border)]">
                  {g.items.map((c) => (
                    <div
                      key={c.name}
                      className="flex items-center gap-3 py-2.5 flex-wrap sm:flex-nowrap"
                    >
                      <div className="min-w-0 grow">
                        <div className="text-[13.5px] font-medium">{c.name}</div>
                        {c.gloss && (
                          <div className="text-[12px] text-[var(--text-subtle)] mt-0.5 leading-relaxed">
                            {c.gloss}
                          </div>
                        )}
                      </div>
                      {/* 三态用一排按钮而不是下拉：勾选要一眼一点完 */}
                      <div className="flex gap-0.5 shrink-0 p-0.5 bg-[var(--bg-sunken)] border border-[var(--border)] rounded-[var(--radius)]">
                        {STATES.map((s) => (
                          <button
                            key={s.value}
                            title={s.hint}
                            onClick={() => setStates((m) => ({ ...m, [c.name]: s.value }))}
                            className={cn(
                              'h-6 px-2.5 text-[12px] font-medium rounded-[var(--radius-sm)] transition-colors',
                              (states[c.name] ?? 'unknown') === s.value
                                ? s.value === 'known'
                                  ? 'bg-[var(--bg-raised)] text-[var(--sem-ok)] shadow-[var(--shadow-float)]'
                                  : 'bg-[var(--bg-raised)] text-[var(--text)] shadow-[var(--shadow-float)]'
                                : 'text-[var(--text-subtle)] hover:text-[var(--text)]',
                            )}
                          >
                            {s.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          {tooShallow && (
            <div className="mt-6 p-4 rounded-[var(--radius-lg)] border border-[color-mix(in_oklch,var(--accent)_35%,transparent)] bg-[color-mix(in_oklch,var(--accent)_6%,transparent)]">
              <div className="text-[13px] font-medium">这门课对你可能太浅了</div>
              <p className="text-[12.5px] text-[var(--text-muted)] mt-1 leading-relaxed">
                连最核心的概念你都说熟悉。要不要换一个更前沿的切入点？
                比如把主题改成它的某个未解问题、最新进展或工程落地难点。
                当然，继续开课也完全可以 —— 我会直接从边界之外讲起。
              </p>
              <Button variant="outline" size="sm" onClick={() => nav('/')} className="mt-2.5">
                换个更深的主题
              </Button>
            </div>
          )}

          {/* ── 学习目标：决定课程的上界 ── */}
          {!!goals.length && (
            <section className="mt-9">
              <div className="flex items-baseline gap-2.5">
                <h2 className="text-[14px] font-semibold tracking-[-0.012em]">学完之后你想能做什么</h2>
                <span className="text-[11.5px] text-[var(--text-subtle)]">
                  它决定这门课在哪儿收尾
                </span>
              </div>
              <div className="mt-3 space-y-1.5">
                {goals.map((g) => (
                  <button
                    key={g.kind}
                    onClick={() => {
                      setGoalKind(g.kind)
                      setGoalText('')
                    }}
                    className={cn(
                      'w-full flex items-center gap-2.5 px-3.5 py-2.5 text-left',
                      'border rounded-[var(--radius)] transition-colors',
                      !goalText.trim() && goalKind === g.kind
                        ? 'border-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_6%,transparent)]'
                        : 'border-[var(--border)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
                    )}
                  >
                    <span
                      className={cn(
                        'size-[13px] rounded-full border-2 shrink-0',
                        !goalText.trim() && goalKind === g.kind
                          ? 'border-[var(--accent)] bg-[var(--accent)]'
                          : 'border-[var(--border-strong)]',
                      )}
                    />
                    <span className="text-[13px]">{g.label}</span>
                  </button>
                ))}
              </div>
              <Input
                value={goalText}
                onChange={(e) => setGoalText(e.target.value)}
                placeholder="或者自己写一个：学完我想能……"
                className="mt-2.5"
                maxLength={200}
              />
            </section>
          )}

          {/* ── 抽查：只防自评虚高，可跳过 ── */}
          {!!probes.length && (
            <section className="mt-9">
              <div className="flex items-baseline gap-2.5">
                <h2 className="text-[14px] font-semibold tracking-[-0.012em]">顺手确认一下</h2>
                <span className="text-[11.5px] text-[var(--text-subtle)]">
                  可跳过。答了我就不再铺垫这些
                </span>
              </div>
              <p className="text-[12px] text-[var(--text-subtle)] mt-1.5 leading-relaxed">
                不是考试，一句话就行 —— 我只是想确认能不能直接往下讲。
                不确定就留空，我会顺带回顾一句。
              </p>
              <div className="mt-3 space-y-3">
                {probes.map((p) => (
                  <div key={p.name}>
                    <div className="text-[12.5px] text-[var(--text-muted)]">
                      <span className="text-[var(--text)] font-medium">{p.name}</span>
                      <span className="mx-1.5 opacity-40">·</span>
                      {p.probe}
                    </div>
                    <Textarea
                      value={answers[p.name] ?? ''}
                      onChange={(e) => setAnswers((m) => ({ ...m, [p.name]: e.target.value }))}
                      rows={2}
                      maxLength={1000}
                      placeholder="一句话说说你的理解…"
                      className="mt-1.5"
                    />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* ── 提交 ── */}
          <div className="mt-10 pt-6 border-t border-[var(--border)] flex items-center gap-3 flex-wrap">
            <Button variant="primary" size="md" onClick={start} loading={create.isPending}>
              按这个边界开课
            </Button>
            <Button variant="ghost" size="md" onClick={skip} disabled={create.isPending}>
              跳过，直接开始
            </Button>
            <span className="text-[12px] text-[var(--text-subtle)] tabular-nums">
              熟悉 {counts.known} · 听过 {counts.shaky} · 没接触 {counts.unknown}
            </span>
          </div>
        </>
      )}
    </div>
  )
}
