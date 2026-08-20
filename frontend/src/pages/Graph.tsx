import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape'
import { api } from '@/lib/api'
import { toast } from '@/lib/store'
import type { Card, CardGraphNode, CardLink, Course } from '@/lib/types'
import { RELATION_COLORS, RELATION_LABELS } from '@/lib/types'
import { Badge, Button, Empty, Modal, Progress, Spinner } from '@/components/ui'
import { cn, relativeTime, truncate } from '@/lib/utils'
import { runCardLayout } from '@/lib/graphLayout'
import { DARK, LIGHT, makeStylesheet } from '@/lib/graphTheme'
import { reportGuideStep } from '@/lib/guide'
import { useIsDark } from '@/lib/useTheme'

/**
 * 问题图 —— "我追问出来的思考轨迹"（主观、有时间性）。
 *
 * 这里曾经是「双图谱」：还有一张从正文里抽取概念的 AI 概念图，以及把两者
 * 叠起来的进度视图。它们已经移除 —— 概念要等正文生成才有，学之前一片空白，
 * 撑不起「这门课要学什么」。那个职责现在归课程页的学习路径图
 * （节点是小节，大纲一出来就完整可用）。
 *
 * 这张图留下来的理由恰恰相反：它记录的东西**只能事后长出来**，
 * 而且跨课程撞上的关联是整个第二大脑最值钱的部分。
 */

export default function GraphPage() {
  const { courseId } = useParams()
  // 没选课程时先给一张"挑一门课"的清单，而不是把人直接丢进一张空画布
  return courseId ? <GraphCanvas courseId={courseId} /> : <GraphPicker />
}

/* ══════════════════════════════════════════════════════════════
   入口：先挑一门课
   ══════════════════════════════════════════════════════════════ */

function GraphPicker() {
  const nav = useNavigate()
  const { data: courses, isLoading } = useQuery({
    queryKey: ['courses'],
    queryFn: () => api.get<Course[]>('/courses'),
  })

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <h1 className="text-[18px] font-semibold tracking-[-0.01em]">问题图</h1>
        <p className="text-[13px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
          你划词追问出来的每一张卡，连成一张思考轨迹图。挑一门课看它的，或者把所有课放进同一张图。
        </p>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner className="size-5 text-[var(--text-subtle)]" />
          </div>
        ) : !courses?.length ? (
          <div className="mt-10">
            <Empty title="还没有课程" hint="先去首页开一门课，边读边划词提问，图就会自己长出来。" />
          </div>
        ) : (
          <div className="mt-6 space-y-2.5">
            {courses.map((c) => (
              <button
                key={c.id}
                onClick={() => nav(`/graph/${c.id}`)}
                className={cn(
                  'w-full text-left px-4 py-3.5 rounded-[var(--radius)] border border-[var(--border)]',
                  'hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] transition-colors',
                )}
              >
                <div className="text-[14.5px] font-medium">{c.title || c.topic}</div>
                <div className="flex items-center gap-2 mt-1 text-[12px] text-[var(--text-muted)]">
                  <span>{LEVEL_LABEL[c.level] ?? c.level}</span>
                  <span className="opacity-40">·</span>
                  <span className="tabular-nums">
                    {c.stats.completed ?? 0}/{c.stats.sections ?? 0} 节
                  </span>
                  {/* 卡片数是这一页最该关心的：没有卡片，图就是空的 */}
                  {!!c.stats.cards && (
                    <>
                      <span className="opacity-40">·</span>
                      <span className="tabular-nums">{c.stats.cards} 张卡</span>
                    </>
                  )}
                  <span className="opacity-40">·</span>
                  <span>{relativeTime(c.created_at)}</span>
                </div>
                <Progress
                  className="mt-2.5"
                  value={
                    c.stats.sections ? ((c.stats.completed ?? 0) / c.stats.sections) * 100 : 0
                  }
                />
              </button>
            ))}
          </div>
        )}

        {/* 问题图是跨课程的 —— 它记录的是你的思考轨迹，不属于任何一门课 */}
        <div className="mt-8 pt-6 border-t border-[var(--border)]">
          <button
            onClick={() => nav('/graph/all')}
            className={cn(
              'w-full text-left px-4 py-3.5 rounded-[var(--radius)]',
              'border border-dashed border-[var(--border-strong)]',
              'hover:bg-[var(--bg-hover)] transition-colors',
            )}
          >
            <div className="text-[14px] font-medium">全部问题图</div>
            <div className="text-[12px] text-[var(--text-muted)] mt-1 leading-relaxed">
              把所有课程的卡片放进同一张图。跨课程撞上的关联最值钱。
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}

