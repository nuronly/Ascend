import { useMemo, useState } from 'react'
import type { ChapterBrief, SectionBrief } from '@/lib/types'
import { NODE_H, NODE_W, computeTreeLayout } from '@/lib/treeLayout'
import { cn } from '@/lib/utils'

/**
 * 学习路径树 —— 课程页左栏。
 *
 * 从上往下一层一层走，箭头是前置依赖：分叉表示「学完这个可以往两个方向走」，
 * 汇聚表示「这几样都懂了才能学下一个」。学完一节点亮一块。
 *
 * ── 为什么是 HTML + SVG，而不是 cytoscape ───────────────────
 * 前两版画在 canvas 上，都不好看，反复调参之后确认根因是载体：
 * canvas 上文字跟着 fit 一起缩放（28 个小节挤进半屏，字号掉到 9px），
 * 节点多了只能挤，滚动还得靠拖拽。
 *
 * 拆开之后各归其位：分层与同层排序是纯计算（lib/treeLayout），
 * 节点用 HTML（文字永远清晰、能放完整标题），连线用 SVG（贝塞尔曲线，
 * 汇聚处并成一束）。容器双向原生滚动。
 */

interface Props {
  chapters: ChapterBrief[]
  activeId?: string
  onSelect: (sectionId: string) => void
  className?: string
}

type State = 'done' | 'ready' | 'pending'

function stateOf(s: SectionBrief): State {
  if (s.completed) return 'done'
  return s.content_status === 'ready' ? 'ready' : 'pending'
}

const STATE_LABEL: Record<State, string> = {
  done: '已学完',
  ready: '已生成正文',
  pending: '还没开始',
}

const TIP_W = 232
const PAD = 18

