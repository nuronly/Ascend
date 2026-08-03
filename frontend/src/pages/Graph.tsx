import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape'
import { api } from '@/lib/api'
import { toast } from '@/lib/store'
import type { Card, CardGraphNode, CardLink, Course, OverlayData } from '@/lib/types'
import { RELATION_COLORS, RELATION_LABELS } from '@/lib/types'
import { Badge, Button, Empty, Modal, Segmented, Spinner } from '@/components/ui'
import { cn, relativeTime, truncate } from '@/lib/utils'

/**
 * 双图谱（PLAN §3.4）
 *
 * 两张图人格不同：
 *   AI 概念图 —— "这个领域长什么样"（客观），只读为主
 *   卡片图    —— "我怎么想的"（主观、有时间性）
 *
 * ★ 叠加视图是杀手锏：AI 图做底图，卡片作为挂件钉在对应概念旁。
 *   一眼看到「这个领域我啃过哪几块、哪几块一片空白」，
 *   空白区反向驱动学习。
 *
 * 画布刻意用深底 —— 图谱是"另一个空间"，视觉上应该与阅读区有奇异感，
 * 强化"我在俯瞰自己的认知地图"的仪式感（PLAN §4.3.5）。
 */

type View = 'overlay' | 'concepts' | 'cards'

const BASE_STYLE: cytoscape.StylesheetJson = [
  {
    selector: 'node',
    style: {
      'background-color': 'var(--graph-node)' as any,
      'border-width': 1,
      'border-color': 'rgba(255,255,255,0.14)',
      label: 'data(label)',
      color: 'rgba(235,235,240,0.9)',
      'font-size': 10,
      'font-family': 'Inter, PingFang SC, sans-serif',
      'text-valign': 'bottom',
      'text-margin-y': 5,
      'text-max-width': '110px',
      'text-wrap': 'ellipsis',
      width: 22,
      height: 22,
      'transition-property': 'background-color, border-color, width, height, opacity',
      'transition-duration': 160 as any,
    },
  },
  {
    selector: 'node.concept',
    style: {
      shape: 'round-rectangle',
      'background-color': '#3a4150',
      width: 'data(size)' as any,
      height: 18,
      'text-valign': 'center',
      'text-margin-y': 0,
      'font-size': 10.5,
      padding: '6px' as any,
    },
  },
  // 卡片密集区 = 困难区 = 复习优先区，用发光强度表达
  {
    selector: 'node.covered',
    style: {
      'background-color': '#4a5a78',
      'border-color': 'rgba(140,180,255,0.5)',
      'border-width': 1.5,
    },
  },
  // 空白区：一个问题都没提过 —— 视觉上"暗着"，等你去点亮
  {
    selector: 'node.blank',
    style: {
      'background-color': '#262b34',
      'border-style': 'dashed',
      'border-color': 'rgba(255,255,255,0.16)',
      color: 'rgba(200,200,210,0.45)',
    },
  },
  {
    selector: 'node.card',
    style: {
      shape: 'ellipse',
      width: 'data(size)' as any,
      height: 'data(size)' as any,
      'background-color': '#5b6b8a',
      'font-size': 9,
      color: 'rgba(215,220,230,0.75)',
      'text-valign': 'bottom',
    },
  },
  // 己见卡：实心亮色描边（与 AI 原生卡区分，PLAN §4.3.2）
  {
    selector: 'node.rewritten',
    style: {
      'background-color': '#4e8f72',
      'border-color': '#7fd4aa',
      'border-width': 2,
    },
  },
  {
    selector: 'node:selected',
    style: {
      'border-color': '#8ab4ff',
      'border-width': 3,
    },
  },
  {
    selector: 'edge',
    style: {
      width: 1,
      'line-color': 'rgba(255,255,255,0.13)',
      'curve-style': 'bezier',
      'target-arrow-shape': 'none',
      opacity: 0.75,
    },
  },
  {
    selector: 'edge.prerequisite',
    style: {
      'line-color': 'rgba(150,180,255,0.3)',
      'target-arrow-shape': 'triangle',
      'target-arrow-color': 'rgba(150,180,255,0.35)',
      'arrow-scale': 0.65,
    },
  },
  // 父子链：结构性
  {
    selector: 'edge.parent',
    style: { 'line-color': 'rgba(255,255,255,0.2)', width: 1.2 },
  },
  // real link：暖调琥珀（借 Folium）
  {
    selector: 'edge.real',
    style: { 'line-color': '#d69a4a', width: 1.8, opacity: 0.95 },
  },
  // potential：冷灰虚线，"是问题，不是事实"
  {
    selector: 'edge.potential',
    style: {
      'line-color': 'rgba(160,165,180,0.4)',
      'line-style': 'dashed',
      width: 1,
      opacity: 0.5,
    },
  },
  // 挂件连线：卡片钉在概念旁
  {
    selector: 'edge.attach',
    style: {
      'line-color': 'rgba(140,180,255,0.22)',
      'line-style': 'dotted',
      width: 1,
    },
  },
  { selector: '.dimmed', style: { opacity: 0.16 } },
]

