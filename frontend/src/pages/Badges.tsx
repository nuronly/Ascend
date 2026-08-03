import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { toast } from '@/lib/store'
import { Badge as Chip, Empty, Progress, Spinner } from '@/components/ui'
import { cn, relativeTime } from '@/lib/utils'

/**
 * 勋章墙（PLAN §3.7）
 *
 * 条件刻意不只看「学完」—— 完成类只是入场券，
 * 真正值钱的是己见率、追问深度、手建关联这些「你确实想过」的证据。
 *
 * 生图是异步的：达成即刻上墙（先用兜底图案），图好了自动替换。
 */

interface EarnedBadge {
  id: string
  code: string
  kind: string
  kind_label: string
  title: string
  description: string
  image_url: string | null
  image_status: 'pending' | 'generating' | 'ready' | 'failed'
  earned_at: string
  progress: { done: number; target: number; ratio: number }
}

interface LockedBadge {
  code: string
  kind: string
  kind_label: string
  title: string
  description: string
  progress: { done: number; target: number; ratio: number }
}

const KIND_ORDER = ['completion', 'depth', 'persistence', 'exploration']
const KIND_HINT: Record<string, string> = {
  completion: '走完了多少路',
  depth: '想得有多深 —— 这一类最难拿',
  persistence: '有没有一直在',
  exploration: '往未知里探了多远',
}

/**
 * 兜底图案：生图失败时用 code 的哈希确定性地画一个几何徽章。
 * 同一枚勋章永远长同一个样子，不会每次刷新都变。
 */
function FallbackMedal({ code, size = 96 }: { code: string; size?: number }) {
  let h = 0
  for (let i = 0; i < code.length; i++) h = (h * 31 + code.charCodeAt(i)) >>> 0

  const spokes = 5 + (h % 7)
  const inner = 0.34 + ((h >> 3) % 5) * 0.06
  const rot = (h >> 6) % 360
  const hue = 200 + ((h >> 9) % 60)
  const r = size / 2
  const pts: string[] = []
  for (let i = 0; i < spokes * 2; i++) {
    const rad = (Math.PI * i) / spokes + (rot * Math.PI) / 180
    const rr = r * (i % 2 === 0 ? 0.62 : inner + 0.2)
    pts.push(`${r + Math.cos(rad) * rr},${r + Math.sin(rad) * rr}`)
  }

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="size-full">
      <defs>
        <radialGradient id={`g-${code}`}>
          <stop offset="0%" stopColor={`hsl(${hue} 22% 32%)`} />
          <stop offset="100%" stopColor={`hsl(${hue} 18% 18%)`} />
        </radialGradient>
      </defs>
      <circle cx={r} cy={r} r={r * 0.94} fill={`url(#g-${code})`} />
      <circle
        cx={r}
        cy={r}
        r={r * 0.86}
        fill="none"
        stroke={`hsl(${hue} 30% 62% / 0.35)`}
        strokeWidth={size * 0.012}
      />
      <polygon points={pts.join(' ')} fill={`hsl(${hue} 34% 68% / 0.5)`} />
      <circle cx={r} cy={r} r={r * inner * 0.6} fill={`hsl(${hue} 40% 78% / 0.8)`} />
    </svg>
  )
}

function Medal({ b }: { b: EarnedBadge }) {
  const generating = b.image_status === 'pending' || b.image_status === 'generating'
  return (
    <div className="relative size-full">
      {b.image_url && b.image_status === 'ready' ? (
        <img
          src={b.image_url}
          alt={b.title}
          className="size-full object-cover rounded-full"
          loading="lazy"
        />
      ) : (
        <FallbackMedal code={b.code} />
      )}
      {generating && (
        <div className="absolute inset-0 flex items-center justify-center rounded-full bg-black/45 backdrop-blur-[1px]">
          <Spinner className="size-4 text-white/80" />
        </div>
      )}
    </div>
  )
}

