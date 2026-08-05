import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape'
import { api } from '@/lib/api'
import { toast } from '@/lib/store'
import type { Card, CardGraphNode, CardLink, Course, OverlayData } from '@/lib/types'
import { RELATION_COLORS, RELATION_LABELS } from '@/lib/types'
import { Badge, Button, Empty, Modal, Progress, Segmented, Spinner } from '@/components/ui'
import { cn, relativeTime, truncate } from '@/lib/utils'
import { type GraphView as View, runLayout } from '@/lib/graphLayout'
import { DARK, LIGHT, makeStylesheet } from '@/lib/graphTheme'
import { useIsDark } from '@/lib/useTheme'

/**
 * 双图谱（PLAN §3.4）
 *
 * 三个视图人格不同，各自只回答一个问题：
 *   概念图 —— "这个领域长什么样、该按什么顺序学"（客观，不掺学习状态）
 *   问题图 —— "我追问出来的思考轨迹"（主观、有时间性）
 *   进度   —— "我啃到哪了、哪里还是空白"，空白区反向驱动学习
 *
 * 三者共用一套分层布局（lib/graphLayout），但骨架边不同 ——
 * 布局的语义就是视图的语义。配色见 lib/graphTheme。
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
        <h1 className="text-[18px] font-semibold tracking-[-0.01em]">图谱</h1>
        <p className="text-[13px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
          每门课有三张图：领域该怎么学、你啃到哪了、你追问出了什么。挑一门进去看。
        </p>

        {isLoading ? (
          <div className="flex justify-center py-16">
            <Spinner className="size-5 text-[var(--text-subtle)]" />
          </div>
        ) : !courses?.length ? (
          <div className="mt-10">
            <Empty title="还没有课程" hint="先去首页开一门课，图谱会随着你的学习自己长出来。" />
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
                  {/* 卡片数是图谱页最该关心的：没有卡片，图谱就只是 AI 的独白 */}
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
  desc?: string
  meta?: string
}