const LEVEL_LABEL: Record<string, string> = {
  beginner: '入门',
  intermediate: '进阶',
  advanced: '深入',
}

/* ══════════════════════════════════════════════════════════════
   画布
   ══════════════════════════════════════════════════════════════ */

interface HoverInfo {
  x: number
  y: number
  title: string
  meta?: string
}

function GraphCanvas({ courseId }: { courseId: string }) {
  const nav = useNavigate()
  const boxRef = useRef<HTMLDivElement>(null)
  const cyRef = useRef<Core | null>(null)
  const touchedRef = useRef(false) // 用户是否手动缩放/拖动过
  const dark = useIsDark()

  useEffect(() => {
    reportGuideStep('view_graph') // 引导打点（静默）
  }, [])

  // /graph/all 是"跨课程问题图"的伪 id
  const allMode = courseId === 'all'
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [cardDetail, setCardDetail] = useState<Card | null>(null)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  // 画布初始化失败时把错误摆出来 —— 空白画布和「没数据」长得一模一样，
  // 没有错误显示就永远分不清是渲染挂了还是真空（这个亏吃过三次）
  const [renderError, setRenderError] = useState('')
  const [retryTick, setRetryTick] = useState(0)

  const { data: courses } = useQuery({
    queryKey: ['courses'],
    queryFn: () => api.get<Course[]>('/courses'),
  })
  const course = courses?.find((c) => c.id === courseId)

  const { data: cardGraph, isLoading } = useQuery({
    queryKey: ['card-graph', allMode ? null : courseId],
    queryFn: () =>
      api.get<{
        nodes: CardGraphNode[]
        parent_edges: { from: string; to: string }[]
        links: CardLink[]
      }>(`/graph/cards${allMode ? '' : `?course_id=${courseId}`}`),
  })

  const elements: ElementDefinition[] = useMemo(() => {
    const els: ElementDefinition[] = []
    if (!cardGraph) return els

    for (const n of cardGraph.nodes) {
      els.push({
        data: {
          id: n.id,
          label: truncate(n.label || '未命名', 12),
          full: n.label || '未命名',
          size: 20 + Math.min(n.touch_count, 8) * 1.8 - n.depth * 1.2,
          meta: `追问深度 ${n.depth} · 碰过 ${n.touch_count} 次${n.is_rewritten ? ' · 已写己见' : ''}`,
        },
        classes: cn('card', n.is_rewritten && 'rewritten', n.depth === 0 && 'root'),
      })
    }
    const ids = new Set(cardGraph.nodes.map((n) => n.id))
    for (const e of cardGraph.parent_edges) {
      if (ids.has(e.from) && ids.has(e.to))
        els.push({
          data: { id: `p-${e.from}-${e.to}`, source: e.from, target: e.to },
          classes: 'parent',
        })
    }
    for (const l of cardGraph.links) {
      if (ids.has(l.from_card_id) && ids.has(l.to_card_id))
        els.push({
          data: {
            id: `l-${l.id}`,
            source: l.from_card_id,
            target: l.to_card_id,
            relation: l.relation,
          },
          classes: l.kind,
        })
    }
    return els
  }, [cardGraph])

  // 判空必须看「节点数」而不是 elements 长度：若后端返回了边却没有对应节点，
  // elements 非空但画布上一个东西都没有，此时既不显示空状态、也没有图，
  // 用户只会看到一片空白，无从判断是加载失败还是真没数据
  const nodeCount = useMemo(() => elements.filter((e) => !e.data.source).length, [elements])

  const fit = useCallback(() => {
    const cy = cyRef.current
    const box = boxRef.current
    if (!cy || !box || !cy.elements().length) return
    // ★ 容器还没定稿时（flex 尚未完成布局，clientWidth/Height 为 0）调 fit，
    //   cytoscape 会算出 zoom≈0，把节点缩到看不见 —— 比不 fit 更糟，
    //   而且画面表现和「没数据」一模一样，根本没法区分
    if (!box.clientWidth || !box.clientHeight) return
    cy.resize()
    cy.fit(undefined, 48)
    const z = cy.zoom()
    if (!isFinite(z) || z <= 0.02) {
      cy.zoom(1)
      cy.center()
    }
  }, [])

  // 渲染 / 重建图
  useEffect(() => {
    const box = boxRef.current
    if (!box || !nodeCount) return
    setRenderError('')

    let cy: Core
    try {
      cy = cytoscape({
        container: box,
        elements,
        style: makeStylesheet(dark ? DARK : LIGHT),
        layout: { name: 'preset' }, // 真正的布局在下面
        minZoom: 0.15,
        maxZoom: 3,
        wheelSensitivity: 0.22,
      })
      cyRef.current = cy
      touchedRef.current = false

      runCardLayout(cy)

      // 自检：布局后节点位置必须有限且散开，否则就是渲染管线出了问题
      const bb = cy.elements().boundingBox()
      const bad =
        cy.nodes().length === 0 ||
        !isFinite(bb.x1) ||
        !isFinite(bb.x2) ||
        !isFinite(bb.y1) ||
        !isFinite(bb.y2)
      if (bad) {
        throw new Error(
          `布局结果异常：${cy.nodes().length} 个节点，包围盒 (${bb.x1}, ${bb.y1}) ~ (${bb.x2}, ${bb.y2})`,
        )
      }

      // 立即 fit 一次；首帧容器常常还没定稿，下一帧再补一次。
      // 更晚的变化（窗口缩放、侧栏展开）由下面的 ResizeObserver 兜住
      fit()
    } catch (err) {
      const box2 = boxRef.current
      setRenderError(
        `${err instanceof Error ? err.message : String(err)}\n` +
          `（节点 ${nodeCount} · 容器 ${box2?.clientWidth ?? '?'}×${box2?.clientHeight ?? '?'}）`,
      )
      cyRef.current?.destroy()
      cyRef.current = null
      return
    }
    const raf = requestAnimationFrame(fit)

    cy.on('mousedown wheel', () => {
      touchedRef.current = true
    })

    cy.on('tap', 'node', (e) => {
      const n = e.target
      setSelectedId(n.id())
      cy.elements().addClass('dimmed')
      n.closedNeighborhood().removeClass('dimmed')
    })

    cy.on('tap', (e) => {
      if (e.target === cy) {
        setSelectedId(null)
        cy.elements().removeClass('dimmed')
      }
    })

    cy.on('mouseover', 'node', (e) => {
      const n = e.target
      n.addClass('hovered')
      const pos = n.renderedPosition()
      setHover({
        x: pos.x,
        y: pos.y - (n.renderedHeight() / 2 + 10),
        title: n.data('full') || n.data('label'),
        meta: n.data('meta') || undefined,
      })
      box.style.cursor = 'pointer'
    })
    cy.on('mouseout', 'node', (e) => {
      e.target.removeClass('hovered')
      setHover(null)
      box.style.cursor = ''
    })
    // 拖动/缩放时 tooltip 会错位，直接收起
    cy.on('pan zoom drag', () => setHover(null))

    cy.on('dbltap', 'node', (e) => {
      api.get<Card>(`/cards/${e.target.id()}`).then(setCardDetail).catch(() => {})
    })

    // 容器尺寸变化（首屏 flex 未稳定、窗口缩放、侧栏展开）都要重新适配，
    // 但用户自己调过视角之后就别再抢镜头了
    const ro = new ResizeObserver(() => {
      cy.resize()
      if (!touchedRef.current) fit()
    })
    ro.observe(box)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      cy.destroy()
      cyRef.current = null
    }
  }, [elements, nodeCount, dark, fit, retryTick])

  const selectedCard = selectedId
    ? cardGraph?.nodes.find((n) => n.id === selectedId) ?? null
    : null

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <header className="shrink-0 flex flex-wrap items-center gap-3 px-5 py-3 border-b border-[var(--border)]">
        <button
          onClick={() => nav('/graph')}
          className="text-[13px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
        >
          问题图
        </button>
        <span className="text-[var(--text-subtle)] opacity-50">/</span>
        <h1 className="text-[14px] font-semibold tracking-[-0.01em] max-w-[280px] truncate">
          {allMode ? '全部课程' : course?.title || course?.topic || '…'}
        </h1>

        <div className="grow" />

        {!allMode && course && (
          <Button size="xs" variant="ghost" onClick={() => nav(`/courses/${courseId}`)}>
            回到课程
          </Button>
        )}
      </header>

      <div className="grow min-h-0 flex">
        {/* 画布 */}
        <div className="relative grow min-w-0" style={{ background: 'var(--graph-bg)' }}>
          {isLoading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Spinner className="size-5 text-[var(--text-subtle)]" />
            </div>
          ) : !nodeCount ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center max-w-sm px-6">
                <div className="text-[14px] font-medium text-[var(--text)]">图还是空的</div>
                <div className="text-[13px] text-[var(--text-muted)] mt-2 leading-relaxed">
                  把卡片收进仓库后，它们就会出现在这里，连成你自己的问题网络。
                </div>
              </div>
            </div>
          ) : null}

          {/*
            ★ 千万别写 absolute inset-0：cytoscape 初始化时会往容器注入
            .cytoscape_container { position: relative }（同特异性、后注入胜出），
            把 absolute 顶掉之后 inset-0 只剩偏移、不再拉伸 ——
            父级高度正常，容器却塌成宽×0，节点全压在 y=0 一条线上。
            这就是「图谱空白」追了三天的根因。
            用 size-full 让 cytoscape 自己的 relative 正好工作。
          */}
          <div ref={boxRef} className="size-full" />

          {/* 渲染失败：把错误摆出来，而不是留一片空白让人猜 */}
          {renderError && (
            <div className="absolute inset-0 z-20 flex items-center justify-center">
              <div className="max-w-md px-6 text-center">
                <div className="text-[14px] font-medium text-[var(--text)]">图谱渲染失败</div>
                <pre className="mt-2 text-[12px] text-[var(--text-muted)] leading-relaxed whitespace-pre-wrap text-left bg-[var(--bg-sunken)] border border-[var(--border)] rounded-[var(--radius)] p-3">
                  {renderError}
                </pre>
                <Button
                  size="xs"
                  variant="outline"
                  className="mt-3"
                  onClick={() => {
                    setRenderError('')
                    setRetryTick((t) => t + 1)
                  }}
                >
                  重试
                </Button>
              </div>
            </div>
          )}

          {/* 悬停信息卡 */}
          {hover && (
            <div
              className="absolute z-10 pointer-events-none max-w-[260px] px-3.5 py-2.5 rounded-[10px] bg-[var(--bg-raised)] border border-[var(--border)]"
              style={{
                left: hover.x,
                top: hover.y,
                transform: 'translate(-50%, -100%)',
                boxShadow: 'var(--shadow-pop)',
              }}
            >
              <div className="text-[13px] font-semibold leading-snug">{hover.title}</div>
              {hover.meta && (
                <div className="text-[11.5px] text-[var(--text-subtle)] mt-1.5">{hover.meta}</div>
              )}
            </div>
          )}

          {/* 缩放控件 */}
          <div className="absolute right-3 bottom-3 flex flex-col gap-1">
            <ZoomBtn label="放大" onClick={() => cyRef.current?.zoom(cyRef.current.zoom() * 1.3)}>
              <path d="M8 3.5v9M3.5 8h9" />
            </ZoomBtn>
            <ZoomBtn label="缩小" onClick={() => cyRef.current?.zoom(cyRef.current.zoom() / 1.3)}>
              <path d="M3.5 8h9" />
            </ZoomBtn>
            <ZoomBtn label="全览" onClick={fit}>
              <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />
            </ZoomBtn>
          </div>

          {/* 图例 */}
          <div className="absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1.5 text-[10.5px] text-[var(--text-subtle)] max-w-[62%] pointer-events-none">
            <Legend color="#a7f3d0" ring="#10b981" label="己见卡" />
            <Legend line="#c3cbd6" label="追问链" />
            <Legend line="#f59e0b" label="正式关联" />
            <Legend line="#cbd5e1" label="可能关联" lineStyle="dashed" />
            <span className="opacity-70">左→右 = 追问的深度</span>
          </div>
        </div>

        {/* 侧栏 */}
        <aside className="w-[280px] shrink-0 border-l border-[var(--border)] overflow-y-auto">
          {selectedCard ? (
            <div className="p-4">
              <div className="text-[13.5px] font-semibold leading-snug">
                {selectedCard.label || '未命名'}
              </div>
              <div className="flex flex-wrap gap-1.5 mt-2.5">
                <Badge>追问深度 {selectedCard.depth}</Badge>
                {selectedCard.touch_count > 1 && (
                  <Badge>碰过 {selectedCard.touch_count} 次</Badge>
                )}
                {selectedCard.is_rewritten && <Badge tone="rewritten">己见</Badge>}
              </div>

              {!!selectedCard.concept_tags?.length && (
                <div className="flex flex-wrap gap-1 mt-3">
                  {selectedCard.concept_tags.slice(0, 6).map((t) => (
                    <span
                      key={t}
                      className="px-1.5 py-0.5 text-[11px] rounded-[5px] bg-[var(--bg-sunken)] text-[var(--text-muted)]"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              )}

              <Button
                size="xs"
                variant="outline"
                className="mt-3.5 w-full"
                onClick={() =>
                  api
                    .get<Card>(`/cards/${selectedCard.id}`)
                    .then(setCardDetail)
                    .catch(() => toast.error('卡片读取失败'))
                }
              >
                查看完整内容
              </Button>

              {selectedCard.section_id && (
                <Button
                  size="xs"
                  variant="ghost"
                  className="mt-1.5 w-full"
                  onClick={() => nav(`/courses/${courseId}/sections/${selectedCard.section_id}`)}
                >
                  回到这一节
                </Button>
              )}
            </div>
          ) : (
            <div className="p-4">
              <Empty title="点一张卡" hint="双击可以看到完整内容。" />
            </div>
          )}

          <div className="px-4 pb-4">
            <div className="text-[11px] text-[var(--text-subtle)] mb-2">关系类型</div>
            <div className="space-y-1">
              {Object.entries(RELATION_LABELS).map(([k, label]) => (
                <div
                  key={k}
                  className="flex items-center gap-2 text-[11.5px] text-[var(--text-muted)]"
                >
                  <span
                    className="w-4 h-[2px] rounded-full shrink-0"
                    style={{ background: RELATION_COLORS[k as keyof typeof RELATION_COLORS] }}
                  />
                  {label}
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      <Modal
        open={!!cardDetail}
        onClose={() => setCardDetail(null)}
        title={cardDetail ? `⟨${cardDetail.selected_text}⟩` : ''}
        subtitle={cardDetail ? relativeTime(cardDetail.created_at) : ''}
        width="max-w-xl"
      >
        {cardDetail && (
          <div className="space-y-3 text-[13px] leading-relaxed">
            {cardDetail.question && (
              <div className="text-[var(--text-muted)]">Q：{cardDetail.question}</div>
            )}
            <div className="whitespace-pre-wrap">{truncate(cardDetail.ai_answer, 1200)}</div>
            {cardDetail.user_note && (
              <div className="border-l-2 border-[var(--sem-rewritten)] pl-3 py-1 bg-[color-mix(in_oklch,var(--sem-rewritten)_6%,transparent)]">
                {cardDetail.user_note}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

function ZoomBtn({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      title={label}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'size-7 grid place-items-center rounded-[var(--radius-sm)]',
        'bg-[var(--bg-raised)] border border-[var(--border)] text-[var(--text-muted)]',
        'hover:text-[var(--text)] hover:border-[var(--border-strong)] transition-colors',
      )}
    >
      <svg
        viewBox="0 0 16 16"
        className="size-3.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      >
        {children}
      </svg>
    </button>
  )
}

function Legend({
  color,
  ring,
  line,
  label,
  dashed,
  lineStyle = 'solid',
}: {
  color?: string
  ring?: string
  line?: string
  label: string
  dashed?: boolean
  lineStyle?: 'solid' | 'dashed' | 'dotted'
}) {
  return (
    <span className="flex items-center gap-1.5">
      {line ? (
        <span
          className="w-4 h-0 shrink-0"
          style={{ borderTop: `${lineStyle === 'solid' ? '2px' : '1.5px'} ${lineStyle} ${line}` }}
        />
      ) : (
        <span
          className="size-2.5 rounded-full shrink-0"
          style={{
            background: color,
            border: ring ? `1.5px ${dashed ? 'dashed' : 'solid'} ${ring}` : undefined,
          }}
        />
      )}
      {label}
    </span>
  )
}
