import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, sse } from '@/lib/api'
import { useCardSpace } from '@/lib/cardSpace'
import { usePomodoro, toast } from '@/lib/store'
import type { SectionDetail } from '@/lib/types'
import { Markdown } from '@/components/Markdown'
import { CardSpace } from '@/components/CardSpace'
import { SelectionPopover } from '@/components/SelectionPopover'
import { useSelection, findAnchor } from '@/components/useSelection'
import { PomodoroPill } from '@/components/Pomodoro'
import { Badge, Button, Spinner, Tip } from '@/components/ui'
import { cn } from '@/lib/utils'

/**
 * ★ 讲解页 —— 四条铁律的落地处（PLAN §3.2.0）
 *
 * ┌──────────────────────────┬──────────────────────┐
 * │      正文阅读区            │   卡片空间（可平移缩放）│
 * │   （划词高亮保持可见）      │    ┌────┐             │
 * │                          │    │ C1 │────┐         │
 * │   ……通过 [softmax] 归一化  │    └────┘  ┌────┐     │
 * │     后得到权重分布……       │            │ C2 │     │
 * └──────────────────────────┴──────────────────────┘
 *
 * 铁律 #4：原文**永远不被遮挡**。卡片是浮在旁边，不是盖在上面。
 *          遮住原文 = 打断阅读 = 用户放弃使用卡片。
 *          所以这里是**分栏**，不是浮层，不是抽屉（窄屏才降级）。
 */

const ADJUSTS = [
  { key: 'simpler', label: '讲浅一点' },
  { key: 'deeper', label: '讲深一点' },
  { key: 'example', label: '换个例子' },
  { key: 'shorter', label: '精简一些' },
]