export default function BadgesPage() {
  const qc = useQueryClient()
  const [celebrate, setCelebrate] = useState<string[]>([])

  const { data, isLoading } = useQuery({
    queryKey: ['badges'],
    queryFn: () =>
      api.get<{
        earned: EarnedBadge[]
        locked: LockedBadge[]
        fresh: string[]
        stats: Record<string, number>
        total: number
      }>('/badges'),
    // 生图在后台跑，轮询到全部就绪为止
    refetchInterval: (q) => {
      const d = q.state.data
      if (!d) return false
      return d.earned.some((b) => b.image_status === 'pending' || b.image_status === 'generating')
        ? 4000
        : false
    },
  })

  useEffect(() => {
    if (data?.fresh?.length) {
      setCelebrate(data.fresh)
      toast.ok(`解锁 ${data.fresh.length} 枚新勋章`)
      const t = setTimeout(() => setCelebrate([]), 6000)
      return () => clearTimeout(t)
    }
  }, [data?.fresh])

  const retry = async (id: string) => {
    await api.post(`/badges/${id}/retry-image`).catch(() => {})
    qc.invalidateQueries({ queryKey: ['badges'] })
  }

  if (isLoading) {
    return (
      <div className="max-w-[900px] mx-auto px-8 py-10">
        <div className="skeleton h-7 w-32" />
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-5 mt-8">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="skeleton aspect-square rounded-full" />
          ))}
        </div>
      </div>
    )
  }

  const earned = data?.earned ?? []
  const locked = data?.locked ?? []

  return (
    <div className="max-w-[900px] w-full mx-auto px-8 py-10 pb-24">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.018em]">勋章墙</h1>
          <p className="text-[13px] text-[var(--text-muted)] mt-1.5 leading-relaxed max-w-[52ch]">
            条件不只看「学完」。真正难拿的是深度类 —— 它衡量的是你有没有用自己的话
            重新想过一遍。
          </p>
        </div>
        <div className="text-right shrink-0">
          <div className="text-[26px] font-semibold tabular-nums tracking-[-0.02em]">
            {earned.length}
            <span className="text-[15px] text-[var(--text-subtle)]">/{data?.total ?? 0}</span>
          </div>
          <div className="text-[11px] text-[var(--text-subtle)]">已解锁</div>
        </div>
      </div>

      {!earned.length && !locked.length ? (
        <Empty title="还没有可追的目标" />
      ) : (
        <>
          {/* 已获得 */}
          {!!earned.length && (
            <div className="mt-9">
              <h2 className="text-[13px] font-semibold mb-4">已获得</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-x-5 gap-y-7">
                {earned.map((b) => (
                  <div
                    key={b.id}
                    className={cn(
                      'group text-center',
                      celebrate.includes(b.code) && 'animate-pop-in',
                    )}
                  >
                    <div
                      className={cn(
                        'relative aspect-square rounded-full overflow-hidden mx-auto max-w-[130px]',
                        'ring-1 ring-[var(--border)] transition-all',
                        'group-hover:ring-2 group-hover:ring-[var(--accent)]/40',
                        celebrate.includes(b.code) &&
                          'ring-2 ring-[var(--sem-real)] shadow-[0_0_28px_-4px_var(--sem-real)]',
                      )}
                    >
                      <Medal b={b} />
                    </div>
                    <div className="text-[13px] font-medium mt-2.5">{b.title}</div>
                    <div className="text-[11px] text-[var(--text-subtle)] mt-0.5">
                      {b.kind_label} · {relativeTime(b.earned_at)}
                    </div>
                    <div className="text-[11.5px] text-[var(--text-muted)] mt-1.5 leading-relaxed line-clamp-2 px-1">
                      {b.description}
                    </div>
                    {b.image_status === 'failed' && (
                      <button
                        onClick={() => retry(b.id)}
                        className="mt-1.5 text-[11px] text-[var(--accent)] hover:underline"
                      >
                        重新生成图案
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 未解锁：按接近程度排序，给一点"就差一点"的推力 */}
          {!!locked.length && (
            <div className="mt-12">
              <h2 className="text-[13px] font-semibold mb-1">还差一点</h2>
              <p className="text-[12px] text-[var(--text-muted)] mb-4">按接近程度排序</p>

              {KIND_ORDER.map((kind) => {
                const group = locked.filter((b) => b.kind === kind)
                if (!group.length) return null
                return (
                  <div key={kind} className="mt-6 first:mt-0">
                    <div className="flex items-baseline gap-2 mb-2.5">
                      <span className="text-[12.5px] font-medium">{group[0].kind_label}</span>
                      <span className="text-[11px] text-[var(--text-subtle)]">
                        {KIND_HINT[kind]}
                      </span>
                    </div>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {group.map((b) => (
                        <div
                          key={b.code}
                          className="flex items-center gap-3 px-3 py-2.5 border border-[var(--border)] rounded-[var(--radius-lg)]"
                        >
                          <div className="size-10 shrink-0 rounded-full overflow-hidden opacity-25 grayscale">
                            <FallbackMedal code={b.code} size={40} />
                          </div>
                          <div className="min-w-0 grow">
                            <div className="flex items-baseline gap-2">
                              <span className="text-[13px] font-medium truncate">{b.title}</span>
                              <span className="text-[11px] text-[var(--text-subtle)] tabular-nums shrink-0 ml-auto">
                                {b.progress.done}/{b.progress.target}
                              </span>
                            </div>
                            <div className="text-[11.5px] text-[var(--text-muted)] mt-0.5 line-clamp-1">
                              {b.description}
                            </div>
                            <Progress value={b.progress.ratio} className="mt-2" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* 关键指标 */}
      {!!data?.stats && (
        <div className="mt-12 pt-6 border-t border-[var(--border)]">
          <div className="flex flex-wrap gap-x-8 gap-y-4">
            {[
              ['已沉淀卡片', data.stats.vaulted],
              ['己见卡', data.stats.rewritten],
              ['最深追问', (data.stats.max_depth ?? 0) + 1 + ' 层'],
              ['手建关联', data.stats.real_links],
              ['连续天数', data.stats.streak],
              ['番茄总数', data.stats.pomodoros],
              ['覆盖概念', data.stats.concepts],
            ].map(([label, v]) => (
              <div key={String(label)}>
                <div className="text-[11px] text-[var(--text-subtle)]">{label}</div>
                <div className="text-[17px] font-semibold tabular-nums tracking-[-0.015em]">
                  {v}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Chip tone="rewritten">
              己见率 {Math.round((data.stats.rewrite_rate ?? 0) * 100)}%
            </Chip>
            <span className="text-[11.5px] text-[var(--text-subtle)]">
              比学习时长诚实得多的指标
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