export default function SectionTree({ chapters, activeId, onSelect, className }: Props) {
  // ★ 浮层用 fixed + 实际坐标，不能用 absolute：容器是滚动容器，
  //   absolute 浮层在靠底部的节点上会被裁掉一半
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)

  const layout = useMemo(() => computeTreeLayout(chapters), [chapters])

  /** id → 小节 / 所属章 / 已翻成名字的前置。浮层和高亮都要用 */
  const index = useMemo(() => {
    const titleOf = new Map<string, string>()
    for (const n of layout.nodes) {
      titleOf.set(n.id, `${n.chapter.idx + 1}.${n.section.idx + 1} ${n.section.title}`)
    }
    const m = new Map<string, { node: (typeof layout.nodes)[number]; prereqs: string[] }>()
    for (const n of layout.nodes) {
      m.set(n.id, {
        node: n,
        prereqs: (n.section.prerequisite_ids ?? [])
          .map((p) => titleOf.get(p))
          .filter((t): t is string => !!t),
      })
    }
    return m
  }, [layout])

  /** 悬停时点亮整条前置链（不只是直接前置）—— 「要学这一节，得先学完这些」 */
  const litIds = useMemo(() => {
    if (!hover) return new Set<string>()
    const parents = new Map<string, string[]>()
    for (const n of layout.nodes) {
      parents.set(
        n.id,
        (n.section.prerequisite_ids ?? []).filter((p) => index.has(p)),
      )
    }
    const out = new Set<string>([hover.id])
    const stack = [hover.id]
    while (stack.length) {
      for (const p of parents.get(stack.pop()!) ?? []) {
        if (out.has(p)) continue
        out.add(p)
        stack.push(p)
      }
    }
    return out
  }, [hover, layout, index])

  if (!layout.nodes.length) return null

  const tip = hover ? index.get(hover.id) : undefined

  return (
    <div className={cn('overflow-auto', className)}>
      <div
        className="relative"
        style={{
          width: layout.width + PAD * 2,
          height: layout.height + PAD * 2 + 34, // 给底部图例留位置
        }}
      >
        {/* ── 连线 ── */}
        <svg
          className="tree-edges absolute pointer-events-none"
          style={{ left: PAD, top: PAD, width: layout.width, height: layout.height }}
          width={layout.width}
          height={layout.height}
          aria-hidden
        >
          {layout.edges.map((e) => {
            // 只有当边的两端都在高亮链上时才算「这一条」被点亮，
            // 否则悬停一个节点会把它前置的所有旁支也一起点亮，反而更花
            const lit = litIds.has(e.from) && litIds.has(e.to)
            return (
              <path
                key={e.id}
                d={e.d}
                fill="none"
                stroke={lit ? 'var(--accent)' : 'var(--border-strong)'}
                strokeWidth={lit ? 1.8 : 1.1}
                opacity={hover ? (lit ? 1 : 0.25) : 0.75}
                className="transition-all duration-150"
              />
            )
          })}
        </svg>

        {/* ── 节点 ── */}
        {layout.nodes.map((n) => {
          const s = n.section
          const st = stateOf(s)
          const isNext = s.id === activeId
          const lit = litIds.has(s.id)
          const dim = !!hover && !lit

          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              onMouseEnter={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setHover({ id: s.id, x: r.left, y: r.bottom + 6 })
              }}
              onMouseLeave={() => setHover(null)}
              style={{ left: n.x + PAD, top: n.y + PAD, width: NODE_W, height: NODE_H }}
              className={cn(
                'absolute flex items-center gap-1.5 px-2 rounded-[7px] border text-left',
                'transition-all duration-150',
                st === 'done' &&
                  'bg-[color-mix(in_oklch,var(--sem-ok)_13%,transparent)] border-[color-mix(in_oklch,var(--sem-ok)_45%,transparent)]',
                st === 'ready' &&
                  'bg-[color-mix(in_oklch,var(--accent)_11%,transparent)] border-[color-mix(in_oklch,var(--accent)_38%,transparent)]',
                st === 'pending' && 'bg-[var(--bg)] border-dashed border-[var(--border-strong)]',
                isNext && 'ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-[var(--bg-sunken)]',
                lit && 'border-[var(--accent)]',
                dim && 'opacity-35',
              )}
            >
              <span className="font-mono text-[10px] text-[var(--text-subtle)] tabular-nums shrink-0">
                {n.chapter.idx + 1}.{s.idx + 1}
              </span>
              <span
                className={cn(
                  'text-[11.5px] leading-tight min-w-0 truncate',
                  st === 'done' ? 'text-[var(--text-muted)]' : 'text-[var(--text)]',
                )}
              >
                {s.title}
              </span>
              {st === 'done' && (
                <svg viewBox="0 0 24 24" className="size-3 shrink-0 text-[var(--sem-ok)]" fill="none" stroke="currentColor" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 13 4 4L19 7" />
                </svg>
              )}
            </button>
          )
        })}

        {/* ── 图例 ── 三种状态不解释就是三种没意义的颜色 */}
        <div
          className="absolute flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[var(--text-subtle)]"
          style={{ left: PAD, top: layout.height + PAD + 12 }}
        >
          <Chip label="未开始" />
          <Chip label="读过" tone="accent" />
          <Chip label="学完" tone="ok" />
          <span className="opacity-70">连线 = 前置 · 悬停看整条链</span>
        </div>
      </div>

      {/* 悬停浮层：标题在节点里会被截断，要点和前置也只能在这儿说清楚 */}
      {tip && hover && (
        <div
          className="fixed z-50 px-3 py-2 rounded-[9px] bg-[var(--bg-raised)] border border-[var(--border)] shadow-[var(--shadow-pop)] pointer-events-none"
          style={{
            width: TIP_W,
            left: Math.max(8, Math.min(hover.x, window.innerWidth - TIP_W - 8)),
            top: hover.y,
          }}
        >
          <div className="text-[12px] font-semibold leading-snug">{tip.node.section.title}</div>
          <div className="text-[10.5px] text-[var(--text-subtle)] mt-0.5">
            第 {tip.node.chapter.idx + 1} 章 · {tip.node.chapter.title}
          </div>
          {tip.node.section.summary && (
            <div className="text-[11.5px] text-[var(--text-muted)] mt-1 leading-relaxed line-clamp-3">
              {tip.node.section.summary}
            </div>
          )}
          <div className="text-[10.5px] text-[var(--text-subtle)] mt-1.5">
            {STATE_LABEL[stateOf(tip.node.section)]}
            {tip.node.section.id === activeId && ' · 下一步'}
            {tip.node.section.card_count > 0 && ` · ${tip.node.section.card_count} 张卡`}
          </div>
          {!!tip.prereqs.length && (
            <div className="text-[10.5px] text-[var(--text-muted)] mt-1.5 pt-1.5 border-t border-[var(--border)] leading-relaxed">
              需先学：{tip.prereqs.join('、')}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function Chip({ label, tone }: { label: string; tone?: 'accent' | 'ok' }) {
  return (
    <span className="flex items-center gap-1">
      <span
        className={cn(
          'w-3 h-[9px] rounded-[3px] shrink-0 border',
          tone === 'ok' &&
            'bg-[color-mix(in_oklch,var(--sem-ok)_13%,transparent)] border-[color-mix(in_oklch,var(--sem-ok)_45%,transparent)]',
          tone === 'accent' &&
            'bg-[color-mix(in_oklch,var(--accent)_11%,transparent)] border-[color-mix(in_oklch,var(--accent)_38%,transparent)]',
          !tone && 'border-dashed border-[var(--border-strong)]',
        )}
      />
      {label}
    </span>
  )
}
