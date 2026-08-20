import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape'
import { DARK, LIGHT, type GraphPalette } from '@/lib/graphTheme'
import { runSectionTreeLayout } from '@/lib/graphLayout'
import type { ChapterBrief } from '@/lib/types'
import { useIsDark } from '@/lib/useTheme'
import { cn, truncate } from '@/lib/utils'

/**
 * 学习路径图 —— 课程页左栏。
 *
 * 每个方块是一个小节，箭头是前置依赖。这是学习者打开课程看到的第一样东西：
 * 「这门课要学什么、按什么顺序学、我已经走到哪了」。
 *
 * 与旧的 AI 概念图的关键区别：概念是从**正文**里抽取的，所以学之前一片空白；
 * 而小节和依赖在大纲阶段就全部就绪，一建课就能看到完整地图。
 */

interface Props {
  chapters: ChapterBrief[]
  activeId?: string
  onSelect: (sectionId: string) => void
  className?: string
}

interface Hover {
  x: number
  y: number
  title: string
  chapter: string
  summary?: string
  state: string
}

/** 三档状态。刻意复用图谱调色板里的 blank / covered / owned ——
 *  语义正好对上（没碰过 → 读过 → 学完），视觉语言也和问题图保持一致。 */
function stateClass(s: ChapterBrief['sections'][number]): 'done' | 'ready' | 'pending' {
  if (s.completed) return 'done'
  return s.content_status === 'ready' ? 'ready' : 'pending'
}

const STATE_LABEL = { done: '已学完', ready: '已生成正文', pending: '还没开始' } as const

function makeStyles(p: GraphPalette): cytoscape.StylesheetJson {
  const box = (f: { fill: string; stroke: string; text?: string }, extra: object = {}) => ({
    'background-color': f.fill,
    'border-color': f.stroke,
    color: f.text ?? p.text,
    ...extra,
  })

  return [
    {
      selector: 'node',
      style: {
        // 方块而不是圆：小节是「一个模块」，而且矩形能把标题放进去
        shape: 'round-rectangle',
        label: 'data(label)',
        width: 'label',
        height: 'label',
        padding: '7px',
        'border-width': 1.5,
        'font-size': 10.5,
        'font-family': 'Inter, PingFang SC, sans-serif',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-max-width': '124px',
        'text-wrap': 'ellipsis',
        // 点亮时有个短过渡，标记「学完」的那一下就有反馈了
        'transition-property': 'background-color, border-color, border-width',
        'transition-duration': 160,
      } as never,
    },
    { selector: 'node.pending', style: box(p.blank, { 'border-style': 'dashed' }) as never },
    { selector: 'node.ready', style: box(p.covered) as never },
    { selector: 'node.done', style: box(p.owned, { 'border-width': 2 }) as never },
    {
      selector: 'node.active',
      style: { 'border-color': p.selected, 'border-width': 3 } as never,
    },
    {
      selector: 'node.hovered',
      style: { 'border-color': p.hoverRing, 'border-width': 3 } as never,
    },

    {
      selector: 'edge',
      style: {
        width: 1.2,
        'curve-style': 'bezier',
        'target-arrow-shape': 'none',
        opacity: 0.9,
      } as never,
    },
    // 真实依赖：带箭头的实线，"必须先学"
    {
      selector: 'edge.dep',
      style: {
        'line-color': p.prerequisite,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': p.prerequisite,
        'arrow-scale': 0.7,
        width: 1.6,
      } as never,
    },
    // 章与章的推进：退到背景，它只是顺序，不是硬依赖
    {
      selector: 'edge.spine',
      style: {
        'line-color': p.partOf,
        'line-style': 'dashed',
        width: 1,
        opacity: 0.45,
      } as never,
    },
  ]
}

