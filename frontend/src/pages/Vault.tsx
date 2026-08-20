import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Card, VaultOverview } from '@/lib/types'
import { Badge, Button, Empty, Input, Modal, Segmented } from '@/components/ui'
import { Markdown } from '@/components/Markdown'
import { cn, relativeTime, futureTime, truncate } from '@/lib/utils'
import { toast } from '@/lib/store'

/**
 * ★ 主界面是「笔记」，不是「卡片仓库」
 *
 * 卡片整理进仓库其实没人回来看，病因有四个：
 *   1. 粒度太碎 —— 一张卡是「一个疑问 + 一段回答」，脱离语境读不懂
 *   2. 卡片网格不是阅读单元 —— 那是数据库视图，人不会「浏览列表」
 *   3. 「归档」这个动作本身就是心理上的完结，天然不产生回访
 *   4. 它是**过程产物**而不是成果。把草稿箱当主界面，没人会天天翻
 *
 * 所以卡片降级为素材层（它仍然是划词追问的产物、问题图的节点、复习单元），
 * 主界面换成笔记 —— 一个真正能读、且有明确回访理由的单元。
 *
 * 分组按「课程 → 小节」而不是时间流：回访路径是「我要复习注意力那节」，
 * 不是「我三周前记了什么」。时间流适合日志，不适合知识。
 *
 * 「未消化的疑问」是卡片降级之后的安全阀：还没被任何笔记吸收的卡片有多少。
 * 它给用户一个明确的行动，而不是一个被藏起来的角落。
 */

type Tab = 'notes' | 'cards' | 'orphans'

interface NoteItem {
  card_id: string
  section_id: string
  title: string
  state: string
  edited: boolean
  excerpt: string
  cards: number
  updated_at: string | null
}

interface NoteGroup {
  course_id: string
  course_title: string
  sections_total: number
  notes: NoteItem[]
}

