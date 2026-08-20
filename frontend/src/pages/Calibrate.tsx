import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { api, sse } from '@/lib/api'
import { toast } from '@/lib/store'
import type { CalibrateConcept, CalibrateGoal, ConceptState, Course } from '@/lib/types'
import RunTimeline from '@/components/RunTimeline'
import { Button, Input, Progress, Spinner, Textarea } from '@/components/ui'
import { cn } from '@/lib/utils'

/**
 * ★ 开课前的边界校准 —— 取代「入门 / 进阶 / 深入」
 *
 * 那三个选项是抽象且无法作答的：写了十年后端的人学 Transformer 算入门吗？
 * 他对梯度和矩阵乘法的底子远超刚学完线代的学生，却对注意力一无所知。
 * 「等级」丢掉的信息正是**已知边界的形状**，而那是唯一可执行的东西。
 *
 * ★ 为什么做成「刷题」而不是「一屏表单」
 *
 *   模型规划这十几个概念要想 20~30 秒。一次性等它想完再渲染，用户就在盯着
 *   空白 —— 而**第一个概念生成出来的那一刻就已经可以勾了**。所以这里改成
 *   一道一道地问：
 *
 *     · 概念随 SSE 一个个到达，到一个就能答一道
 *     · 总题数（total）是模型最先输出的键，所以「还剩几道」一开始就说得出
 *     · 答得比生成快时，把思维链原文摊出来 —— 长推理不是问题，
 *       **看不见的**长推理才是问题
 *     · 同一主题第二个人走缓存，整份瞬间回放，几乎零等待
 *
 * 铁律：**永远不许挡住开课**。点开课的那一秒是这个产品最珍贵的资源，
 * 所以任何阶段都有「跳过，直接开始」，流式失败也能拿已经到手的几道继续。
 */

const STATES: { value: ConceptState; label: string; hint: string; key: string }[] = [
  { value: 'known', label: '熟悉', hint: '能直接用，不用再讲', key: '1' },
  { value: 'shaky', label: '听过', hint: '有印象，回顾一句就行', key: '2' },
  { value: 'unknown', label: '没接触', hint: '要从头讲清楚', key: '3' },
]

const DEPTH_LABEL: Record<number, string> = {
  1: '外围基础',
  2: '直接前置',
  3: '主题内核心',
}

type Phase = 'quiz' | 'goal' | 'probe'