export default function SectionTree({ chapters, activeId, onSelect, className }: Props) {
  const boxRef = useRef<HTMLDivElement>(null)
  const cyRef = useRef<Core | null>(null)
  const touchedRef = useRef(false) // 用户手动缩放/拖动过就别再抢镜头
  const dark = useIsDark()
  const [hover, setHover] = useState<Hover | null>(null)
  const [renderError, setRenderError] = useState('')

  const elements: ElementDefinition[] = useMemo(() => {
    const els: ElementDefinition[] = []
    const ids = new Set<string>()

    for (const ch of chapters) {
      for (const s of ch.sections) {
        ids.add(s.id)
        els.push({
          data: {
            id: s.id,
            label: `${ch.idx + 1}.${s.idx + 1}  ${truncate(s.title, 16)}`,
            full: s.title,
            chapter: `第 ${ch.idx + 1} 章 · ${ch.title}`,
            summary: s.summary || '',
          },
          classes: stateClass(s),
        })
      }
    }

    const seen = new Set<string>()
    // 依赖边
    for (const ch of chapters) {
      for (const s of ch.sections) {
        for (const p of s.prerequisite_ids ?? []) {
          if (!ids.has(p) || p === s.id) continue
          const id = `d-${p}-${s.id}`
          if (seen.has(id)) continue
          seen.add(id)
          els.push({ data: { id, source: p, target: s.id }, classes: 'dep' })
        }
      }
    }
    // 章间脊线：上一章末节 → 本章那些「没有明确前置」的小节。
    //
    // 只连没有前置的，因为有前置的小节已经被依赖边定准了位置。而没有前置的
    // 如果一条边都不给，dagre 会把它一路顶到第一层 —— 第 5 章的小节混在
    // 第 1 章旁边，课程的推进感就彻底没了（模型给的依赖是稀疏的，
    // prompt 里明确要求「宁缺毋滥」，所以这种小节是多数而不是少数）。
    for (let i = 1; i < chapters.length; i++) {
      const prev = chapters[i - 1].sections
      if (!prev.length) continue
      const from = prev[prev.length - 1].id
      for (const s of chapters[i].sections) {
        if ((s.prerequisite_ids ?? []).some((p) => ids.has(p))) continue
        const id = `s-${from}-${s.id}`
        if (from === s.id || seen.has(id)) continue
        seen.add(id)
        els.push({ data: { id, source: from, target: s.id }, classes: 'spine' })
      }
    }

    return els
  }, [chapters])

  const nodeCount = useMemo(() => elements.filter((e) => !e.data.source).length, [elements])

  /** 结构签名：只有节点集合或依赖变了才重建图。
   *  学习状态（学完/已生成）单独走 class 更新 —— 否则每标记一节完成
   *  都要重建画布，视角被重置，用户刚拖好的位置全丢。 */
  const structureKey = useMemo(
    () =>
      chapters
        .map((ch) =>
          ch.sections.map((s) => `${s.id}>${(s.prerequisite_ids ?? []).join(',')}`).join('|'),
        )
        .join('||'),
    [chapters],
  )

  const fit = useCallback(() => {
    const cy = cyRef.current
    const box = boxRef.current
    if (!cy || !box || !cy.elements().length) return
    // 容器还没定稿时（flex 未完成布局，clientWidth/Height 为 0）调 fit，
    // cytoscape 会算出 zoom≈0 把节点缩到看不见 —— 比不 fit 更糟
    if (!box.clientWidth || !box.clientHeight) return
    cy.resize()
    cy.fit(undefined, 28)
    const z = cy.zoom()
    if (!isFinite(z) || z <= 0.02) {
      cy.zoom(1)
      cy.center()
    }
  }, [])

  // 建图（只在结构或主题变化时）
  useEffect(() => {
    const box = boxRef.current
    if (!box || !nodeCount) return
    setRenderError('')

    let cy: Core
    try {
      cy = cytoscape({
        container: box,
        elements,
        style: makeStyles(dark ? DARK : LIGHT),
        layout: { name: 'preset' },
        minZoom: 0.2,
        maxZoom: 2.5,
        wheelSensitivity: 0.22,
      })
      cyRef.current = cy
      touchedRef.current = false

      runSectionTreeLayout(cy)

      const bb = cy.elements().boundingBox()
      if (!isFinite(bb.x1) || !isFinite(bb.y2)) {
        throw new Error(`布局结果异常：${cy.nodes().length} 个节点`)
      }
      fit()
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : String(err))
      cyRef.current?.destroy()
      cyRef.current = null
      return
    }

    const raf = requestAnimationFrame(fit)

    cy.on('mousedown wheel', () => {
      touchedRef.current = true
    })

    cy.on('tap', 'node', (e) => onSelect(e.target.id()))

    cy.on('mouseover', 'node', (e) => {
      const n = e.target
      n.addClass('hovered')
      const pos = n.renderedPosition()
      setHover({
        x: pos.x,
        y: pos.y - (n.renderedHeight() / 2 + 8),
        title: n.data('full'),
        chapter: n.data('chapter'),
        summary: n.data('summary') || undefined,
        state: STATE_LABEL[
          (['done', 'ready', 'pending'] as const).find((c) => n.hasClass(c)) ?? 'pending'
        ],
      })
      box.style.cursor = 'pointer'
    })
    cy.on('mouseout', 'node', (e) => {
      e.target.removeClass('hovered')
      setHover(null)
      box.style.cursor = ''
    })
    cy.on('pan zoom drag', () => setHover(null))

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
    // elements 刻意不进依赖：它每次 render 都是新数组，
    // 真正决定要不要重建的是 structureKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [structureKey, nodeCount, dark, fit])

  // 学习状态 / 选中项：只更新 class，不重建画布（于是「点亮」有过渡动画）
  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.batch(() => {
      for (const ch of chapters) {
        for (const s of ch.sections) {
          const n = cy.getElementById(s.id)
          if (!n.length) continue
          n.removeClass('pending ready done active')
          n.addClass(stateClass(s))
          if (s.id === activeId) n.addClass('active')
        }
      }
    })
  }, [chapters, activeId])

  if (!nodeCount) return null

  return (
    <div className={cn('relative', className)} style={{ background: 'var(--graph-bg)' }}>
      {/* ★ 不能写 absolute inset-0：cytoscape 会往容器注入 position:relative，
          把 absolute 顶掉后 inset-0 只剩偏移不再拉伸，容器会塌成宽×0 */}
      <div ref={boxRef} className="size-full" />

      {renderError && (
        <div className="absolute inset-0 z-20 flex items-center justify-center px-6">
          <div className="text-center">
            <div className="text-[13px] font-medium">路径图渲染失败</div>
            <pre className="mt-1.5 text-[11.5px] text-[var(--text-muted)] whitespace-pre-wrap">
              {renderError}
            </pre>
          </div>
        </div>
      )}

      {hover && (
        <div
          className="absolute z-10 pointer-events-none max-w-[240px] px-3 py-2 rounded-[10px] bg-[var(--bg-raised)] border border-[var(--border)]"
          style={{
            left: hover.x,
            top: hover.y,
            transform: 'translate(-50%, -100%)',
            boxShadow: 'var(--shadow-pop)',
          }}
        >
          <div className="text-[12.5px] font-semibold leading-snug">{hover.title}</div>
          <div className="text-[11px] text-[var(--text-subtle)] mt-0.5">{hover.chapter}</div>
          {hover.summary && (
            <div className="text-[11.5px] text-[var(--text-muted)] mt-1 leading-relaxed line-clamp-3">
              {hover.summary}
            </div>
          )}
          <div className="text-[11px] text-[var(--text-subtle)] mt-1">{hover.state}</div>
        </div>
      )}

      {/* 图例 + 全览。图例是必须的：三种颜色不解释就是三种没意义的颜色 */}
      <div className="absolute bottom-2 left-2.5 right-2.5 flex items-end justify-between gap-2 pointer-events-none">
        <div className="flex flex-wrap gap-x-2.5 gap-y-1 text-[10px] text-[var(--text-subtle)]">
          <Chip fill="transparent" stroke="#aab8c8" dashed label="未开始" />
          <Chip fill="#bfdbfe" stroke="#60a5fa" label="读过" />
          <Chip fill="#a7f3d0" stroke="#10b981" label="学完" />
          <span className="opacity-70">箭头 = 前置</span>
        </div>
        <button
          onClick={() => {
            touchedRef.current = false
            fit()
          }}
          title="全览"
          className="pointer-events-auto size-6 grid place-items-center rounded-[6px] bg-[var(--bg-raised)] border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
        >
          <svg viewBox="0 0 16 16" className="size-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />
          </svg>
        </button>
      </div>
    </div>
  )
}

function Chip({
  fill,
  stroke,
  label,
  dashed,
}: {
  fill: string
  stroke: string
  label: string
  dashed?: boolean
}) {
  return (
    <span className="flex items-center gap-1">
      <span
        className="w-2.5 h-2 rounded-[3px] shrink-0"
        style={{
          background: fill,
          border: `1px ${dashed ? 'dashed' : 'solid'} ${stroke}`,
        }}
      />
      {label}
    </span>
  )
}
