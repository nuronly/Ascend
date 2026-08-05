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
import { type GraphView as View, runLayout } from '@/lib/graphLayout'

/**
 * 双图谱（PLAN §3.4）
 *
 * 三个视图人格不同，这是它们各自唯一该回答的问题：
 *   概念图 —— "这个领域长什么样、该按什么顺序学"（客观，不掺学习状态）
 *   问题图 —— "我追问出来的思考轨迹"（主观、有时间性）
 *   进度   —— "我啃到哪了、哪里还是空白"，空白区反向驱动学习
 *
 * 三者共用一套分层布局（见 lib/graphLayout），但骨架边不同 ——
 * 布局的语义就是视图的语义。
 *
 * 画布刻意用深底 —— 图谱是"另一个空间"，视觉上应该与阅读区有奇异感，
 * 强化"我在俯瞰自己的认知地图"的仪式感（PLAN §4.3.5）。
 */

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
      height: 'data(h)' as any,
      'text-valign': 'center',
      'text-margin-y': 0,
      'font-size': 10.5,
      padding: '6px' as any,
    },
  },

  // ── 叠加视图专属：概念节点自己就是进度条 ──────────────────
  // concepts 视图不着色（它讲的是"领域客观长什么样"，跟我啃没啃过无关），
  // 只有 overlay 才把学习状态叠上去 —— 两个视图的人格差异靠这个拉开。
  //
  //   厚度 = 提过几个问题（宽度留给标签，保证可读）
  //   颜色 = 有没有己见（背过 ≠ 想过，只有己见才算真啃下来）
  {
    selector: 'node.overlay.covered',
    style: {
      'background-color': '#44536b',
      'border-color': 'rgba(140,180,255,0.42)',
      'border-width': 1.5,
    },
  },
  // 有己见：绿调点亮 —— 这块是真属于你的
  {
    selector: 'node.overlay.owned',
    style: {
      'background-color': '#3d6d5a',
      'border-color': 'rgba(127,212,170,0.75)',
      'border-width': 1.8,
      color: 'rgba(240,255,248,0.95)',
    },
  },
  // 空白区：一个问题都没提过 —— 空心虚线，等你去点亮。
  //
  // ★ 这里踩过坑：曾用半透明深色填充（rgba(38,43,52,.55)）来表达"暗着"，
  //   叠在 --graph-bg 上算出来只有 5% 亮度差，边框又只有 .16 —— 结果一门
  //   还没提过问题的新课（覆盖率 0%）整张图集体隐形，看起来像加载失败。
  //   空白必须"看得见地空"：靠边框而不是靠填充来表达未完成。
  {
    selector: 'node.overlay.blank',
    style: {
      'background-color': 'rgba(255,255,255,0.05)',
      'border-style': 'dashed',
      'border-width': 1.5,
      'border-color': 'rgba(255,255,255,0.38)',
      color: 'rgba(214,218,228,0.72)',
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
  // 根卡 = 最初那个疑问，一条追问链的源头，值得被看见
  {
    selector: 'node.root',
    style: {
      'border-width': 1.5,
      'border-color': 'rgba(255,255,255,0.4)',
      'font-size': 10,
      color: 'rgba(235,238,245,0.92)',
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
  // ── 骨架边：决定层级，所以画成实线主干 ────────────────────
  // 前置：学习路径本身
  {
    selector: 'edge.prerequisite',
    style: {
      'line-color': 'rgba(150,180,255,0.34)',
      'target-arrow-shape': 'triangle',
      'target-arrow-color': 'rgba(150,180,255,0.4)',
      'arrow-scale': 0.7,
      width: 1.3,
      'curve-style': 'taxi',
      'taxi-direction': 'downward' as any,
      'taxi-turn': '50%' as any,
      'taxi-turn-min-distance': 8 as any,
    },
  },
  // 组成：整体 → 部分，比前置弱一档
  {
    selector: 'edge.part_of',
    style: {
      'line-color': 'rgba(255,255,255,0.2)',
      'target-arrow-shape': 'chevron' as any,
      'target-arrow-color': 'rgba(255,255,255,0.26)',
      'arrow-scale': 0.6,
      'curve-style': 'taxi',
      'taxi-direction': 'downward' as any,
      'taxi-turn': '50%' as any,
    },
  },
  // ── 非骨架边：不参与分层，退到背景当"横向提示" ──────────────
  {
    selector: 'edge.related',
    style: {
      'line-color': 'rgba(160,170,190,0.26)',
      'line-style': 'dashed',
      'curve-style': 'unbundled-bezier',
      'control-point-distance': 34 as any,
      'control-point-weight': 0.5 as any,
      opacity: 0.55,
    },
  },
  // 对照：易混淆，用紫红提醒"这两个别搞混"
  {
    selector: 'edge.contrast',
    style: {
      'line-color': 'rgba(198,138,186,0.4)',
      'line-style': 'dotted',
      width: 1.4,
      'curve-style': 'unbundled-bezier',
      'control-point-distance': 40 as any,
      'control-point-weight': 0.5 as any,
    },
  },
  // 追问链：结构性主干，箭头指向"往下追的那一层"
  {
    selector: 'edge.parent',
    style: {
      'line-color': 'rgba(255,255,255,0.22)',
      width: 1.2,
      'target-arrow-shape': 'triangle',
      'target-arrow-color': 'rgba(255,255,255,0.26)',
      'arrow-scale': 0.6,
      'curve-style': 'taxi',
      'taxi-direction': 'rightward' as any,
      'taxi-turn': '46%' as any,
      'taxi-turn-min-distance': 8 as any,
    },
  },
  // ★ real link：跨追问链的意外关联 —— 整个第二大脑最值钱的东西。
  //   用琥珀色 + 大弧线让它明显"飞越"树结构，而不是混进主干。
  {
    selector: 'edge.real',
    style: {
      'line-color': '#d69a4a',
      width: 1.8,
      opacity: 0.95,
      'curve-style': 'unbundled-bezier',
      'control-point-distance': 70 as any,
      'control-point-weight': 0.5 as any,
    },
  },
  // potential：冷灰虚线，"是问题，不是事实"
  {
    selector: 'edge.potential',
    style: {
      'line-color': 'rgba(160,165,180,0.4)',
      'line-style': 'dashed',
      width: 1,
      opacity: 0.5,
      'curve-style': 'unbundled-bezier',
      'control-point-distance': 55 as any,
      'control-point-weight': 0.5 as any,
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
          classes: cn('card', n.is_rewritten && 'rewritten', n.depth === 0 && 'root'),
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

    const isOverlay = view === 'overlay'
    for (const n of overlay.nodes) {
      // 叠加视图：把「提过几个问题」写进标签，省得还要点开才知道
      const label = truncate(n.label, 14) + (isOverlay && n.card_count ? `  ${n.card_count}` : '')
      els.push({
        data: {
          id: n.id,
          label,
          size: Math.max(60, Math.min(170, label.length * 11 + 22)),
          // 厚度 = 卡片数。宽度让给标签，保证任何时候都读得出概念名
          h: isOverlay ? 18 + Math.min(n.card_count, 6) * 2.4 : 18,
          kind: 'concept',
          count: n.card_count,
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
      els.push({
        data: { id: e.id, source: e.from, target: e.to },
        classes: e.relation,
      })
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
      layout: { name: 'preset' }, // 真正的布局在下面按视图分派
      minZoom: 0.2,
      maxZoom: 2.5,
      wheelSensitivity: 0.22,
    })
    cyRef.current = cy
    runLayout(cy, view)

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
  }, [elements, view])

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
  const conceptCards = (selectedConcept && overlay?.attachments[selectedConcept.id]) || []

  return (
    <div className="h-full flex flex-col">
      {/* 工具栏 */}
      <header className="shrink-0 flex flex-wrap items-center gap-3 px-6 py-3 border-b border-[var(--border)]">
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">图谱</h1>

        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'overlay', label: '进度', title: '这个领域我啃到哪了、哪里还是空白' },
            { value: 'concepts', label: '概念图', title: '这个领域长什么样、该按什么顺序学（客观）' },
            { value: 'cards', label: '问题图', title: '我追问出来的思考轨迹（主观）' },
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

        {/* 覆盖度只属于叠加视图 —— 概念图讲的是领域客观长什么样，与我啃没啃过无关 */}
        {view === 'overlay' && overlay && (
          <span className="flex items-center gap-2 text-[12px] text-[var(--text-muted)]">
            <span
              className="w-20 h-1 rounded-full overflow-hidden bg-[var(--bg-raised)] shrink-0"
              title={`${overlay.nodes.length - overlay.blank_spots.length} / ${overlay.nodes.length} 个概念提过问题`}
            >
              <span
                className="block h-full rounded-full transition-[width] duration-500"
                style={{
                  width: `${Math.round(overlay.coverage * 100)}%`,
                  background: 'var(--sem-rewritten, #4e8f72)',
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

          {/* 一门新课满屏虚线框时，得告诉用户这些框是干嘛的、怎么点亮 */}
          {view === 'overlay' && overlay?.nodes.length && overlay.coverage === 0 ? (
            <div className="absolute top-4 left-1/2 -translate-x-1/2 max-w-md px-4 text-center pointer-events-none">
              <div className="text-[13px] text-white/70">这门课你还没提过任何问题</div>
              <div className="text-[12px] text-white/40 mt-1 leading-relaxed">
                每个虚线框是一个概念。去读一节、划词提问，对应的框就会亮起来。
              </div>
            </div>
          ) : null}

          {/* 图例 */}
          <div className="absolute bottom-3 left-3 flex flex-wrap gap-x-3 gap-y-1.5 text-[10.5px] text-white/45 max-w-[70%] pointer-events-none">
            {view === 'cards' ? (
              <>
                <Legend color="#4e8f72" label="己见卡" ring />
                <Legend line="rgba(255,255,255,0.4)" label="追问链" />
                <Legend line="#d69a4a" label="正式关联" />
                <Legend line="rgba(160,165,180,0.6)" label="可能关联" lineStyle="dashed" />
                <span className="opacity-60">左→右 = 追问的深度</span>
              </>
            ) : view === 'overlay' ? (
              <>
                <Legend color="rgba(255,255,255,0.05)" label="空白" square dashed />
                <Legend color="#44536b" label="提过问题" square />
                <Legend color="#3d6d5a" label="有己见" square ring />
                <span className="opacity-60">厚度 = 提过几个问题</span>
              </>
            ) : (
              <>
                <Legend line="rgba(150,180,255,0.55)" label="前置" />
                <Legend line="rgba(255,255,255,0.4)" label="组成" />
                <Legend line="rgba(160,170,190,0.5)" label="相关" lineStyle="dashed" />
                <Legend line="rgba(198,138,186,0.7)" label="对照" lineStyle="dotted" />
                <span className="opacity-60">上→下 = 学习顺序</span>
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
              {/* 学习状态只在叠加视图出现，概念图保持"客观地图"的人格 */}
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

                  {/* 卡片不再挤进画布当节点，改在这里下钻 —— 画布只管结构，侧栏只管细节 */}
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
                                  ? 'bg-[var(--sem-rewritten,#4e8f72)]'
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
                    nav(
                      `/courses/${selectedConcept.course_id}/sections/${selectedConcept.section_id}`,
                    )
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
  lineStyle = 'solid',
}: {
  color?: string
  line?: string
  label: string
  ring?: boolean
  square?: boolean
  dashed?: boolean
  lineStyle?: 'solid' | 'dashed' | 'dotted'
}) {
  return (
    <span className="flex items-center gap-1.5">
      {line ? (
        <span
          className="w-4 h-0 shrink-0"
          style={{
            borderTop: `${lineStyle === 'solid' ? '2px' : '1.5px'} ${lineStyle} ${line}`,
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
                ? '1px dashed rgba(255,255,255,0.55)'
                : square
                  ? '1px solid rgba(140,180,255,0.4)'
                  : undefined,
          }}
        />
      )}
      {label}
    </span>
  )
}
