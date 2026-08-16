import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Card, VaultOverview } from '@/lib/types'
import { Badge, Button, Empty, Input, Modal, Segmented } from '@/components/ui'
import { Markdown } from '@/components/Markdown'
import { cn, relativeTime, futureTime, truncate } from '@/lib/utils'
import { toast } from '@/lib/store'

type Tab = 'vault' | 'draft' | 'orphans'

export default function VaultPage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('vault')
  const [q, setQ] = useState('')
  const [rewrittenOnly, setRewrittenOnly] = useState(false)
  const [sort, setSort] = useState<'recent' | 'touched' | 'depth'>('recent')
  const [detail, setDetail] = useState<Card | null>(null)

  const { data: overview } = useQuery({
    queryKey: ['vault-overview'],
    queryFn: () => api.get<VaultOverview>('/vault/overview'),
  })

  const { data, isFetching } = useQuery<{ total?: number; cards: Card[]; hint?: string }>({
    queryKey: ['vault', tab, q, rewrittenOnly, sort],
    queryFn: () => {
      if (tab === 'orphans') return api.get<{ cards: Card[]; hint: string }>('/vault/orphans')
      const p = new URLSearchParams({
        state: tab === 'vault' ? 'vault' : 'draft',
        sort,
        limit: '100',
      })
      if (q.trim()) p.set('q', q.trim())
      if (rewrittenOnly) p.set('rewritten', 'true')
      return api.get<{ total: number; cards: Card[] }>(`/vault?${p}`)
    },
    placeholderData: keepPreviousData,
  })

  const cards = data?.cards ?? []

  const openDetail = async (c: Card) => {
    const full = await api.get<Card>(`/cards/${c.id}`).catch(() => c)
    setDetail(full)
  }

  const remove = async (id: string) => {
    if (!confirm('删除这张卡？它的子卡会一并删除。')) return
    await api.del(`/cards/${id}`)
    setDetail(null)
    qc.invalidateQueries({ queryKey: ['vault'] })
    qc.invalidateQueries({ queryKey: ['vault-overview'] })
    toast.ok('已删除')
  }

  const vault = async (id: string) => {
    await api.post(`/cards/${id}/vault`)
    qc.invalidateQueries({ queryKey: ['vault'] })
    qc.invalidateQueries({ queryKey: ['vault-overview'] })
    toast.ok('已收进仓库')
  }

  return (
    <div className="max-w-[1000px] w-full mx-auto px-8 py-10 pb-24">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.018em]">灵感仓库</h1>
          <p className="text-[13px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
            这些卡片是你的核心资产 —— 别处拿不到，也无法迁移复制。
          </p>
        </div>
        <div className="flex gap-1.5 shrink-0">
          <Button size="sm" variant="ghost" onClick={() => window.open('/api/export/markdown')}>
            导出 Markdown
          </Button>
          <Button size="sm" variant="ghost" onClick={() => window.open('/api/export/json')}>
            导出 JSON
          </Button>
        </div>
      </div>

      {/* 概览 */}
      {!!overview?.total && (
        <div className="mt-6 flex flex-wrap gap-x-8 gap-y-3">
          {[
            { label: '总卡片', v: overview.total },
            { label: '已沉淀', v: overview.vaulted },
            { label: '未整理', v: overview.drafts },
            {
              label: '己见率',
              v: `${Math.round(overview.rewrite_rate * 100)}%`,
              tip: '写过自己理解的比例 —— 比学习时长诚实得多',
              accent: true,
            },
            { label: '手建关联', v: overview.real_links },
          ].map((s) => (
            <div key={s.label} title={s.tip}>
              <div className="text-[11px] text-[var(--text-subtle)]">{s.label}</div>
              <div
                className={cn(
                  'text-[19px] font-semibold tabular-nums tracking-[-0.02em]',
                  s.accent && 'text-[var(--sem-rewritten)]',
                )}
              >
                {s.v}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 高频概念 */}
      {!!overview?.top_concepts?.length && (
        <div className="mt-6 flex flex-wrap gap-1.5">
          {overview.top_concepts.slice(0, 14).map((c) => (
            <button
              key={c.name}
              onClick={() => {
                setQ(c.name)
                setTab('vault')
              }}
              className="h-6 px-2 text-[11.5px] rounded-full border border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)] transition-colors"
            >
              {c.name}
              <span className="ml-1 opacity-50 tabular-nums">{c.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* 工具栏 */}
      <div className="mt-8 flex flex-wrap items-center gap-2 sticky top-0 z-10 bg-[var(--bg)] py-2 -my-2">
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'vault', label: '已沉淀' },
            { value: 'draft', label: '未整理' },
            { value: 'orphans', label: '孤岛卡' },
          ]}
        />
        {tab !== 'orphans' && (
          <>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索卡片…"
              className="w-56 h-7 text-[12.5px]"
            />
            <button
              onClick={() => setRewrittenOnly((v) => !v)}
              className={cn(
                'h-7 px-2.5 text-[12px] rounded-[var(--radius)] border transition-colors',
                rewrittenOnly
                  ? 'border-[var(--sem-rewritten)] text-[var(--sem-rewritten)] bg-[color-mix(in_oklch,var(--sem-rewritten)_10%,transparent)]'
                  : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]',
              )}
            >
              仅己见卡
            </button>
            <Segmented
              size="xs"
              value={sort}
              onChange={setSort}
              options={[
                { value: 'recent', label: '最新' },
                { value: 'touched', label: '最近触碰' },
                { value: 'depth', label: '最深' },
              ]}
            />
          </>
        )}
        <div className="grow" />
        {isFetching && <span className="text-[11.5px] text-[var(--text-subtle)]">加载中…</span>}
      </div>

      {tab === 'orphans' && cards.length > 0 && (
        <div className="mt-4 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[var(--text-muted)] border border-dashed border-[var(--border-strong)] rounded-[var(--radius)]">
          这些卡长期没被碰过，也没有任何连线。归并到别的卡，或者删掉？
          <span className="opacity-70"> 拒绝坟场，就得定期清理。</span>
        </div>
      )}

      {/* 列表 */}
      <div className="mt-4">
        {!cards.length ? (
          <Empty
            title={
              tab === 'orphans'
                ? '没有孤岛卡'
                : tab === 'draft'
                  ? '没有未整理的卡'
                  : q
                    ? '没有匹配的卡片'
                    : '仓库还是空的'
            }
            hint={
              tab === 'orphans'
                ? '每张卡都有归属，很好。'
                : tab === 'vault' && !q
                  ? '去学一节课，划词提问，然后把有价值的卡收进来。'
                  : undefined
            }
          />
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {cards.map((c) => {
              const due = c.due_date ? new Date(c.due_date).getTime() <= Date.now() : false
              return (
                <button
                  key={c.id}
                  onClick={() => openDetail(c)}
                  className={cn(
                    'group text-left p-3.5 border rounded-[var(--radius-lg)] transition-colors',
                    'hover:bg-[var(--bg-hover)]',
                    c.is_rewritten
                      ? 'border-[var(--border)] border-l-2 border-l-[var(--sem-rewritten)]'
                      : 'border-[var(--border)]',
                    // 孤岛卡用「褪色」表达腐烂，不用颜色（颜色留给语义层）
                    tab === 'orphans' && 'opacity-55 hover:opacity-100',
                  )}
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[13.5px] font-medium text-[var(--accent)] truncate">
                      ⟨{c.selected_text || truncate(c.question, 20)}⟩
                    </span>
                    <div className="grow" />
                    {due && (
                      <Badge tone="due" className="shrink-0">
                        待复习
                      </Badge>
                    )}
                  </div>

                  <div className="text-[12.5px] text-[var(--text-muted)] mt-1.5 line-clamp-3 leading-relaxed">
                    {c.summary || c.question || truncate(c.ai_answer, 140)}
                  </div>

                  {!!c.concept_tags.length && (
                    <div className="flex flex-wrap gap-1 mt-2.5">
                      {c.concept_tags.slice(0, 4).map((t) => (
                        <span
                          key={String(t)}
                          className="px-1.5 h-[18px] inline-flex items-center rounded-[3px] bg-[var(--bg-sunken)] text-[10.5px] text-[var(--text-subtle)]"
                        >
                          {String(t)}
                        </span>
                      ))}
                    </div>
                  )}

                  <div className="flex items-center gap-2 mt-2.5 text-[10.5px] text-[var(--text-subtle)]">
                    {c.origin_info?.course_title && (
                      <>
                        <span className="truncate max-w-[45%]">{c.origin_info.course_title}</span>
                        <span className="opacity-40">·</span>
                      </>
                    )}
                    <span>{relativeTime(c.created_at)}</span>
                    {c.depth > 0 && (
                      <>
                        <span className="opacity-40">·</span>
                        <span>第 {c.depth + 1} 层</span>
                      </>
                    )}
                    {c.is_rewritten && (
                      <>
                        <span className="opacity-40">·</span>
                        <span className="text-[var(--sem-rewritten)]">己见</span>
                      </>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </div>

      {/* 详情 */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        width="max-w-2xl"
        title={detail ? `⟨${detail.selected_text || truncate(detail.question, 24)}⟩` : ''}
        subtitle={
          detail && (
            <span className="flex flex-wrap items-center gap-2">
              <span>{relativeTime(detail.created_at)}</span>
              {detail.origin_info?.section_title && (
                <>
                  <span className="opacity-40">·</span>
                  <span>{detail.origin_info.section_title}</span>
                </>
              )}
              {detail.due_date && (
                <>
                  <span className="opacity-40">·</span>
                  <span className="text-[var(--sem-due)]">
                    复习：{futureTime(detail.due_date)}
                  </span>
                </>
              )}
            </span>
          )
        }
        footer={
          detail && (
            <>
              <Button variant="danger" size="sm" onClick={() => remove(detail.id)}>
                删除
              </Button>
              <div className="grow" />
              {detail.state !== 'vault' && (
                <Button variant="primary" size="sm" onClick={() => vault(detail.id)}>
                  收进仓库
                </Button>
              )}
              {detail.origin_info?.course_id && detail.source_section_id && (
                <Button
                  size="sm"
                  onClick={() =>
                    nav(
                      `/courses/${detail.origin_info!.course_id}/sections/${detail.source_section_id}`,
                    )
                  }
                >
                  回到原文
                </Button>
              )}
            </>
          )
        }
      >
        {detail && (
          <div className="space-y-4">
            {detail.context_text && (
              <blockquote className="text-[12.5px] text-[var(--text-muted)] leading-relaxed border-l-2 border-[var(--border-strong)] pl-3">
                {detail.context_text}
              </blockquote>
            )}

            {(detail.messages ?? []).map((m) => (
              <div key={m.id} className="flex gap-2">
                <span
                  className={cn(
                    'shrink-0 text-[11px] font-semibold mt-[2px]',
                    m.role === 'user' ? 'text-[var(--text-subtle)]' : 'text-[var(--accent)]',
                  )}
                >
                  {m.role === 'user' ? 'Q' : 'A'}
                </span>
                <div className="min-w-0 grow">
                  {m.role === 'user' ? (
                    <div className="text-[13px] text-[var(--text-muted)]">{m.content}</div>
                  ) : (
                    <Markdown variant="card">{m.content}</Markdown>
                  )}
                </div>
              </div>
            ))}

            {detail.user_note && (
              <div>
                <div className="text-[11px] text-[var(--text-subtle)] mb-1">✎ 我的话</div>
                <div className="text-[13px] leading-relaxed whitespace-pre-wrap border-l-2 border-[var(--sem-rewritten)] pl-3 py-1 bg-[color-mix(in_oklch,var(--sem-rewritten)_6%,transparent)] rounded-r-[var(--radius-sm)]">
                  {detail.user_note}
                </div>
              </div>
            )}

            {!!detail.concept_tags.length && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {detail.concept_tags.map((t) => (
                  <Badge key={String(t)}>{String(t)}</Badge>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
