import { useMemo, useState } from 'react'
import type { ChapterBrief, SectionBrief } from '@/lib/types'
import { cn } from '@/lib/utils'

/**
 * 学习路径 —— 课程页左栏。
 *
 * 形状就是这门课的推进过程：一个阶段一个阶段往下走，阶段里是几个小节。
 * 学完一节点亮一块，一眼看到「学什么、走到哪了、下一步是哪」。
 *
 * ── 为什么不用 cytoscape ───────────────────────────────────
 * 前两版分别用 dagre 自动分层和确定性网格画在 canvas 上，都不好看。
 * 根因不是布局参数，是**载体选错了**：canvas 上文字会跟着 fit 一起缩放
 * （28 个小节挤在半屏里，字号掉到 9px），一章小节多了只能挤不能换行，
 * 纵向滚动还得靠拖拽。
 *
 * 换成 HTML 之后这些全都消失了：文字永远是 11.5px 清晰的，
 * 一章小节再多也会自动折行，阶段多了就是原生纵向滚动。
 * 依赖关系不画连线（20 多条线穿插在方块之间只会添乱），改成悬停时
 * 直接告诉你「需先学：XXX」—— 文字比连线准确得多。
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

/** 浮层宽度。写成常量是因为要用它做右边界避让 */
const TIP_W = 232