function GraphCanvas({ courseId }: { courseId: string }) {
  const nav = useNavigate()
  const boxRef = useRef<HTMLDivElement>(null)
  const cyRef = useRef<Core | null>(null)
  const touchedRef = useRef(false) // 用户是否手动缩放/拖动过
  const dark = useIsDark()

  // /graph/all 是"跨课程问题图"的伪 id
  const allMode = courseId === 'all'
  const [view, setView] = useState<View>(allMode ? 'cards' : 'overlay')
  const [selected, setSelected] = useState<{ type: 'concept' | 'card'; id: string } | null>(null)
  const [cardDetail, setCardDetail] = useState<Card | null>(null)
  const [hover, setHover] = useState<HoverInfo | null>(null)
  const [reinforcing, setReinforcing] = useState('')

  const { data: courses } = useQuery({
    queryKey: ['courses'],
    queryFn: () => api.get<Course[]>('/courses'),
  })
  const course = courses?.find((c) => c.id === courseId)

  const { data: overlay, isLoading: loadingOverlay } = useQuery({
    queryKey: ['overlay', courseId],
    queryFn: () => api.get<OverlayData>(`/graph/overlay?course_id=${courseId}`),
    enabled: !allMode && view !== 'cards',
  })

  const { data: cardGraph, isLoading: loadingCards } = useQuery({
    queryKey: ['card-graph', allMode ? null : courseId],
    queryFn: () =>
      api.get<{
        nodes: CardGraphNode[]
        parent_edges: { from: string; to: string }[]
        links: CardLink[]
      }>(`/graph/cards${allMode ? '' : `?course_id=${courseId}`}`),
    enabled: view === 'cards',
  })

  const elements: ElementDefinition[] = useMemo(() => {
    const els: ElementDefinition[] = []

    if (view === 'cards' && cardGraph) {
      for (const n of cardGraph.nodes) {
        els.push({
          data: {
            id: n.id,
            label: truncate(n.label || '未命名', 12),
            full: n.label || '未命名',
            size: 20 + Math.min(n.touch_count, 8) * 1.8 - n.depth * 1.2,
            kind: 'card',
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
    }

    if (!overlay) return els

    const isOverlay = view === 'overlay'
    for (const n of overlay.nodes) {
      els.push({
        data: {
          id: n.id,
          label: truncate(n.label, 12),
          full: n.label,
          desc: n.description || '',
          // 进度视图用大小表达"提过几个问题"；概念图不掺学习状态，统一大小
          size: isOverlay ? 22 + Math.min(n.card_count, 8) * 2.4 : 26,
          kind: 'concept',
          meta: isOverlay
            ? n.card_count
              ? `${n.card_count} 张卡${n.rewritten_count ? ` · ${n.rewritten_count} 张有己见` : ''}`
              : '还没提过问题'
            : '',
        },
        classes: cn(
          'concept',
          isOverlay && 'overlay',
          isOverlay &&
            (n.rewritten_count > 0 ? 'owned' : n.card_count > 0 ? 'covered' : 'blank'),
        ),
      })
    }
    for (const e of overlay.edges) {
      els.push({ data: { id: e.id, source: e.from, target: e.to }, classes: e.relation })
    }
    return els
  }, [view, overlay, cardGraph])

  const fit = useCallback(() => {
    const cy = cyRef.current
    if (!cy || !cy.elements().length) return
    cy.resize()
    cy.fit(undefined, 48)
  }, [])

  // 渲染 / 重建图
  useEffect(() => {
    const box = boxRef.current
    if (!box || !elements.length) return

    const cy = cytoscape({
      container: box,
      elements,
      style: makeStylesheet(dark ? DARK : LIGHT),
      layout: { name: 'preset' }, // 真正的布局在下面按视图分派
      minZoom: 0.15,
      maxZoom: 3,
      wheelSensitivity: 0.22,
    })
    cyRef.current = cy
    touchedRef.current = false

    runLayout(cy, view)
    // ★ 立即 fit，不要拖到 setTimeout 里。
    //   之前只在 60ms 后 fit 一次，若那一刻容器尺寸还没稳定（flex 布局未完成），
    //   视口就永久飘在一边，表现为"画布一片空白"，极难和"没数据"区分。
    cy.fit(undefined, 48)

    cy.on('mousedown wheel', () => {
      touchedRef.current = true
    })

    cy.on('tap', 'node', (e) => {
      const n = e.target
      const kind = n.data('kind')
      setSelected({ type: kind === 'card' ? 'card' : 'concept', id: n.id() })
      cy.elements().addClass('dimmed')
      n.closedNeighborhood().removeClass('dimmed')
    })

    cy.on('tap', (e) => {
      if (e.target === cy) {
        setSelected(null)
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
        desc: n.data('desc') || undefined,
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
      if (e.target.data('kind') === 'card') {
        api.get<Card>(`/cards/${e.target.id()}`).then(setCardDetail).catch(() => {})
      }
    })

    // 容器尺寸变化（首屏 flex 未稳定、窗口缩放、侧栏展开）都要重新适配，
    // 但用户自己调过视角之后就别再抢镜头了
    const ro = new ResizeObserver(() => {
      cy.resize()
      if (!touchedRef.current) cy.fit(undefined, 48)
    })
    ro.observe(box)

    return () => {
      ro.disconnect()
      cy.destroy()
      cyRef.current = null
    }
  }, [elements, view, dark])

  const reinforce = async (concept: string) => {
    setReinforcing(concept)
    try {
      const r = await api.post<{ course_id: string; title: string }>(
        `/graph/reinforce?course_id=${courseId}&concept=${encodeURIComponent(concept)}`,
      )
      toast.ok('已生成强化课')
      nav(`/courses/${r.course_id}`)
    } catch (e: any) {
      toast.error(e?.message ?? '生成失败')
    } finally {
      setReinforcing('')
    }
  }

  const loading = view === 'cards' ? loadingCards : loadingOverlay
  const selectedConcept =
    selected?.type === 'concept' ? overlay?.nodes.find((n) => n.id === selected.id) : null
  const conceptCards = (selectedConcept && overlay?.attachments[selectedConcept.id]) || []

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <header className="shrink-0 flex flex-wrap items-center gap-3 px-5 py-3 border-b border-[var(--border)]">
        <button
          onClick={() => nav('/graph')}
          className="text-[13px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
        >
          图谱
        </button>
        <span className="text-[var(--text-subtle)] opacity-50">/</span>
        <h1 className="text-[14px] font-semibold tracking-[-0.01em] max-w-[280px] truncate">
          {allMode ? '全部问题图' : course?.title || course?.topic || '…'}
        </h1>

        {!allMode && (
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: 'overlay', label: '进度', title: '我啃到哪了、哪里还是空白' },
              { value: 'concepts', label: '概念图', title: '这个领域长什么样、该按什么顺序学' },
              { value: 'cards', label: '问题图', title: '我追问出来的思考轨迹' },
            ]}
          />
        )}

        <div className="grow" />

        {view === 'overlay' && overlay && (
          <span className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
            <span
              className="w-20 h-1 rounded-full overflow-hidden bg-[var(--bg-sunken)] shrink-0"
              title={`${overlay.nodes.length - overlay.blank_spots.length} / ${overlay.nodes.length} 个概念提过问题`}
            >
              <span
                className="block h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${Math.round(overlay.coverage * 100)}%`,
                  background: 'var(--sem-rewritten)',
                }}
              />
            </span>
            <span>
              <b className="tabular-nums text-[var(--text)]">
                {Math.round(overlay.coverage * 100)}%
              </b>
              <span className="mx-1.5 opacity-40">·</span>
              {overlay.blank_spots.length} 块空白
            </span>
          </span>
        )}
      </header>

      <div className="grow min-h-0 flex">
        {/* 画布 */}
        <div className="relative grow min-w-0" style={{ background: 'var(--graph-bg)' }}>
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Spinner className="size-5 text-[var(--text-subtle)]" />
            </div>
          ) : !elements.length ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center max-w-sm px-6">
                <div className="text-[14px] font-medium text-[var(--text)]">图还是空的</div>
                <div className="text-[13px] text-[var(--text-muted)] mt-2 leading-relaxed">
                  {view === 'cards'
                    ? '把卡片收进仓库后，它们就会出现在这里，连成你自己的问题网络。'
                    : '生成一节课的正文，AI 会顺手抽出这个领域的概念结构。'}
                </div>
              </div>
            </div>
          ) : null}

          <div ref={boxRef} className="absolute inset-0" />

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
              {hover.desc && (
                <div className="text-[12px] text-[var(--text-muted)] mt-1 leading-relaxed line-clamp-3">
                  {hover.desc}
                </div>
              )}
              {hover.meta && (
                <div className="text-[11.5px] text-[var(--text-subtle)] mt-1.5">{hover.meta}</div>
              )}
            </div>
          )}

          {/* 一门新课满屏空心球时，得说清这些球是什么、怎么点亮 */}
          {view === 'overlay' && overlay?.nodes.length && overlay.coverage === 0 ? (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 max-w-md px-4 text-center pointer-events-none">
              <div className="text-[13px] text-[var(--text-muted)]">
                这门课你还没提过任何问题
              </div>
              <div className="text-[12px] text-[var(--text-subtle)] mt-1 leading-relaxed">
                每个空心球是一个概念。去读一节、划词提问，对应的球就会亮起来。
              </div>
            </div>
          ) : null}

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
            {view === 'cards' ? (
              <>
                <Legend color="#a7f3d0" ring="#10b981" label="己见卡" />
                <Legend line="#c3cbd6" label="追问链" />
                <Legend line="#f59e0b" label="正式关联" />
                <Legend line="#cbd5e1" label="可能关联" lineStyle="dashed" />
                <span className="opacity-70">左→右 = 追问的深度</span>
              </>
            ) : view === 'overlay' ? (
              <>
                <Legend color="transparent" ring="#cbd5e1" label="空白" dashed />
                <Legend color="#bfdbfe" ring="#60a5fa" label="提过问题" />
                <Legend color="#a7f3d0" ring="#10b981" label="有己见" />
                <span className="opacity-70">球越大 = 提过的问题越多</span>
              </>
            ) : (
              <>
                <Legend line="#7dabf8" label="前置" />
                <Legend line="#c3cbd6" label="组成" />
                <Legend line="#cbd5e1" label="相关" lineStyle="dashed" />
                <Legend line="#d8b4fe" label="对照" lineStyle="dotted" />
                <span className="opacity-70">上→下 = 学习顺序</span>
              </>
            )}
          </div>
        </div>

        {/* 侧栏 */}
        <aside className="w-[280px] shrink-0 border-l border-[var(--border)] overflow-y-auto">
          {selectedConcept ? (
            <div className="p-4">
              <div className="text-[14px] font-semibold">{selectedConcept.label}</div>
              {selectedConcept.description && (
                <p className="text-[12.5px] text-[var(--text-muted)] leading-relaxed mt-2">
                  {selectedConcept.description}
                </p>
              )}

              {/* 学习状态只在进度视图出现，概念图保持"客观地图"的人格 */}
              {view === 'overlay' && (
                <>
                  <div className="flex gap-1.5 mt-3">
                    <Badge tone={selectedConcept.card_count ? 'accent' : 'neutral'}>
                      {selectedConcept.card_count} 张卡
                    </Badge>
                    {selectedConcept.rewritten_count > 0 && (
                      <Badge tone="rewritten">{selectedConcept.rewritten_count} 己见</Badge>
                    )}
                  </div>

                  {/* 卡片不挤进画布当节点，改在这里下钻 —— 画布只管结构，侧栏只管细节 */}
                  {!!conceptCards.length && (
                    <div className="mt-3.5">
                      <div className="text-[11px] text-[var(--text-subtle)] mb-1.5">
                        我在这块提过的问题
                      </div>
                      <div className="space-y-1">
                        {conceptCards.map((a) => (
                          <button
                            key={a.card_id}
                            onClick={() =>
                              api
                                .get<Card>(`/cards/${a.card_id}`)
                                .then(setCardDetail)
                                .catch(() => toast.error('卡片读取失败'))
                            }
                            className={cn(
                              'w-full flex items-start gap-2 px-2 py-1.5 text-left text-[12.5px] rounded-[var(--radius-sm)]',
                              'text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] transition-colors',
                            )}
                          >
                            <span
                              className={cn(
                                'mt-[5px] size-1.5 rounded-full shrink-0',
                                a.is_rewritten
                                  ? 'bg-[var(--sem-rewritten)]'
                                  : 'bg-[var(--text-subtle)]',
                              )}
                              title={a.is_rewritten ? '已写己见' : 'AI 原生'}
                            />
                            <span className="min-w-0 line-clamp-2 leading-snug">
                              {a.label || '未命名'}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {selectedConcept.card_count === 0 && (
                    <div className="mt-4 p-3 border border-dashed border-[var(--border-strong)] rounded-[var(--radius)]">
                      <p className="text-[12px] text-[var(--text-muted)] leading-relaxed">
                        你在这块周边一个问题都没提过。可能是真的懂，也可能是盲区。
                      </p>
                      <Button
                        size="xs"
                        variant="primary"
                        className="mt-2.5 w-full"
                        loading={reinforcing === selectedConcept.label}
                        onClick={() => reinforce(selectedConcept.label)}
                      >
                        生成强化课
                      </Button>
                    </div>
                  )}
                </>
              )}

              {selectedConcept.section_id && (
                <Button
                  size="xs"
                  variant="outline"
                  className="mt-3 w-full"
                  onClick={() =>
                    nav(`/courses/${selectedConcept.course_id}/sections/${selectedConcept.section_id}`)
                  }
                >
                  去读这一节
                </Button>
              )}
            </div>
          ) : view === 'overlay' && overlay?.blank_spots.length ? (
            <div className="p-4">
              <div className="text-[13px] font-semibold">空白区</div>
              <p className="text-[12px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
                这些概念你一个问题都没提过。点开可以生成专项强化课。
              </p>
              <div className="mt-3 space-y-1">
                {overlay.blank_spots.slice(0, 24).map((b) => (
                  <button
                    key={b.id}
                    onClick={() => {
                      setSelected({ type: 'concept', id: b.id })
                      const cy = cyRef.current
                      const n = cy?.getElementById(b.id)
                      if (n?.length) {
                        touchedRef.current = true
                        cy!.elements().addClass('dimmed')
                        n.closedNeighborhood().removeClass('dimmed')
                        cy!.animate({ center: { eles: n }, zoom: 1.2 }, { duration: 300 })
                      }
                    }}
                    className="w-full px-2 py-1.5 text-left text-[12.5px] rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] transition-colors truncate"
                  >
                    {b.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="p-4">
              <Empty
                title="点一个球"
                hint={
                  view === 'cards'
                    ? '双击卡片可以看到完整内容。'
                    : view === 'overlay'
                      ? '点概念看你在这块提过哪些问题。'
                      : '这张图只讲领域客观长什么样，不掺你的学习状态。'
                }
              />
            </div>
          )}

          {view === 'cards' && (
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
          )}
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
