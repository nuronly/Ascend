import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { Card, VaultOverview } from '@/lib/types'
import { Badge, Button, Empty, Input, Modal } from '@/components/ui'
import { Markdown } from '@/components/Markdown'
import { cn, relativeTime } from '@/lib/utils'
import { toast } from '@/lib/store'

/**
 * ★ 笔记（原「灵感仓库」）
 *
 * 卡片整理进仓库其实没人回来看：粒度太碎、网格不是阅读单元、「归档」本身就是
 * 心理上的完结，而且它是**过程产物**而不是成果。
 *
 * 所以这一页只有笔记。**卡片不再是独立存在的东西** —— 它绑定在小节
 * （source_section_id）和笔记（note_sources）上，唯一入口是小节页的卡片空间。
 * 这里既没有「疑问」栏，也不统计「未消化的疑问」：那又是在把过程产物摆上台面。
 *
 * 己见率也撤了。它当初挂在卡片上，而现在「整理」这件事发生在笔记里
 * （笔记的「我的理解」那一节），再按卡片算比例既不准也没人看。
 *
 * 分组按「课程 → 小节」而不是时间流：回访路径是「我要复习注意力那节」，
 * 不是「我三周前记了什么」。
 */

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
  const [q, setQ] = useState('')
  const [detail, setDetail] = useState<Card | null>(null)

  const { data: overview } = useQuery({
    queryKey: ['vault-overview'],
    queryFn: () => api.get<VaultOverview>('/vault/overview'),
  })

  /* 分组视图：无搜索词时的主视图 */
  const { data: notebook, isFetching } = useQuery({
    queryKey: ['notebook'],
    queryFn: () => api.get<{ groups: NoteGroup[] }>('/vault/notes'),
    enabled: !q.trim(),
  })

  /* 搜索：笔记多了必然要搜，这时切成平铺结果 */
  const { data: found, isFetching: searching } = useQuery({
    queryKey: ['note-search', q],
    queryFn: () => {
      const p = new URLSearchParams({ kind: 'note', state: 'all', limit: '60', q: q.trim() })
      return api.get<{ total: number; cards: Card[] }>(`/vault?${p}`)
    },
    enabled: !!q.trim(),
    placeholderData: keepPreviousData,
  })

  const groups = notebook?.groups ?? []
  const results = found?.cards ?? []

  const openDetail = async (id: string) => {
    const full = await api.get<Card>(`/cards/${id}`).catch(() => null)
    if (full) setDetail(full)
  }

  const remove = async (id: string) => {
    if (!confirm('删除这份笔记？（它引用的卡片不会被删）')) return
    await api.del(`/cards/${id}`)
    setDetail(null)
    qc.invalidateQueries({ queryKey: ['notebook'] })
    qc.invalidateQueries({ queryKey: ['note-search'] })
    qc.invalidateQueries({ queryKey: ['vault-overview'] })
    toast.ok('已删除')
  }

  const keep = async (id: string) => {
    await api.post(`/cards/${id}/vault`)
    qc.invalidateQueries({ queryKey: ['notebook'] })
    qc.invalidateQueries({ queryKey: ['vault-overview'] })
    setDetail(null)
    toast.ok('已收进笔记')
  }

  /** 跳回原文小节。panel=note 时右栏直接停在笔记上 */
  const goSection = (courseId: string, sectionId: string, panel?: 'note') =>
    nav(`/courses/${courseId}/sections/${sectionId}${panel ? `?panel=${panel}` : ''}`)

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

      {/* 指标只留笔记口径 */}
      {!!overview?.notes && (
        <div className="mt-6 flex flex-wrap gap-x-8 gap-y-3">
          {[
            { label: '笔记', v: overview.notes },
            { label: '已收进', v: overview.notes_done ?? 0 },
            // 标签刻意不叫「草稿」—— 那个词在列表里是徽标，两处同名会让人分不清
            { label: '还没收进', v: (overview.notes ?? 0) - (overview.notes_done ?? 0) },
          ].map((s) => (
            <div key={s.label}>
              <div className="text-[11px] text-[var(--text-subtle)]">{s.label}</div>
              <div className="text-[19px] font-semibold tabular-nums tracking-[-0.02em]">
                {s.v}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-7 flex items-center gap-2">
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="搜索笔记…"
          className="w-64 h-8 text-[12.5px]"
        />
        <div className="grow" />
        {(isFetching || searching) && (
          <span className="text-[11.5px] text-[var(--text-subtle)]">加载中…</span>
        )}
      </div>

      {/* ── 搜索结果（平铺）── */}
      {q.trim() ? (
        <div className="mt-5">
          {!results.length ? (
            <Empty title="没有匹配的笔记" />
          ) : (
            <div className="space-y-1.5">
              {results.map((c) => (
                <button
                  key={c.id}
                  onClick={() => openDetail(c.id)}
                  className={cn(
                    'w-full text-left p-3.5 border rounded-[var(--radius-lg)] transition-colors',
                    'border-[var(--border)] hover:bg-[var(--bg-hover)]',
                  )}
                >
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13.5px] font-medium">{c.question}</span>
                    {c.state !== 'vault' && <Badge>草稿</Badge>}
                    <div className="grow" />
                    {c.origin_info?.course_title && (
                      <span className="text-[10.5px] text-[var(--text-subtle)] truncate max-w-[40%]">
                        {c.origin_info.course_title}
                      </span>
                    )}
                  </div>
                  <div className="text-[12.5px] text-[var(--text-muted)] mt-1.5 line-clamp-2 leading-relaxed">
                    {(c.user_note || c.ai_answer).replace(/^#+\s.*$/gm, '').trim().slice(0, 160)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        /* ── 主视图：按课程 → 小节 ── */
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
                      <div
                        key={n.card_id}
                        className={cn(
                          'group relative border rounded-[var(--radius-lg)] transition-colors',
                          'hover:bg-[var(--bg-hover)]',
                          n.edited
                            ? 'border-[var(--border)] border-l-2 border-l-[var(--sem-rewritten)]'
                            : 'border-[var(--border)]',
                        )}
                      >
                        <button
                          onClick={() => openDetail(n.card_id)}
                          className="w-full text-left p-3.5"
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
                                吃进 {n.cards} 张卡
                              </span>
                            )}
                          </div>
                          {n.excerpt && (
                            <div className="text-[12.5px] text-[var(--text-muted)] mt-1.5 line-clamp-2 leading-relaxed">
                              {n.excerpt}
                            </div>
                          )}
                        </button>
                        {/* 跳回原文：读笔记时经常想回去核对一句，这个入口不该藏在弹窗里 */}
                        <button
                          onClick={() => goSection(g.course_id, n.section_id)}
                          className="absolute right-2.5 bottom-2.5 opacity-0 group-hover:opacity-100 transition-opacity text-[11px] text-[var(--text-muted)] hover:text-[var(--accent)]"
                        >
                          看原文 →
                        </button>
                      </div>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
        </div>
      )}

      {/* 详情 */}
      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        width="max-w-2xl"
        title={detail ? detail.question || detail.selected_text : ''}
        subtitle={
          detail && (
            <span className="flex flex-wrap items-center gap-2">
              <span>{relativeTime(detail.created_at)}</span>
              {detail.origin_info?.course_title && (
                <>
                  <span className="opacity-40">·</span>
                  <span>{detail.origin_info.course_title}</span>
                </>
              )}
              {detail.state !== 'vault' && (
                <>
                  <span className="opacity-40">·</span>
                  <span>草稿</span>
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
                <Button variant="primary" size="sm" onClick={() => keep(detail.id)}>
                  收进笔记
                </Button>
              )}
              {detail.origin_info?.course_id && detail.source_section_id && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      goSection(detail.origin_info!.course_id!, detail.source_section_id!)
                    }
                  >
                    看原文小节
                  </Button>
                  <Button
                    size="sm"
                    onClick={() =>
                      goSection(detail.origin_info!.course_id!, detail.source_section_id!, 'note')
                    }
                  >
                    修改笔记
                  </Button>
                </>
              )}
            </>
          )
        }
      >
        {detail && (
          <div className="space-y-4">
            {/* 笔记正文：终稿优先，没改过就是 AI 原稿 */}
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
        )}
      </Modal>
    </div>
  )
}