export default function VaultPage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const [tab, setTab] = useState<Tab>('notes')
  const [cardState, setCardState] = useState<'vault' | 'draft'>('vault')
  const [q, setQ] = useState('')
  const [rewrittenOnly, setRewrittenOnly] = useState(false)
  const [sort, setSort] = useState<'recent' | 'touched' | 'depth'>('recent')
  const [detail, setDetail] = useState<Card | null>(null)

  const { data: overview } = useQuery({
    queryKey: ['vault-overview'],
    queryFn: () => api.get<VaultOverview>('/vault/overview'),
  })

  /* ── 笔记：按课程分组 ── */
  const { data: notebook, isFetching: notesLoading } = useQuery({
    queryKey: ['notebook'],
    queryFn: () => api.get<{ groups: NoteGroup[]; undigested: number }>('/vault/notes'),
  })

  /* ── 疑问（卡片）：降级为素材视图 ── */
  const { data, isFetching } = useQuery<{ total?: number; cards: Card[]; hint?: string }>({
    queryKey: ['vault', tab, cardState, q, rewrittenOnly, sort],
    queryFn: () => {
      if (tab === 'orphans') return api.get<{ cards: Card[]; hint: string }>('/vault/orphans')
      const p = new URLSearchParams({ state: cardState, kind: 'card', sort, limit: '100' })
      if (q.trim()) p.set('q', q.trim())
      if (rewrittenOnly) p.set('rewritten', 'true')
      return api.get<{ total: number; cards: Card[] }>(`/vault?${p}`)
    },
    enabled: tab !== 'notes',
    placeholderData: keepPreviousData,
  })

  const cards = data?.cards ?? []
  const groups = notebook?.groups ?? []
  const noteTotal = groups.reduce((n, g) => n + g.notes.length, 0)

  const openDetail = async (id: string) => {
    const full = await api.get<Card>(`/cards/${id}`).catch(() => null)
    if (full) setDetail(full)
  }

  const remove = async (id: string) => {
    if (!confirm(detail?.kind === 'note' ? '删除这份笔记？' : '删除这张卡？它的子卡会一并删除。'))
      return
    await api.del(`/cards/${id}`)
    setDetail(null)
    qc.invalidateQueries({ queryKey: ['vault'] })
    qc.invalidateQueries({ queryKey: ['notebook'] })
    qc.invalidateQueries({ queryKey: ['vault-overview'] })
    toast.ok('已删除')
  }

  const vault = async (id: string) => {
    await api.post(`/cards/${id}/vault`)
    qc.invalidateQueries({ queryKey: ['vault'] })
    qc.invalidateQueries({ queryKey: ['notebook'] })
    qc.invalidateQueries({ queryKey: ['vault-overview'] })
    toast.ok('已沉淀')
  }

  return (
    <div className="max-w-[1000px] w-full mx-auto px-8 py-10 pb-24">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-[-0.018em]">笔记</h1>
          <p className="text-[13px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
            你学完每一节留下的东西 —— 别处拿不到，也无法迁移复制。
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

      {/* 概览：以笔记为主口径，「未消化的疑问」是可行动的那一个 */}
      {(noteTotal > 0 || !!overview?.total) && (
        <div className="mt-6 flex flex-wrap gap-x-8 gap-y-3">
          {[
            { label: '笔记', v: noteTotal },
            {
              label: '未消化的疑问',
              v: notebook?.undigested ?? 0,
              tip: '这些卡片所在的小节还没有笔记 —— 去把它们收成笔记',
              accent: (notebook?.undigested ?? 0) > 0,
              onClick: () => setTab('cards'),
            },
            {
              label: '己见率',
              v: `${Math.round((overview?.rewrite_rate ?? 0) * 100)}%`,
              tip: '写过自己理解的比例 —— 比学习时长诚实得多',
            },
            { label: '疑问总数', v: overview?.total ?? 0 },
            { label: '手建关联', v: overview?.real_links ?? 0 },
          ].map((s) => (
            <button
              key={s.label}
              title={s.tip}
              onClick={s.onClick}
              className={cn('text-left', s.onClick && 'cursor-pointer')}
            >
              <div className="text-[11px] text-[var(--text-subtle)]">{s.label}</div>
              <div
                className={cn(
                  'text-[19px] font-semibold tabular-nums tracking-[-0.02em]',
                  s.accent && 'text-[var(--sem-rewritten)]',
                )}
              >
                {s.v}
              </div>
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
            { value: 'notes', label: '笔记' },
            { value: 'cards', label: '疑问', title: '划词提问留下的卡片 —— 笔记的素材层' },
            { value: 'orphans', label: '孤岛卡' },
          ]}
        />
        {tab === 'cards' && (
          <>
            <Segmented
              size="xs"
              value={cardState}
              onChange={setCardState}
              options={[
                { value: 'vault', label: '已沉淀' },
                { value: 'draft', label: '未整理' },
              ]}
            />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索卡片…"
              className="w-52 h-7 text-[12.5px]"
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
        {(isFetching || notesLoading) && (
          <span className="text-[11.5px] text-[var(--text-subtle)]">加载中…</span>
        )}
      </div>

      {/* ── 笔记视图 ── */}
      {tab === 'notes' && (
        <div className="mt-5">
          {!groups.length ? (
            <Empty
              title="还没有笔记"
              hint="去学一节课，划词提问；学完在右栏点「生成本节笔记」，卡片和原文会汇成一张笔记卡。"
            />
          ) : (
            <div className="space-y-8">
              {groups.map((g) => (
                <section key={g.course_id}>
                  <div className="flex items-baseline gap-2.5">
                    <button
                      onClick={() => nav(`/courses/${g.course_id}`)}
                      className="text-[15px] font-semibold tracking-[-0.012em] hover:text-[var(--accent)] transition-colors"
                    >
                      {g.course_title}
                    </button>
                    <span className="text-[11.5px] text-[var(--text-subtle)] tabular-nums">
                      {g.notes.length}
                      {g.sections_total ? ` / ${g.sections_total}` : ''} 节有笔记
                    </span>
                  </div>

                  <div className="mt-2.5 space-y-1.5">
                    {g.notes.map((n) => (
                      <button
                        key={n.card_id}
                        onClick={() => openDetail(n.card_id)}
                        className={cn(
                          'group w-full text-left p-3.5 border rounded-[var(--radius-lg)] transition-colors',
                          'hover:bg-[var(--bg-hover)]',
                          n.edited
                            ? 'border-[var(--border)] border-l-2 border-l-[var(--sem-rewritten)]'
                            : 'border-[var(--border)]',
                        )}
                      >
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-[13.5px] font-medium">{n.title}</span>
                          {n.state !== 'vault' && <Badge>草稿</Badge>}
                          {n.edited && (
                            <span className="text-[10.5px] text-[var(--sem-rewritten)]">
                              已改写
                            </span>
                          )}
                          <div className="grow" />
                          {n.cards > 0 && (
                            <span className="text-[10.5px] text-[var(--text-subtle)] shrink-0">
                              {n.cards} 张卡
                            </span>
                          )}
                        </div>
                        {n.excerpt && (
                          <div className="text-[12.5px] text-[var(--text-muted)] mt-1.5 line-clamp-2 leading-relaxed">
                            {n.excerpt}
                          </div>
                        )}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}

          {/* 卡片降级之后的安全阀：别让它们变成没人管的角落 */}
          {!!notebook?.undigested && (
            <div className="mt-8 px-3.5 py-3 border border-dashed border-[var(--border-strong)] rounded-[var(--radius-lg)]">
              <div className="text-[12.5px]">
                你有 <span className="font-semibold tabular-nums">{notebook.undigested}</span>{' '}
                张卡还没进任何笔记
              </div>
              <p className="text-[11.5px] text-[var(--text-muted)] mt-1 leading-relaxed">
                它们所在的小节还没生成笔记。去那几节点一下「生成本节笔记」，
                这些疑问就会被吸收进你自己的话里。
              </p>
              <Button size="xs" variant="outline" onClick={() => setTab('cards')} className="mt-2">
                看看是哪些
              </Button>
            </div>
          )}
        </div>
      )}

      {/* ── 疑问 / 孤岛卡（素材层）── */}
      {tab !== 'notes' && (
        <>
          {tab === 'cards' && (
            <div className="mt-4 text-[11.5px] text-[var(--text-subtle)] leading-relaxed">
              这些是划词提问留下的卡片，它们是笔记的素材 ——
              真正值得回头读的是笔记，这里用来搜索、整理和补漏。
            </div>
          )}
          {tab === 'orphans' && cards.length > 0 && (
            <div className="mt-4 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-[var(--text-muted)] border border-dashed border-[var(--border-strong)] rounded-[var(--radius)]">
              这些卡长期没被碰过，也没有任何连线。归并到别的卡，或者删掉？
              <span className="opacity-70"> 拒绝坟场，就得定期清理。</span>
            </div>
          )}

          <div className="mt-4">
            {!cards.length ? (
              <Empty
                title={
                  tab === 'orphans'
                    ? '没有孤岛卡'
                    : cardState === 'draft'
                      ? '没有未整理的卡'
                      : q
                        ? '没有匹配的卡片'
                        : '还没有沉淀的卡片'
                }
                hint={tab === 'orphans' ? '每张卡都有归属，很好。' : undefined}
              />
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                {cards.map((c) => {
                  const due = c.due_date ? new Date(c.due_date).getTime() <= Date.now() : false
                  return (
                    <button
                      key={c.id}
                      onClick={() => openDetail(c.id)}
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
                            <span className="truncate max-w-[45%]">
                              {c.origin_info.course_title}
                            </span>
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
        </>
      )}

      {/* 详情 */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        width="max-w-2xl"
        title={
          detail
            ? detail.kind === 'note'
              ? `📓 ${detail.question || detail.selected_text}`
              : `⟨${detail.selected_text || truncate(detail.question, 24)}⟩`
            : ''
        }
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
                  {detail.kind === 'note' ? '收进笔记' : '沉淀'}
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
                  {detail.kind === 'note' ? '去这一节修改' : '回到原文'}
                </Button>
              )}
            </>
          )
        }
      >
        {detail?.kind === 'note' ? (
          /* ★ 笔记卡：正文就是笔记本身。
             它没有问答轮次，内容在 user_note（你的终稿）或 ai_answer（AI 原稿）里 ——
             照问答排版走会渲染成一片空白。 */
          <div className="space-y-4">
            <Markdown variant="read">{detail.user_note || detail.ai_answer}</Markdown>
            {detail.is_rewritten && detail.ai_answer && detail.user_note && (
              <details className="pt-2 border-t border-[var(--border)]">
                <summary className="text-[12px] text-[var(--text-muted)] cursor-pointer">
                  看看 AI 原来写的
                </summary>
                <div className="mt-3 opacity-70">
                  <Markdown variant="read">{detail.ai_answer}</Markdown>
                </div>
              </details>
            )}
          </div>
        ) : (
          detail && (
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
          )
        )}
      </Modal>
    </div>
  )
}