export default function SectionPage() {
  const { courseId = '', sectionId = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()

  const [content, setContent] = useState('')
  const [generating, setGenerating] = useState(false)
  const [adjustOpen, setAdjustOpen] = useState(false)
  const [narrowDrawer, setNarrowDrawer] = useState(false)

  const cards = useCardSpace((s) => s.cards)
  const hoverCardId = useCardSpace((s) => s.hoverCardId)
  const loadCards = useCardSpace((s) => s.load)
  const resetCards = useCardSpace((s) => s.reset)
  const createAndAsk = useCardSpace((s) => s.createAndAsk)
  const setFocus = useCardSpace((s) => s.setFocus)
  const setHover = useCardSpace((s) => s.setHover)

  const pomodoro = usePomodoro((s) => s.active)
  const startPomodoro = usePomodoro((s) => s.start)

  const { ref: readRef, selection, clear } = useSelection(!generating)
  const abortRef = useRef<AbortController | null>(null)

  const { data: section } = useQuery({
    queryKey: ['section', sectionId],
    queryFn: () => api.get<SectionDetail>(`/courses/${courseId}/sections/${sectionId}`),
  })

  /* ── 正文：懒生成 + 流式 ── */
  const generate = useCallback(
    (adjust = '', force = false) => {
      abortRef.current?.abort()
      const ctrl = new AbortController()
      abortRef.current = ctrl

      setGenerating(true)
      setContent('')
      let buf = ''

      const qs = new URLSearchParams()
      if (adjust) qs.set('adjust', adjust)
      if (force) qs.set('force', 'true')

      sse(`/courses/${courseId}/sections/${sectionId}/stream?${qs}`, {
        signal: ctrl.signal,
        onDelta: (t) => {
          buf += t
          setContent(buf)
        },
        onEvent: (ev, data) => {
          // 概念块被后端剥掉后会补发一次干净全文，用它对齐
          if (ev === 'content' && typeof data?.markdown === 'string') setContent(data.markdown)
        },
        onDone: () => {
          setGenerating(false)
          qc.invalidateQueries({ queryKey: ['section', sectionId] })
          qc.invalidateQueries({ queryKey: ['course', courseId] })
        },
        onError: (m) => {
          setGenerating(false)
          toast.error(m)
        },
      }).catch(() => setGenerating(false))
    },
    [courseId, sectionId, qc],
  )

  // 进入小节：加载已有正文或触发生成，同时加载卡片、起番茄
  useEffect(() => {
    if (!section) return
    if (section.content_md) {
      setContent(section.content_md)
      setGenerating(false)
    } else {
      generate()
    }
    loadCards(sectionId)

    // 开始一节 → 自动起番茄，时长对齐该节 est_minutes（PLAN §3.3）
    if (!usePomodoro.getState().active) {
      startPomodoro(sectionId, section.est_minutes).catch(() => {})
    }

    return () => {
      abortRef.current?.abort()
      resetCards()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionId, section?.id])

  /* ── 划过的词在原文里保留浅色下划线（PLAN §3.2.0）──
     用 DOM 包裹而不是 CSS Highlight API：后者 Safari 支持仍不稳，
     而这里的高亮要能点击（点锚点 → 卡片空间聚焦到该卡）。 */
  const marksRef = useRef<HTMLElement[]>([])

  const clearMarks = useCallback(() => {
    for (const m of marksRef.current) {
      const parent = m.parentNode
      if (!parent) continue
      while (m.firstChild) parent.insertBefore(m.firstChild, m)
      parent.removeChild(m)
      parent.normalize()
    }
    marksRef.current = []
  }, [])

  useLayoutEffect(() => {
    const root = readRef.current
    if (!root || generating) return
    clearMarks()

    // 长的先标，避免短词把长词切碎
    const roots = cards
      .filter((c) => !c.parent_card_id && c.selected_text)
      .sort((a, b) => b.selected_text.length - a.selected_text.length)

    for (const card of roots) {
      const anchor = card.text_anchor as { exact?: string; prefix?: string }
      const range = findAnchor(root, {
        exact: anchor?.exact ?? card.selected_text,
        prefix: anchor?.prefix,
      })
      if (!range) continue
      try {
        const mark = document.createElement('mark')
        mark.className = 'anchor-mark'
        mark.dataset.cardId = card.id
        range.surroundContents(mark)
        marksRef.current.push(mark)
      } catch {
        // 选区跨越元素边界时 surroundContents 会抛错，跳过即可
      }
    }
    return clearMarks
  }, [cards, content, generating, clearMarks, readRef])

  // 锚点 ↔ 卡片 双向联动
  useEffect(() => {
    const root = readRef.current
    if (!root) return
    const onClick = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest?.('.anchor-mark') as HTMLElement | null
      if (el?.dataset.cardId) setFocus(el.dataset.cardId)
    }
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement).closest?.('.anchor-mark') as HTMLElement | null
      setHover(el?.dataset.cardId ?? null)
    }
    root.addEventListener('click', onClick)
    root.addEventListener('mouseover', onOver)
    return () => {
      root.removeEventListener('click', onClick)
      root.removeEventListener('mouseover', onOver)
    }
  }, [setFocus, setHover, readRef])

  // hover 卡片 → 原文对应锚点高亮
  useEffect(() => {
    for (const m of marksRef.current) {
      m.classList.toggle('is-active', m.dataset.cardId === hoverCardId)
    }
  }, [hoverCardId, cards])

  const complete = async () => {
    await api.post(`/courses/${courseId}/sections/${sectionId}/complete`)
    qc.invalidateQueries({ queryKey: ['section', sectionId] })
    qc.invalidateQueries({ queryKey: ['course', courseId] })
  }

  const goto = (id: string) => nav(`/courses/${courseId}/sections/${id}`)

  if (!section) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner className="size-5 text-[var(--text-subtle)]" />
      </div>
    )
  }

  const rootCount = cards.filter((c) => !c.parent_card_id).length

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ── 顶栏 ── */}
      <header className="shrink-0 h-11 flex items-center gap-3 px-4 border-b border-[var(--border)] bg-[var(--bg)]">
        <button
          onClick={() => nav(`/courses/${courseId}`)}
          className="flex items-center gap-1.5 min-w-0 text-[12.5px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
        >
          <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          <span className="truncate max-w-[220px]">{section.course.title}</span>
        </button>

        <span className="text-[var(--border-strong)]">/</span>
        <span className="text-[12.5px] text-[var(--text-subtle)] truncate max-w-[180px] hidden sm:block">
          {section.chapter.title}
        </span>

        <div className="grow" />

        <span className="text-[11.5px] text-[var(--text-subtle)] tabular-nums hidden sm:block">
          {section.nav.index}/{section.nav.total}
        </span>

        {/* 重生成 / 调难度 —— AI 编课质量不稳定，得给用户方向盘 */}
        {!generating && content && (
          <div className="relative">
            <Button size="xs" variant="ghost" onClick={() => setAdjustOpen((v) => !v)}>
              重讲
              {section.regenerate_count > 0 && (
                <span className="text-[10px] opacity-60">·{section.regenerate_count}</span>
              )}
            </Button>
            {adjustOpen && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setAdjustOpen(false)} />
                <div className="absolute right-0 top-7 z-30 w-32 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded-[var(--radius)] shadow-[var(--shadow-pop)]">
                  {ADJUSTS.map((a) => (
                    <button
                      key={a.key}
                      onClick={() => {
                        setAdjustOpen(false)
                        generate(a.key, true)
                      }}
                      className="w-full px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--bg-hover)]"
                    >
                      {a.label}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        <Tip label="使用说明">
          <button
            onClick={() => window.open('/guide', '_blank')}
            className="size-6 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] transition-colors"
          >
            <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9.5" />
              <path d="M9.2 9.1a3 3 0 1 1 4.2 2.8c-.8.4-1.3 1.1-1.3 2v.3M12 17.4h.01" />
            </svg>
          </button>
        </Tip>

        {!pomodoro && (
          <Tip label={`起一颗 ${section.est_minutes} 分钟的番茄`}>
            <Button size="xs" variant="ghost" onClick={() => startPomodoro(sectionId, section.est_minutes)}>
              开始专注
            </Button>
          </Tip>
        )}
        <PomodoroPill compact />

        <Button
          size="xs"
          variant={section.completed ? 'subtle' : 'primary'}
          onClick={complete}
        >
          {section.completed ? '已学完' : '标记学完'}
        </Button>
      </header>

      {/* ── 双栏主体 ── */}
      <div className="grow min-h-0 flex">
        {/* 左：正文阅读区。永不被卡片遮挡 —— 铁律 #4 */}
        <div className="grow min-w-0 overflow-y-auto lg:border-r border-[var(--border)]">
          <article className="max-w-[760px] mx-auto px-8 lg:px-10 py-10 pb-32">
            <div className="flex items-center gap-2 text-[11.5px] text-[var(--text-subtle)] mb-3">
              <span className="font-mono tabular-nums">
                {section.chapter.idx + 1}.{section.nav.index}
              </span>
              <span className="opacity-40">·</span>
              <span>{section.est_minutes} 分钟</span>
              {rootCount > 0 && (
                <>
                  <span className="opacity-40">·</span>
                  <span>{cards.length} 张卡</span>
                </>
              )}
            </div>

            <h1 className="text-[27px] font-semibold tracking-[-0.022em] leading-[1.28]">
              {section.title}
            </h1>
            {section.summary && (
              <p className="text-[14px] text-[var(--text-muted)] leading-[1.7] mt-2.5">
                {section.summary}
              </p>
            )}

            {!!section.key_concepts.length && (
              <div className="flex flex-wrap gap-1.5 mt-4">
                {section.key_concepts.map((k) => (
                  <Badge key={String(k)}>{String(k)}</Badge>
                ))}
              </div>
            )}

            <div className="h-px bg-[var(--border)] my-8" />

            <ReadingHint visible={!!content && !generating && cards.length === 0} />

            {/* 划词区 */}
            <div ref={readRef} className="select-text">
              {content ? (
                <div className={cn(generating && 'stream-caret')}>
                  <Markdown variant="read" streaming={generating}>
                    {content}
                  </Markdown>
                </div>
              ) : generating ? (
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-[13px] text-[var(--text-muted)] mb-6">
                    <Spinner className="size-3.5 text-[var(--accent)]" />
                    正在为你写这一节…
                  </div>
                  {[5, 4, 5, 3, 4, 5, 2].map((w, i) => (
                    <div key={i} className="skeleton h-3.5" style={{ width: `${w * 18}%` }} />
                  ))}
                </div>
              ) : (
                <div className="py-8 text-center">
                  <p className="text-[13px] text-[var(--text-muted)]">这一节还没有生成正文。</p>
                  <Button variant="primary" size="sm" onClick={() => generate()} className="mt-3">
                    生成正文
                  </Button>
                </div>
              )}
            </div>

            {/* 上下节导航 */}
            {!generating && content && (
              <div className="mt-16 pt-6 border-t border-[var(--border)] flex items-stretch gap-3">
                {section.nav.prev ? (
                  <button
                    onClick={() => goto(section.nav.prev!.id)}
                    className="group flex-1 min-w-0 text-left px-3.5 py-3 border border-[var(--border)] rounded-[var(--radius-lg)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <div className="text-[11px] text-[var(--text-subtle)]">上一节</div>
                    <div className="text-[13px] font-medium truncate mt-0.5">
                      {section.nav.prev.title}
                    </div>
                  </button>
                ) : (
                  <div className="flex-1" />
                )}
                {section.nav.next ? (
                  <button
                    onClick={() => goto(section.nav.next!.id)}
                    className="group flex-1 min-w-0 text-right px-3.5 py-3 border border-[var(--border)] rounded-[var(--radius-lg)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] transition-colors"
                  >
                    <div className="text-[11px] text-[var(--text-subtle)]">下一节</div>
                    <div className="text-[13px] font-medium truncate mt-0.5">
                      {section.nav.next.title}
                    </div>
                  </button>
                ) : (
                  <div className="flex-1" />
                )}
              </div>
            )}
          </article>
        </div>

        {/* 右：卡片空间。宽屏常驻分栏，窄屏降级为抽屉 */}
        <aside
          className={cn(
            'shrink-0 bg-[var(--bg-sunken)]',
            'hidden lg:block lg:w-[clamp(400px,42vw,720px)]',
          )}
        >
          <CardSpace />
        </aside>
      </div>

      {/* 窄屏：抽屉。仍保留父子结构，只是布局降级 */}
      {narrowDrawer && (
        <div className="lg:hidden fixed inset-0 z-40 flex">
          <div className="grow bg-black/30" onClick={() => setNarrowDrawer(false)} />
          <div className="w-[min(92vw,520px)] bg-[var(--bg-sunken)] border-l border-[var(--border)] shadow-[var(--shadow-pop)] flex flex-col animate-fade-up">
            <div className="h-10 shrink-0 flex items-center justify-between px-3 border-b border-[var(--border)]">
              <span className="text-[13px] font-medium">卡片空间</span>
              <button
                onClick={() => setNarrowDrawer(false)}
                className="size-6 flex items-center justify-center rounded-[var(--radius-sm)] hover:bg-[var(--bg-hover)]"
              >
                <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </div>
            <div className="grow min-h-0">
              <CardSpace />
            </div>
          </div>
        </div>
      )}

      {!narrowDrawer && cards.length > 0 && (
        <button
          onClick={() => setNarrowDrawer(true)}
          className="lg:hidden fixed bottom-5 right-5 z-30 h-10 px-4 rounded-full bg-[var(--accent)] text-[var(--accent-text)] text-[13px] font-medium shadow-[var(--shadow-pop)]"
        >
          {cards.length} 张卡
        </button>
      )}

      {/* 原文划词 → 根卡 */}
      <SelectionPopover
        selection={selection}
        label="就这里提问"
        hint="将生成一张新卡"
        onClose={clear}
        onAsk={(q) => {
          createAndAsk(
            {
              selected_text: selection!.text,
              context_text: selection!.sentence,
              text_anchor: {
                exact: selection!.text,
                prefix: selection!.prefix,
                suffix: selection!.suffix,
                in: 'source',
              },
              origin: 'source_text',
              source_section_id: sectionId,
            },
            q,
          )
          clear()
          setNarrowDrawer(true)
        }}
      />

      <DepthHint />
    </div>
  )
}

const HINT_KEY = 'ladder-seen-selection-hint'

/**
 * 首次阅读时的划词引导。
 *
 * 划词是本产品唯一的核心动作，但它**在界面上没有任何入口**——
 * 没有按钮、没有菜单，不告诉用户就永远不会被发现。
 * 右侧空状态里虽然有动画演示，但用户读正文时视线根本不在那儿，
 * 所以这里紧贴正文顶部再给一次，且只给一次。
 *
 * 建出第一张卡后自动消失（visible 由调用方控制），也可手动关掉。
 */
function ReadingHint({ visible }: { visible: boolean }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(HINT_KEY) === '1'
    } catch {
      return false
    }
  })

  if (!visible || dismissed) return null

  const close = () => {
    try {
      localStorage.setItem(HINT_KEY, '1')
    } catch {
      /* 隐私模式下写不了，无所谓 */
    }
    setDismissed(true)
  }

  return (
    <div className="mb-7 animate-fade-up">
      <div className="flex items-start gap-3 px-3.5 py-3 rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] bg-[var(--bg-sunken)]">
        <svg
          viewBox="0 0 24 24"
          className="size-[18px] shrink-0 mt-[1px] text-[var(--accent)]"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 7.5h9M4 12h6" />
          <path d="m14.5 11.5 6 5.5-2.8.6 1.7 3.2-1.9 1-1.7-3.2-2 2.1z" />
        </svg>

        <div className="min-w-0 grow text-[12.5px] leading-[1.7]">
          <div>
            读到不懂的地方，
            <span className="mx-0.5 px-1 py-[1px] rounded-[3px] bg-[color-mix(in_oklch,var(--accent)_22%,transparent)] font-medium text-[var(--text)]">
              用鼠标选中那个词
            </span>
            ，旁边会浮出「就这里提问」。
          </div>
          <div className="text-[var(--text-muted)] mt-1">
            AI 回答里的词<b className="text-[var(--text)] font-medium">同样能选</b>
            —— 那会生成子卡，一层层追问下去。你的问题链会在右侧连成一张图。
          </div>
        </div>

        <button
          onClick={close}
          title="知道了"
          className="shrink-0 size-5 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] transition-colors"
        >
          <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
            <path d="M6 6l12 12M18 6 6 18" />
          </svg>
        </button>
      </div>
    </div>
  )
}

