import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape'
import { DARK, LIGHT, type GraphPalette } from '@/lib/graphTheme'
import type { ChapterBrief } from '@/lib/types'
import { useIsDark } from '@/lib/useTheme'
import { cn, truncate } from '@/lib/utils'

/**
 * 学习路径图 —— 课程页左栏。
 *
 * 每个方块是一个小节：一眼看到「这门课要学什么、我走到哪了」。
 *
 * ── 为什么不用 dagre 自动分层 ──────────────────────────────
 * 试过，结果没法看。一门课 28 个小节、20 多条依赖，dagre 按依赖拉出十几层，
 * 每层塞 2~4 个节点；容器只有 44% 屏宽，fit 之后缩放掉到 0.85 以下，
 * 标题字号变成 9px，再叠上一堆交叉的依赖边 —— 糊成一团。
 *
 * 所以这里改成**确定性网格**：一章一行，章内小节从左到右。
 * 位置完全可预测，永远不会重叠、不会乱。代价是层级不再由依赖决定，
 * 但对「知道要学什么 + 我的进度」这两个主要诉求，整齐远比拓扑精确重要。
 *
 * ── 依赖去哪了 ─────────────────────────────────────────────
 * 依赖边还在，但默认几乎透明。23 条边画在 28 个节点之间必然互相穿插，
 * 而它并不是打开课程时最需要的信息。
 * 悬停任意小节，它的**整条前置链**会亮起 —— 需要的时候一目了然，
 * 不需要的时候不添乱。
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
  prereqs: string[]
}

/**
 * 网格几何。节点尺寸固定，不用 'label' 自适应 —— 宽度一变行就参差不齐。
 *
 * 列宽按「一章最多 6 节」倒推：6 × 106 = 636px，正好落在左栏的可视宽度里
 * （半屏约 600~660px），于是 fit 基本不需要缩小，字号能保住 11px。
 * 放大到 6 列以上会开始缩放，那种课本来也该拆章了。
 */
const GRID = { colW: 106, rowH: 50, nodeW: 92, nodeH: 28 }

/** 三档状态。刻意复用图谱调色板的 blank / covered / owned ——
 *  语义正好对上（没碰过 → 读过 → 学完），视觉语言也和问题图保持一致。 */
function stateClass(s: ChapterBrief['sections'][number]): 'done' | 'ready' | 'pending' {
  if (s.completed) return 'done'
  return s.content_status === 'ready' ? 'ready' : 'pending'
}

const STATE_LABEL = { done: '已学完', ready: '已生成正文', pending: '还没开始' } as const

/**
 * 一章一行、章内从左到右的确定性坐标。
 * 抽出来是为了能单测：位置错乱是这张图最致命的失效方式。
 */
export function sectionGridPositions(
  chapters: ChapterBrief[],
): Record<string, { x: number; y: number }> {
  const out: Record<string, { x: number; y: number }> = {}
  chapters.forEach((ch, ci) => {
    ch.sections.forEach((s, si) => {
      out[s.id] = { x: si * GRID.colW, y: ci * GRID.rowH }
    })
  })
  return out
}

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
        // 方块而不是圆：小节是「一个模块」，而且矩形才装得下标题
        shape: 'round-rectangle',
        label: 'data(label)',
        width: GRID.nodeW,
        height: GRID.nodeH,
        'border-width': 1.5,
        'font-size': 11,
        'font-family': 'Inter, PingFang SC, sans-serif',
        'text-valign': 'center',
        'text-halign': 'center',
        'text-max-width': GRID.nodeW - 12,
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
    // 前置链上的小节：悬停时和边一起亮起
    {
      selector: 'node.lit',
      style: { 'border-color': p.prerequisite, 'border-width': 2.5 } as never,
    },

    // ★ 依赖边默认近乎透明。20 多条边穿插在 28 个方块之间会毁掉整张图，
    //   而它不是打开课程时最需要的信息 —— 交给悬停按需点亮
    {
      selector: 'edge',
      style: {
        width: 1.2,
        'line-color': p.prerequisite,
        'curve-style': 'bezier',
        'control-point-step-size': 26,
        'target-arrow-shape': 'none',
        opacity: 0.11,
      } as never,
    },
    {
      selector: 'edge.lit',
      style: {
        width: 1.8,
        opacity: 0.95,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': p.prerequisite,
        'arrow-scale': 0.7,
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
    const pos = sectionGridPositions(chapters)
    const titleOf = new Map<string, string>()

    for (const ch of chapters) {
      for (const s of ch.sections) {
        ids.add(s.id)
        titleOf.set(s.id, s.title)
      }
    }

    for (const ch of chapters) {
      for (const s of ch.sections) {
        els.push({
          data: {
            id: s.id,
            label: `${ch.idx + 1}.${s.idx + 1} ${truncate(s.title, 5)}`,
            full: s.title,
            chapter: `第 ${ch.idx + 1} 章 · ${ch.title}`,
            summary: s.summary || '',
            prereqs: (s.prerequisite_ids ?? [])
              .filter((p) => ids.has(p))
              .map((p) => titleOf.get(p) ?? ''),
          },
          position: pos[s.id],
          classes: stateClass(s),
        })
      }
    }

    // 依赖边。不再需要「章间脊线」—— 行的顺序已经把章的推进讲清楚了
    const seen = new Set<string>()
    for (const ch of chapters) {
      for (const s of ch.sections) {
        for (const p of s.prerequisite_ids ?? []) {
          if (!ids.has(p) || p === s.id) continue
          const id = `d-${p}-${s.id}`
          if (seen.has(id)) continue
          seen.add(id)
          els.push({ data: { id, source: p, target: s.id } })
        }
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
    cy.fit(undefined, 24)
    // 放太大反而丑（一门只有几节的课会把方块拉成巨块），压在 1 以内
    if (cy.zoom() > 1) {
      cy.zoom(1)
      cy.center()
    }
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
        // 坐标是自己算好的，preset 直接用 —— 不跑任何自动布局
        layout: { name: 'preset' },
        minZoom: 0.25,
        maxZoom: 2,
        wheelSensitivity: 0.22,
      })
      cyRef.current = cy
      touchedRef.current = false

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
      // ★ 整条前置链亮起：「要学这一节，得先学完这些」
      n.predecessors().addClass('lit')
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
        prereqs: (n.data('prereqs') as string[]) ?? [],
      })
      box.style.cursor = 'pointer'
    })
    cy.on('mouseout', 'node', (e) => {
      e.target.removeClass('hovered')
      cy.elements().removeClass('lit')
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
          className="absolute z-10 pointer-events-none max-w-[250px] px-3 py-2 rounded-[10px] bg-[var(--bg-raised)] border border-[var(--border)]"
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
          <div className="flex items-center gap-1.5 mt-1.5 text-[11px] text-[var(--text-subtle)]">
            <span>{hover.state}</span>
            {!!hover.prereqs.length && (
              <>
                <span className="opacity-40">·</span>
                <span className="truncate">需先学：{hover.prereqs.join('、')}</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* 图例 + 全览。三种颜色不解释就是三种没意义的颜色 */}
      <div className="absolute bottom-2 left-2.5 right-2.5 flex items-end justify-between gap-2 pointer-events-none">
        <div className="flex flex-wrap gap-x-2.5 gap-y-1 text-[10px] text-[var(--text-subtle)]">
          <Chip fill="transparent" stroke="#aab8c8" dashed label="未开始" />
          <Chip fill="#bfdbfe" stroke="#60a5fa" label="读过" />
          <Chip fill="#a7f3d0" stroke="#10b981" label="学完" />
          <span className="opacity-70">悬停看前置</span>
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
