import { useEffect, useRef } from 'react'
import type { Resource } from '@/lib/types'
import { RESOURCE_KIND_LABEL } from '@/lib/types'
import { Spinner } from '@/components/ui'
import { cn } from '@/lib/utils'

/**
 * 生成过程的执行时间线。
 *
 * 大纲要跑一两分钟，中间还夹着联网检索。如果这段时间只给一个转圈，
 * 用户完全无法判断是在干活还是卡死了 —— 等待的痛苦几乎全部来自
 * 「不知道还要多久、不知道在做什么」，而不是时长本身。
 *
 * 所以把每一步都摆出来：在想什么、在搜什么、搜到了什么、已经定下哪几章。
 */

export interface ToolStep {
  name: string
  /** 给人看的查询词 */
  query: string
  state: 'running' | 'done' | 'error'
  detail?: string
  items?: Resource[]
}

interface Props {
  thinking: number
  /** 思维链原文（已由后端攒成段）。有它就直接摊开给用户看 */
  thinkingText?: string
  tools: ToolStep[]
  titles?: string[]
  className?: string
}

export default function RunTimeline({
  thinking,
  thinkingText = '',
  tools,
  titles = [],
  className,
}: Props) {
  const nothingYet = !thinking && !tools.length && !titles.length

  return (
    <div className={cn('space-y-2.5', className)}>
      {/* 推理模型先跑思维链再吐正文，这一段可能持续几十秒 */}
      {thinking > 0 && (
        <div>
          <Row
            icon={<span className="size-1.5 rounded-full bg-[var(--accent)] animate-pulse" />}
            text={
              <>
                <span className="text-[var(--text-muted)]">正在深入思考</span>
                <span className="mx-1 opacity-40">·</span>
                <span className="tabular-nums text-[var(--text-subtle)]">
                  {thinking.toLocaleString()} 字
                </span>
              </>
            }
          />
          {thinkingText && <ThinkingStream text={thinkingText} />}
        </div>
      )}

      {tools.map((t, i) => (
        <div key={`${t.query}-${i}`}>
          <Row
            icon={
              t.state === 'running' ? (
                <Spinner className="size-3 text-[var(--accent)]" />
              ) : t.state === 'error' ? (
                <svg viewBox="0 0 24 24" className="size-3 text-[var(--sem-danger)]" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              ) : (
                <svg viewBox="0 0 24 24" className="size-3 text-[var(--sem-ok)]" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <path d="m5 13 4 4L19 7" />
                </svg>
              )
            }
            text={
              <>
                <span className="text-[var(--text-muted)]">联网检索</span>
                <span className="mx-1 opacity-40">·</span>
                <span className="text-[var(--text)]">{t.query}</span>
              </>
            }
          />
          {t.detail && (
            <div className="ml-[18px] mt-1 text-[11.5px] text-[var(--text-subtle)]">
              {t.detail}
            </div>
          )}
          {/* 检索到的来源直接列出来，让用户当场判断可信度 */}
          {!!t.items?.length && (
            <div className="ml-[18px] mt-1.5 space-y-1">
              {t.items.slice(0, 4).map((r) => (
                <a
                  key={r.url}
                  href={r.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
                >
                  {r.authority === 2 && (
                    <span className="shrink-0 px-1 rounded-[3px] text-[9.5px] bg-[color-mix(in_oklch,var(--sem-ok)_16%,transparent)] text-[var(--sem-ok)]">
                      权威
                    </span>
                  )}
                  <span className="truncate">{r.title}</span>
                  <span className="shrink-0 opacity-55">{r.source}</span>
                </a>
              ))}
            </div>
          )}
        </div>
      ))}

      {titles.length > 0 && (
        <div>
          <Row
            icon={<Spinner className="size-3 text-[var(--accent)]" />}
            text={
              <>
                <span className="text-[var(--text-muted)]">正在规划结构</span>
                <span className="mx-1 opacity-40">·</span>
                <span className="tabular-nums">{titles.length}</span>
              </>
            }
          />
          <div className="ml-[18px] mt-1 space-y-0.5 max-h-[220px] overflow-y-auto">
            {titles.map((t, i) => (
              <div
                key={`${t}-${i}`}
                className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-subtle)] animate-fade-up"
              >
                <span className="size-1 rounded-full bg-[var(--border-strong)] shrink-0" />
                <span className="truncate">{t}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {nothingYet && (
        <Row
          icon={<Spinner className="size-3 text-[var(--accent)]" />}
          text={<span className="text-[var(--text-muted)]">正在连接模型…</span>}
        />
      )}
    </div>
  )
}

/** 思维链正文。淡一号、贴底滚，看着就是「它正在想」 */
function ThinkingStream({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null)

  // 永远贴着最新那句。思考是「正在发生」的事，让用户自己往下拖就毫无意义了
  useEffect(() => {
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
  }, [text])

  return (
    <div
      ref={ref}
      className={cn(
        'ml-[18px] mt-1.5 pl-2.5 border-l border-[var(--border)]',
        'max-h-[132px] overflow-y-auto',
        // 思维链是自然段夹换行，pre-wrap 保住它的呼吸感；
        // break-words 是防它甩出一串没有空格的长标识符把布局撑破
        'text-[11.5px] leading-[1.8] text-[var(--text-subtle)] whitespace-pre-wrap break-words',
      )}
    >
      {text}
    </div>
  )
}

function Row({ icon, text }: { icon: React.ReactNode; text: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-[12.5px]">
      <span className="size-3 grid place-items-center shrink-0">{icon}</span>
      {text}
    </div>
  )
}

/** 资料列表。课程页与讲解页共用 */
export function ResourceList({
  items,
  title = '参考资料',
  className,
}: {
  items: Resource[]
  title?: string
  className?: string
}) {
  if (!items.length) return null

  return (
    <div className={className}>
      <div className="flex items-baseline gap-2">
        <h2 className="text-[14px] font-semibold tracking-[-0.012em]">{title}</h2>
        <span className="text-[11.5px] text-[var(--text-subtle)]">
          AI 联网检索并核对过来源
        </span>
      </div>
      <div className="mt-3 space-y-1.5">
        {items.map((r) => (
          <a
            key={r.url}
            href={r.url}
            target="_blank"
            rel="noreferrer"
            className={cn(
              'block px-3 py-2.5 rounded-[var(--radius)] border border-[var(--border)]',
              'hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] transition-colors',
            )}
          >
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="px-1.5 py-[1px] rounded-[4px] text-[10px] bg-[var(--bg-sunken)] text-[var(--text-muted)] shrink-0">
                {RESOURCE_KIND_LABEL[r.kind] ?? '资料'}
              </span>
              {r.authority === 2 && (
                <span className="px-1.5 py-[1px] rounded-[4px] text-[10px] bg-[color-mix(in_oklch,var(--sem-ok)_16%,transparent)] text-[var(--sem-ok)] shrink-0">
                  权威来源
                </span>
              )}
              <span className="text-[13px] font-medium min-w-0 truncate">{r.title}</span>
            </div>
            {r.why && (
              <div className="text-[12px] text-[var(--text-muted)] mt-1 leading-relaxed line-clamp-2">
                {r.why}
              </div>
            )}
            {/* 来源域名一定要露出来：学习者要能自己判断这东西可不可信 */}
            <div className="text-[11px] text-[var(--text-subtle)] mt-1 truncate">{r.source}</div>
          </a>
        ))}
      </div>
    </div>
  )
}