/**
 * 链深提示（Folium：编号长到难受说明该提权成索引，PLAN §1.4）。
 * 这是从卡片反向驱动课程生成的闭环入口。
 */
function DepthHint() {
  const hint = useCardSpace((s) => s.depthHint)
  const clearHint = useCardSpace((s) => s.clearDepthHint)
  const cards = useCardSpace((s) => s.cards)
  const nav = useNavigate()

  useEffect(() => {
    if (!hint) return
    const t = setTimeout(clearHint, 20000)
    return () => clearTimeout(t)
  }, [hint, clearHint])

  if (!hint) return null
  const card = cards.find((c) => c.id === hint.cardId)

  const reinforce = async () => {
    if (!card) return
    clearHint()
    toast.info('正在生成专项课…')
    try {
      const r = await api.post<{ id: string }>('/courses', {
        topic: card.selected_text,
        level: 'intermediate',
        extra: `学习者在追问链的第 ${card.depth + 1} 层反复卡在这里，说明这是个真实的理解障碍。请聚焦这一个概念展开。`,
      })
      nav(`/courses/${r.id}`)
    } catch (e: any) {
      toast.error(e?.message ?? '生成失败')
    }
  }

  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 animate-fade-up">
      <div className="flex items-center gap-3 px-4 py-2.5 bg-[var(--bg-raised)] border border-[var(--border-strong)] rounded-[var(--radius-lg)] shadow-[var(--shadow-pop)] max-w-[560px]">
        <div className="text-[12.5px] leading-relaxed">{hint.message}</div>
        <div className="flex gap-1.5 shrink-0">
          <Button size="xs" variant="primary" onClick={reinforce}>
            生成专项课
          </Button>
          <Button size="xs" variant="ghost" onClick={clearHint}>
            知道了
          </Button>
        </div>
      </div>
    </div>
  )
}