export default function GraphPage() {
  const { courseId } = useParams()
  const nav = useNavigate()
  const boxRef = useRef<HTMLDivElement>(null)
  const cyRef = useRef<Core | null>(null)

  const [view, setView] = useState<View>(courseId ? 'overlay' : 'cards')
  const [selected, setSelected] = useState<{ type: 'concept' | 'card'; id: string } | null>(null)
  const [cardDetail, setCardDetail] = useState<Card | null>(null)
  const [reinforcing, setReinforcing] = useState('')

  const { data: courses } = useQuery({
    queryKey: ['courses'],
    queryFn: () => api.get<Course[]>('/courses'),
  })

  const activeCourse = courseId ?? courses?.[0]?.id

  const { data: overlay, isLoading: loadingOverlay } = useQuery({
    queryKey: ['overlay', activeCourse],
    queryFn: () => api.get<OverlayData>(`/graph/overlay?course_id=${activeCourse}`),
    enabled: !!activeCourse && view !== 'cards',
  })

  const { data: cardGraph, isLoading: loadingCards } = useQuery({
    queryKey: ['card-graph', courseId],
    queryFn: () =>
      api.get<{
        nodes: CardGraphNode[]
        parent_edges: { from: string; to: string }[]
        links: CardLink[]
      }>(`/graph/cards${courseId ? `?course_id=${courseId}` : ''}`),
    enabled: view === 'cards',
  })

  const elements: ElementDefinition[] = useMemo(() => {
    const els: ElementDefinition[] = []

    if (view === 'cards' && cardGraph) {
      for (const n of cardGraph.nodes) {
        els.push({
          data: {
            id: n.id,
            label: truncate(n.label || '未命名', 16),
            size: 16 + Math.min(n.touch_count, 8) * 1.6 - n.depth * 1.2,
            kind: 'card',
          },
          classes: cn('card', n.is_rewritten && 'rewritten'),
        })
      }
      const ids = new Set(cardGraph.nodes.map((n) => n.id))
      for (const e of cardGraph.parent_edges) {
        if (ids.has(e.from) && ids.has(e.to))
          els.push({ data: { id: `p-${e.from}-${e.to}`, source: e.from, target: e.to }, classes: 'parent' })
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

    for (const n of overlay.nodes) {
      const covered = n.card_count > 0
      els.push({
        data: {
          id: n.id,
          label: truncate(n.label, 14),
          size: Math.max(60, Math.min(160, n.label.length * 11 + 20)),
          kind: 'concept',
          count: n.card_count,
        },
        classes: cn('concept', covered ? 'covered' : 'blank'),
      })
    }
    for (const e of overlay.edges) {
      els.push({
        data: { id: e.id, source: e.from, target: e.to },
        classes: e.relation,
      })
    }

    // ★ 叠加：把卡片作为挂件钉在概念节点旁
    if (view === 'overlay') {
      for (const [conceptId, list] of Object.entries(overlay.attachments)) {
        for (const a of list) {
          const nid = `card:${a.card_id}:${conceptId}`
          els.push({
            data: { id: nid, label: truncate(a.label || '', 12), size: 11, kind: 'card', cardId: a.card_id },
            classes: cn('card', a.is_rewritten && 'rewritten'),
          })
          els.push({
            data: { id: `at-${nid}`, source: conceptId, target: nid },
            classes: 'attach',
          })
        }
      }
    }
    return els
  }, [view, overlay, cardGraph])

  // 渲染 / 重建图
  useEffect(() => {
    if (!boxRef.current || !elements.length) return
    cyRef.current?.destroy()

    const cy = cytoscape({
      container: boxRef.current,
      elements,
      style: BASE_STYLE,
      layout: {
        name: 'cose',
        animate: false,
        nodeRepulsion: () => 12000,
        idealEdgeLength: () => 70,
        nodeOverlap: 14,
        gravity: 0.5,
        numIter: 900,
        padding: 40,
      } as any,
      minZoom: 0.2,
      maxZoom: 2.5,
      wheelSensitivity: 0.22,
    })
    cyRef.current = cy

    cy.on('tap', 'node', (e) => {
      const n = e.target
      const kind = n.data('kind')
      const id = kind === 'card' ? (n.data('cardId') ?? n.id()) : n.id()
      setSelected({ type: kind === 'card' ? 'card' : 'concept', id })

      // 聚焦：邻域高亮，其余淡出
      cy.elements().addClass('dimmed')
      n.closedNeighborhood().removeClass('dimmed')
    })

    cy.on('tap', (e) => {
      if (e.target === cy) {
        setSelected(null)
        cy.elements().removeClass('dimmed')
      }
    })

    cy.on('dbltap', 'node', (e) => {
      const n = e.target
      if (n.data('kind') === 'card') {
        const id = n.data('cardId') ?? n.id()
        api.get<Card>(`/cards/${id}`).then(setCardDetail).catch(() => {})
      }
    })

    setTimeout(() => cy.fit(undefined, 44), 60)
    return () => {
      cy.destroy()
      cyRef.current = null
    }
  }, [elements])

  const reinforce = async (concept: string) => {
    if (!activeCourse) return
    setReinforcing(concept)
    try {
      const r = await api.post<{ course_id: string; title: string }>(
        `/graph/reinforce?course_id=${activeCourse}&concept=${encodeURIComponent(concept)}`,
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

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <header className="shrink-0 flex flex-wrap items-center gap-3 px-6 py-3 border-b border-[var(--border)]">
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">图谱</h1>

        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'overlay', label: '叠加', title: 'AI 概念图 + 我的卡片挂件' },
            { value: 'concepts', label: '概念图', title: '这个领域长什么样（客观）' },
            { value: 'cards', label: '问题图', title: '我怎么想的（主观）' },
          ]}
        />

        {view !== 'cards' && !!courses?.length && (
          <select
            value={activeCourse ?? ''}
            onChange={(e) => nav(`/graph/${e.target.value}`)}
            className="h-7 px-2 text-[12.5px] bg-[var(--bg-raised)] border border-[var(--border)] rounded-[var(--radius)] focus:outline-none focus:border-[var(--accent)] max-w-[240px]"
          >
            {courses.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title || c.topic}
              </option>
            ))}
          </select>
        )}

        <div className="grow" />

        {view !== 'cards' && overlay && (
          <span className="text-[12px] text-[var(--text-muted)]">
            覆盖率{' '}
            <b className="tabular-nums text-[var(--text)]">
              {Math.round(overlay.coverage * 100)}%
            </b>
            <span className="mx-1.5 opacity-40">·</span>
            {overlay.blank_spots.length} 块空白
          </span>
        )}

        <Button size="xs" variant="ghost" onClick={() => cyRef.current?.fit(undefined, 44)}>
          全览
        </Button>
      </header>

      <div className="grow min-h-0 flex">
        {/* 画布：深底，另一个空间 */}
        <div className="relative grow min-w-0" style={{ background: 'var(--graph-bg)' }}>
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Spinner className="size-5 text-white/40" />
            </div>
          ) : !elements.length ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center max-w-sm px-6">
                <div className="text-[14px] font-medium text-white/85">图还是空的</div>
                <div className="text-[13px] text-white/45 mt-2 leading-relaxed">
                  {view === 'cards'
                    ? '把卡片收进仓库后，它们就会出现在这里，连成你自己的问题网络。'
                    : '生成一节课的正文，AI 会顺手抽出这个领域的概念结构。'}
                </div>
              </div>
            </div>
          ) : null}
          <div ref={boxRef} className="absolute inset-0" />

          {/* 图例 */}
          <div className="absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1.5 text-[10.5px] text-white/45 max-w-[70%] pointer-events-none">
            {view === 'cards' ? (
              <>
                <Legend color="#5b6b8a" label="AI 原生卡" />
                <Legend color="#4e8f72" label="己见卡" ring />
                <Legend line="#d69a4a" label="正式关联" />
                <Legend line="rgba(160,165,180,0.6)" label="可能关联" dashed />
              </>
            ) : (
              <>
                <Legend color="#4a5a78" label="啃过的概念" square />
                <Legend color="#262b34" label="空白区" square dashed />
                {view === 'overlay' && <Legend color="#5b6b8a" label="我的卡片" />}
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
              <div className="flex gap-1.5 mt-3">
                <Badge tone={selectedConcept.card_count ? 'accent' : 'neutral'}>
                  {selectedConcept.card_count} 张卡
                </Badge>
                {selectedConcept.rewritten_count > 0 && (
                  <Badge tone="rewritten">{selectedConcept.rewritten_count} 己见</Badge>
                )}
              </div>

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

              {selectedConcept.section_id && (
                <Button
                  size="xs"
                  variant="outline"
                  className="mt-3 w-full"
                  onClick={() =>
                    nav(
                      `/courses/${selectedConcept.course_id}/sections/${selectedConcept.section_id}`,
                    )
                  }
                >
                  去读这一节
                </Button>
              )}
            </div>
          ) : view !== 'cards' && overlay?.blank_spots.length ? (
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
                        cy!.elements().addClass('dimmed')
                        n.closedNeighborhood().removeClass('dimmed')
                        cy!.animate({ center: { eles: n }, zoom: 1.1 }, { duration: 300 })
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
                title="点一个节点"
                hint={
                  view === 'cards'
                    ? '双击卡片节点可以看到完整内容。'
                    : '看看这个概念你提过几个问题。'
                }
              />
            </div>
          )}

          {view === 'cards' && (
            <div className="px-4 pb-4">
              <div className="text-[11px] text-[var(--text-subtle)] mb-2">关系类型</div>
              <div className="space-y-1">
                {Object.entries(RELATION_LABELS).map(([k, label]) => (
                  <div key={k} className="flex items-center gap-2 text-[11.5px] text-[var(--text-muted)]">
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

function Legend({
  color,
  line,
  label,
  ring,
  square,
  dashed,
}: {
  color?: string
  line?: string
  label: string
  ring?: boolean
  square?: boolean
  dashed?: boolean
}) {
  return (
    <span className="flex items-center gap-1.5">
      {line ? (
        <span
          className="w-4 h-0 shrink-0"
          style={{
            borderTop: `${dashed ? '1.5px dashed' : '2px solid'} ${line}`,
          }}
        />
      ) : (
        <span
          className={cn('size-2.5 shrink-0', square ? 'rounded-[2px]' : 'rounded-full')}
          style={{
            background: color,
            border: ring
              ? '1.5px solid #7fd4aa'
              : dashed
                ? '1px dashed rgba(255,255,255,0.3)'
                : undefined,
          }}
        />
      )}
      {label}
    </span>
  )
}