export default function SectionTree({ chapters, activeId, onSelect, className }: Props) {
  // ★ 浮层用 fixed + 实际坐标，不能用 absolute：这个容器是 overflow-y-auto，
  //   absolute 的浮层在靠底部的小节上会被直接裁掉一半
  const [hover, setHover] = useState<{ id: string; x: number; y: number } | null>(null)

  /** id → 小节 + 它所属的章 + 已翻好名字的前置列表 */
  const index = useMemo(() => {
    const titleOf = new Map<string, string>()
    for (const ch of chapters) {
      for (const s of ch.sections) titleOf.set(s.id, `${ch.idx + 1}.${s.idx + 1} ${s.title}`)
    }
    const m = new Map<string, { s: SectionBrief; ch: ChapterBrief; prereqs: string[] }>()
    for (const ch of chapters) {
      for (const s of ch.sections) {
        m.set(s.id, {
          s,
          ch,
          prereqs: (s.prerequisite_ids ?? [])
            .map((p) => titleOf.get(p))
            .filter((t): t is string => !!t),
        })
      }
    }
    return m
  }, [chapters])

  const total = useMemo(() => chapters.reduce((n, ch) => n + ch.sections.length, 0), [chapters])

  if (!total) return null

  const tip = hover ? index.get(hover.id) : undefined

  return (
    <div className={cn('overflow-y-auto', className)}>
      <div className="px-4 py-4 pb-10">
        {chapters.map((ch, ci) => {
          const done = ch.sections.filter((s) => s.completed).length
          const allDone = done === ch.sections.length && done > 0

          return (
            <div key={ch.id} className="relative">
              {/* 阶段之间的竖线：把「一个阶段接一个阶段」画出来。
                  最后一个阶段不画，否则线拖在下面成了断头路 */}
              {ci < chapters.length - 1 && (
                <span
                  className="absolute left-[10px] top-[22px] bottom-[-6px] w-[1.5px] bg-[var(--border)]"
                  aria-hidden
                />
              )}

              {/* ── 阶段头 ── */}
              <div className="relative flex items-center gap-2.5">
                <span
                  className={cn(
                    'relative z-10 size-5 shrink-0 grid place-items-center rounded-full',
                    'text-[10.5px] font-semibold tabular-nums transition-colors duration-200',
                    allDone
                      ? 'bg-[var(--sem-ok)] text-white'
                      : done > 0
                        ? 'bg-[var(--accent)] text-white'
                        : 'bg-[var(--bg-sunken)] border border-[var(--border-strong)] text-[var(--text-subtle)]',
                  )}
                >
                  {allDone ? (
                    <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m5 13 4 4L19 7" />
                    </svg>
                  ) : (
                    ch.idx + 1
                  )}
                </span>

                <span className="text-[12.5px] font-semibold tracking-[-0.01em] min-w-0 truncate">
                  {ch.title}
                </span>
                <span className="ml-auto shrink-0 text-[10.5px] text-[var(--text-subtle)] tabular-nums">
                  {done}/{ch.sections.length}
                </span>
              </div>

              {/* ── 阶段里的小节：自动折行，一章多少节都放得下 ── */}
              <div className="flex flex-wrap gap-1.5 ml-[30px] mt-2 mb-5">
                {ch.sections.map((s) => {
                  const st = stateOf(s)
                  const isNext = s.id === activeId
                  const hasPrereq = !!index.get(s.id)?.prereqs.length

                  return (
                    <button
                      key={s.id}
                      onClick={() => onSelect(s.id)}
                      onMouseEnter={(e) => {
                        const r = e.currentTarget.getBoundingClientRect()
                        setHover({ id: s.id, x: r.left, y: r.bottom + 6 })
                      }}
                      onMouseLeave={() => setHover(null)}
                      className={cn(
                        'flex items-center gap-1.5 max-w-[190px] px-2 py-[5px]',
                        'rounded-[7px] border text-left transition-all duration-200',
                        'hover:-translate-y-[1px]',
                        st === 'done' &&
                          'bg-[color-mix(in_oklch,var(--sem-ok)_13%,transparent)] border-[color-mix(in_oklch,var(--sem-ok)_45%,transparent)]',
                        st === 'ready' &&
                          'bg-[color-mix(in_oklch,var(--accent)_11%,transparent)] border-[color-mix(in_oklch,var(--accent)_38%,transparent)]',
                        st === 'pending' &&
                          'border-dashed border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
                        isNext && 'ring-2 ring-[var(--accent)] ring-offset-1 ring-offset-[var(--bg)]',
                      )}
                    >
                      <span className="font-mono text-[10px] text-[var(--text-subtle)] tabular-nums shrink-0">
                        {ch.idx + 1}.{s.idx + 1}
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
                      {/* 有前置的给个记号，提示这里悬停能看到依赖 */}
                      {hasPrereq && st !== 'done' && (
                        <span
                          className="size-1 rounded-full bg-[var(--text-subtle)] shrink-0 opacity-60"
                          aria-hidden
                        />
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}

        {/* 图例：三种状态不解释就是三种没意义的颜色 */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 ml-[30px] pt-3 border-t border-[var(--border)] text-[10px] text-[var(--text-subtle)]">
          <Chip label="未开始" />
          <Chip label="读过" tone="accent" />
          <Chip label="学完" tone="ok" />
          <span className="opacity-70">悬停看要点与前置</span>
        </div>
      </div>

      {/* 悬停浮层。标题在方块里会被截断，摘要和前置也只能在这儿说清楚 */}
      {tip && hover && (
        <div
          className="fixed z-50 px-3 py-2 rounded-[9px] bg-[var(--bg-raised)] border border-[var(--border)] shadow-[var(--shadow-pop)] pointer-events-none"
          style={{
            width: TIP_W,
            // 靠右侧的小节要往左避让，否则浮层会顶出窗口
            left: Math.max(8, Math.min(hover.x, window.innerWidth - TIP_W - 8)),
            top: hover.y,
          }}
        >
          <div className="text-[12px] font-semibold leading-snug">{tip.s.title}</div>
          <div className="text-[10.5px] text-[var(--text-subtle)] mt-0.5">
            第 {tip.ch.idx + 1} 章 · {tip.ch.title}
          </div>
          {tip.s.summary && (
            <div className="text-[11.5px] text-[var(--text-muted)] mt-1 leading-relaxed line-clamp-3">
              {tip.s.summary}
            </div>
          )}
          <div className="text-[10.5px] text-[var(--text-subtle)] mt-1.5">
            {STATE_LABEL[stateOf(tip.s)]}
            {tip.s.id === activeId && ' · 下一步'}
            {tip.s.card_count > 0 && ` · ${tip.s.card_count} 张卡`}
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