export default function CalibratePage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [params] = useSearchParams()
  const topic = (params.get('topic') ?? '').trim()
  const extra = (params.get('extra') ?? '').trim()

  const [concepts, setConcepts] = useState<CalibrateConcept[]>([])
  const [total, setTotal] = useState(0)
  const [goals, setGoals] = useState<CalibrateGoal[]>([])
  const [streaming, setStreaming] = useState(true)
  const [failed, setFailed] = useState(false)
  const [thinking, setThinking] = useState(0)
  const [thinkingText, setThinkingText] = useState('')

  const [phase, setPhase] = useState<Phase>('quiz')
  const [cursor, setCursor] = useState(0)
  const [states, setStates] = useState<Record<string, ConceptState>>({})
  const [goalKind, setGoalKind] = useState('')
  const [goalText, setGoalText] = useState('')
  const [answers, setAnswers] = useState<Record<string, string>>({})

  const abortRef = useRef<AbortController | null>(null)

  /* ── 流式拉概念：一道一道到 ── */
  useEffect(() => {
    if (!topic) {
      nav('/', { replace: true })
      return
    }
    const ctrl = new AbortController()
    abortRef.current = ctrl
    const qs = new URLSearchParams({ topic })
    if (extra) qs.set('extra', extra)

    sse(`/courses/calibrate/stream?${qs}`, {
      signal: ctrl.signal,
      onEvent: (ev, data) => {
        if (ev === 'total') setTotal(Number(data?.total) || 0)
        if (ev === 'concept' && data?.name) {
          setConcepts((cs) => (cs.some((c) => c.name === data.name) ? cs : [...cs, data]))
          // 预勾的概念直接给「熟悉」的默认值；其余默认「没接触」——
          // 让人只勾自己会的，而不是逐条否认；保守方向也对
          setStates((m) => ({ ...m, [data.name]: data.preset === 'known' ? 'known' : 'unknown' }))
        }
        if (ev === 'goals') setGoals(data?.goals ?? [])
        if (ev === 'thinking') {
          setThinking(data?.chars ?? 0)
          if (data?.text) setThinkingText((t) => (t + data.text).slice(-4000))
        }
        if (ev === 'error') setFailed(true)
      },
      onDone: () => setStreaming(false),
      onError: () => {
        setStreaming(false)
        setFailed(true)
      },
    }).catch(() => {
      setStreaming(false)
      setFailed(true)
    })

    return () => ctrl.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic, extra])

  const current = concepts[cursor]
  const answered = cursor
  /** 进度分母：模型说了几道就用几道；已经超出了就以实际为准 */
  const denom = Math.max(total, concepts.length)

  /* ── 作答 ── */
  const answer = useCallback(
    (state: ConceptState) => {
      const c = concepts[cursor]
      if (!c) return
      setStates((m) => ({ ...m, [c.name]: state }))
      setCursor((i) => i + 1)
    },
    [concepts, cursor],
  )

  const back = useCallback(() => setCursor((i) => Math.max(0, i - 1)), [])

  // 键盘：刷题就该能不碰鼠标
  useEffect(() => {
    if (phase !== 'quiz') return
    const onKey = (e: KeyboardEvent) => {
      const hit = STATES.find((s) => s.key === e.key)
      if (hit) {
        e.preventDefault()
        answer(hit.value)
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        back()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phase, answer, back])

  // 全部答完且流已结束 → 进入定目标
  useEffect(() => {
    if (phase === 'quiz' && !streaming && concepts.length > 0 && cursor >= concepts.length) {
      setPhase('goal')
    }
  }, [phase, streaming, cursor, concepts.length])

  /** 抽查只挑最深档里自评「熟悉」的两个：虚高只发生在天花板附近 */
  const probes = useMemo(
    () =>
      concepts
        .filter((c) => states[c.name] === 'known' && c.probe)
        .sort((a, b) => b.depth - a.depth)
        .slice(0, 2),
    [concepts, states],
  )

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
    abortRef.current?.abort() // 已经要开课了，没必要再占着那条流
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
  const skip = () => {
    abortRef.current?.abort()
    create.mutate({ topic, extra })
  }

  useEffect(() => {
    if (goals.length && !goalKind) setGoalKind(goals[0].kind)
  }, [goals, goalKind])

  const nothingYet = concepts.length === 0

  return (
    <div className="max-w-[720px] w-full mx-auto px-8 py-12 pb-32">
      <button
        onClick={() => nav('/')}
        className="flex items-center gap-1 text-[12.5px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors mb-6"
      >
        <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m15 18-6-6 6-6" />
        </svg>
        换个主题
      </button>

      <h1 className="text-[23px] font-semibold tracking-[-0.02em] leading-[1.3]">
        开始之前，先划一下你的边界
      </h1>
      <p className="text-[13px] text-[var(--text-muted)] mt-2 leading-[1.75]">
        我不问你是入门还是进阶 —— 那个问题谁也答不准。
        下面这些概念一个个过，你只要说熟不熟，我就知道该从哪句话讲起。
      </p>

      {/* ── 进度：一开始就说清「共几道」，不让人怕看不到头 ── */}
      {!nothingYet && (
        <div className="mt-7 flex items-center gap-3">
          <Progress value={denom ? Math.min(answered / denom, 1) : 0} className="grow" />
          <span className="text-[12px] text-[var(--text-subtle)] tabular-nums shrink-0">
            {Math.min(answered + 1, denom || 1)} / {denom || '?'}
          </span>
          {streaming && (
            <span className="flex items-center gap-1 text-[11.5px] text-[var(--text-subtle)] shrink-0">
              <Spinner className="size-3" />
              已规划 {concepts.length}
              {denom ? ` / ${denom}` : ''}
            </span>
          )}
        </div>
      )}

      {/* ── 刷题 ── */}
      {phase === 'quiz' && (
        <>
          {current ? (
            <div key={current.name} className="mt-7 animate-fade-up">
              <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-subtle)]">
                <span className="px-1.5 py-[1px] rounded-[4px] bg-[var(--bg-sunken)] border border-[var(--border)]">
                  {DEPTH_LABEL[current.depth] ?? '相关概念'}
                </span>
                {current.preset === 'known' && (
                  <span className="text-[var(--sem-ok)]">你之前学过它，已经替你勾上了</span>
                )}
              </div>

              <div className="mt-3 p-6 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-raised)]">
                <div className="text-[21px] font-semibold tracking-[-0.015em]">{current.name}</div>
                {current.gloss && (
                  <div className="text-[13.5px] text-[var(--text-muted)] mt-2 leading-relaxed">
                    {current.gloss}
                  </div>
                )}

                <div className="mt-5 flex flex-wrap gap-2">
                  {STATES.map((s) => (
                    <button
                      key={s.value}
                      onClick={() => answer(s.value)}
                      title={s.hint}
                      className={cn(
                        'group flex items-center gap-2 h-9 px-4 rounded-[var(--radius)] border transition-colors',
                        (states[current.name] ?? 'unknown') === s.value && cursor < concepts.length
                          ? 'border-[var(--accent)] bg-[color-mix(in_oklch,var(--accent)_8%,transparent)]'
                          : 'border-[var(--border)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
                      )}
                    >
                      <span
                        className={cn(
                          'text-[13.5px] font-medium',
                          s.value === 'known' && 'text-[var(--sem-ok)]',
                        )}
                      >
                        {s.label}
                      </span>
                      <span className="text-[10.5px] text-[var(--text-subtle)] font-mono">{s.key}</span>
                    </button>
                  ))}
                </div>
                <div className="text-[11.5px] text-[var(--text-subtle)] mt-3">
                  {STATES.map((s) => `${s.key} = ${s.label}`).join(' · ')}
                  {cursor > 0 && ' · ← 回上一道'}
                </div>
              </div>

              {cursor > 0 && (
                <button
                  onClick={back}
                  className="mt-3 text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                >
                  ← 上一道（改答案）
                </button>
              )}
            </div>
          ) : streaming ? (
            /* 答得比模型规划得快 —— 把它正在想什么摊出来，绝不留空白 */
            <div className="mt-7 p-5 rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)]">
              <div className="flex items-center gap-2 text-[13px] font-medium">
                <Spinner className="size-3.5 text-[var(--accent)]" />
                {nothingYet ? '正在规划要问你哪些概念…' : '正在规划下一道…'}
              </div>
              <p className="text-[12px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
                它在盘这个主题需要哪些前置知识、该按什么顺序问你。
                {nothingYet && '第一道出来你就能开始答，不用等全部想完。'}
              </p>
              <RunTimeline
                thinking={thinking}
                thinkingText={thinkingText}
                tools={[]}
                className="mt-4"
              />
              <Button variant="ghost" size="sm" onClick={skip} loading={create.isPending} className="mt-4">
                不等了，直接开课
              </Button>
            </div>
          ) : (
            /* 流结束且一道都没拿到 = 彻底失败，直接给出口 */
            <div className="mt-7 p-5 border border-dashed border-[var(--border-strong)] rounded-[var(--radius-lg)]">
              <div className="text-[13.5px] font-medium">这次没能规划出概念</div>
              <p className="text-[12.5px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
                不影响开课 —— 直接开始，我会按通用的递进顺序来讲。
              </p>
              <Button variant="primary" size="sm" onClick={skip} loading={create.isPending} className="mt-3">
                直接开始
              </Button>
            </div>
          )}
        </>
      )}

      {/* ── 定目标：决定课程的上界 ── */}
      {phase === 'goal' && (
        <div className="mt-8 animate-fade-up">
          {failed && (
            <div className="text-[12px] text-[var(--text-subtle)] mb-4">
              没能全部规划完，用已经问到的 {concepts.length} 道继续。
            </div>
          )}
          {tooShallow && (
            <div className="mb-5 p-4 rounded-[var(--radius-lg)] border border-[color-mix(in_oklch,var(--accent)_35%,transparent)] bg-[color-mix(in_oklch,var(--accent)_6%,transparent)]">
              <div className="text-[13px] font-medium">这门课对你可能太浅了</div>
              <p className="text-[12.5px] text-[var(--text-muted)] mt-1 leading-relaxed">
                连最核心的概念你都说熟悉。要不要换一个更前沿的切入点 —— 比如它的某个
                未解问题、最新进展或工程落地难点？继续开课也可以，我会直接从边界之外讲起。
              </p>
              <Button variant="outline" size="sm" onClick={() => nav('/')} className="mt-2.5">
                换个更深的主题
              </Button>
            </div>
          )}

          <h2 className="text-[15px] font-semibold tracking-[-0.012em]">学完之后你想能做什么</h2>
          <p className="text-[12px] text-[var(--text-subtle)] mt-1">
            它决定这门课在哪儿收尾 —— 「能读懂论文」和「能自己实现」是两份完全不同的大纲。
          </p>
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

          <div className="mt-7 flex items-center gap-3 flex-wrap">
            <Button
              variant="primary"
              size="md"
              onClick={() => (probes.length ? setPhase('probe') : start())}
              loading={create.isPending}
            >
              {probes.length ? '下一步' : '按这个边界开课'}
            </Button>
            <Button variant="ghost" size="md" onClick={start} disabled={create.isPending}>
              直接开课
            </Button>
            <span className="text-[12px] text-[var(--text-subtle)] tabular-nums">
              熟悉 {counts.known} · 听过 {counts.shaky} · 没接触 {counts.unknown}
            </span>
          </div>
        </div>
      )}

      {/* ── 抽查：只防自评虚高，可跳过 ── */}
      {phase === 'probe' && (
        <div className="mt-8 animate-fade-up">
          <h2 className="text-[15px] font-semibold tracking-[-0.012em]">顺手确认一下</h2>
          <p className="text-[12px] text-[var(--text-subtle)] mt-1 leading-relaxed">
            不是考试，一句话就行 —— 我只是想确认能不能直接往下讲。
            不确定就留空，我会顺带回顾一句。
          </p>
          <div className="mt-4 space-y-3">
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
          <div className="mt-7 flex items-center gap-3 flex-wrap">
            <Button variant="primary" size="md" onClick={start} loading={create.isPending}>
              按这个边界开课
            </Button>
            <Button variant="ghost" size="md" onClick={() => setPhase('goal')} disabled={create.isPending}>
              上一步
            </Button>
          </div>
        </div>
      )}

      {/* ── 常驻出口：任何阶段都能跳过 ── */}
      {phase !== 'quiz' && (
        <button
          onClick={skip}
          disabled={create.isPending}
          className="mt-8 text-[12px] text-[var(--text-subtle)] hover:text-[var(--text)] transition-colors"
        >
          跳过校准，直接开始
        </button>
      )}
    </div>
  )
}
