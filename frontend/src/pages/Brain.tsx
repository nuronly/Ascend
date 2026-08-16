import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, sse } from '@/lib/api'
import type { Card, Citation } from '@/lib/types'
import { DARK_PALETTE, LIGHT_PALETTE, type NetworkData } from '@/lib/neural'
import { reportGuideStep } from '@/lib/guide'
import { useIsDark } from '@/lib/useTheme'
import { Markdown } from '@/components/Markdown'
import { NeuralNetwork, type NeuralHandle } from '@/components/NeuralNetwork'
import { Badge, Button, Modal, Segmented, Spinner, Textarea } from '@/components/ui'
import { cn, relativeTime, truncate } from '@/lib/utils'

/**
 * 第二大脑（PLAN §3.6）
 *
 * 边界已定：**只吃本产品内产生的学习记录**，不做通用文档问答。
 * 每句话都能点回原始卡片 —— 这个可追溯性是普通 RAG 给不了的。
 *
 * 左侧是记忆网络的可视化，右侧是对话。两者是联动的：
 * 提问时四路召回会在网络上依次点亮，你能**看见** AI 是怎么想起来的。
 */

interface Turn {
  role: 'user' | 'assistant'
  content: string
  citations?: Citation[]
  empty?: boolean
}

const RECALL_LABEL: Record<string, { text: string; color: string }> = {
  fulltext: { text: '关键词命中', color: '#e8eefc' },
  vector: { text: '语义相近', color: '#6fa8ff' },
  graph: { text: '沿连接扩散', color: '#a78bfa' },
  fused: { text: '融合排序', color: '#c9d4ea' },
}

/** 画布上的浮层。之前写死成黑色药丸，浅底下像贴了块补丁 */
const FLOAT = cn(
  'absolute px-2.5 py-1.5 rounded-full',
  'bg-[color-mix(in_oklch,var(--bg-raised)_88%,transparent)] backdrop-blur-sm',
  'border border-[var(--border)]',
)

export default function BrainPage() {
  const nav = useNavigate()
  const pal = useIsDark() ? DARK_PALETTE : LIGHT_PALETTE
  const [turns, setTurns] = useState<Turn[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [detail, setDetail] = useState<Card | null>(null)
  const [stage, setStage] = useState<{ key: string; count: number } | null>(null)
  const [timeline, setTimeline] = useState(1)
  const [playing, setPlaying] = useState(false)
  const [view, setView] = useState<'split' | 'net' | 'chat'>('split')
  const bottomRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  const netRef = useRef<NeuralHandle>(null)

  const { data: network, isLoading: loadingNet } = useQuery({
    queryKey: ['brain-network'],
    queryFn: () => api.get<NetworkData>('/brain/network'),
    staleTime: 60_000,
  })

  const { data: recent } = useQuery({
    queryKey: ['brain-recent'],
    queryFn: () => api.get<{ cards: Card[]; suggestions: string[] }>('/brain/recent'),
  })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [turns, status])

  useEffect(() => () => abortRef.current?.abort(), [])

  /** 回放：看着自己的知识网络从第一张卡长到现在 */
  useEffect(() => {
    if (!playing) return
    const from = timeline >= 0.99 ? 0.02 : timeline
    const t0 = performance.now()
    let raf = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - t0) / 5200)
      setTimeline(from + (1 - from) * p)
      if (p < 1) raf = requestAnimationFrame(tick)
      else setPlaying(false)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing])

  const ask = async (q: string) => {
    const question = q.trim()
    if (!question || busy) return

    const history = turns.slice(-6).map((t) => ({ role: t.role, content: t.content }))
    setTurns((s) => [...s, { role: 'user', content: question }, { role: 'assistant', content: '' }])
    setInput('')
    setBusy(true)
    setStatus('正在检索你的学习记录…')
    netRef.current?.reset()

    const ctrl = new AbortController()
    abortRef.current = ctrl
    let text = ''

    await sse('/brain/ask', {
      method: 'POST',
      body: { question, history },
      signal: ctrl.signal,
      onEvent: (ev, data) => {
        if (ev === 'status') setStatus(data?.text ?? '')

        // ★ 把召回过程演在网络上
        if (ev === 'recall') {
          const ids: string[] = data?.ids ?? []
          setStage({ key: data.stage, count: ids.length })
          if (data.stage === 'graph') {
            // 图扩散：先从种子发射信号，再点亮被波及的节点
            netRef.current?.emitFrom(data.seeds ?? [])
            setTimeout(() => netRef.current?.activate(ids, 'graph', 0.75), 260)
          } else if (data.stage === 'fused') {
            netRef.current?.activate(ids.slice(0, 12), 'picked', 0.85)
          } else {
            netRef.current?.activate(ids, data.stage === 'vector' ? 'vector' : 'fulltext', 0.9)
          }
        }

        if (ev === 'citations') {
          setStatus('')
          setStage(null)
          reportGuideStep('ask_brain') // 引导打点：问到答案就算完成
          const cites: Citation[] = data?.citations ?? []
          // 最终被引用的节点持续脉冲，并沿它们的连接再发一轮信号
          netRef.current?.activate(
            cites.map((c) => c.id),
            'picked',
            1,
          )
          netRef.current?.emitFrom(cites.map((c) => c.id))
          setTurns((s) => {
            const n = [...s]
            n[n.length - 1] = { ...n[n.length - 1], citations: cites }
            return n
          })
        }
        if (ev === 'empty') {
          setStatus('')
          setStage(null)
          setTurns((s) => {
            const n = [...s]
            n[n.length - 1] = { role: 'assistant', content: data?.message ?? '', empty: true }
            return n
          })
        }
      },
      onDelta: (t) => {
        setStatus('')
        text += t
        setTurns((s) => {
          const n = [...s]
          n[n.length - 1] = { ...n[n.length - 1], content: text }
          return n
        })
      },
      onError: (m) => {
        setStatus('')
        setStage(null)
        setTurns((s) => {
          const n = [...s]
          n[n.length - 1] = { role: 'assistant', content: `出错了：${m}`, empty: true }
          return n
        })
      },
    }).catch(() => {})

    setBusy(false)
    setStatus('')
    setStage(null)
  }

  const openCard = async (id: string) => {
    const c = await api.get<Card>(`/cards/${id}`).catch(() => null)
    if (c) setDetail(c)
    netRef.current?.focus(id)
  }

  const stats = network?.stats ?? {}
  const showNet = view !== 'chat'
  const showChat = view !== 'net'

  return (
    <div className="h-full flex flex-col">
      <header className="shrink-0 px-6 py-3 border-b border-[var(--border)] flex flex-wrap items-center gap-3">
        <h1 className="text-[15px] font-semibold tracking-[-0.01em]">第二大脑</h1>
        <span className="text-[12px] text-[var(--text-subtle)] hidden md:inline">
          只回答你自己学过的东西
        </span>

        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'split', label: '并排' },
            { value: 'net', label: '记忆网络' },
            { value: 'chat', label: '对话' },
          ]}
        />

        <div className="grow" />

        {!!stats.neurons && (
          <div className="flex items-center gap-3.5 text-[11.5px] text-[var(--text-muted)] tabular-nums">
            <span>
              <b className="text-[var(--text)]">{stats.neurons}</b> 神经元
            </span>
            <span>
              <b className="text-[var(--text)]">{stats.synapses}</b> 突触
            </span>
            <span title="平均记忆强度，来自 FSRS">
              强度 <b className="text-[var(--text)]">{Math.round((stats.avg_strength ?? 0) * 100)}%</b>
            </span>
            {!!stats.isolated && (
              <span className="text-[var(--text-subtle)]" title="无任何连接、濒临遗忘的卡">
                孤岛 {stats.isolated}
              </span>
            )}
          </div>
        )}

        {turns.length > 0 && (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              setTurns([])
              netRef.current?.reset()
            }}
          >
            清空
          </Button>
        )}
      </header>

      <div className="grow min-h-0 flex">
        {/* ── 左：记忆网络 ── */}
        {showNet && (
          <div
            className={cn(
              'relative min-w-0 border-r border-[var(--border)]',
              view === 'net' ? 'grow' : 'w-[46%] hidden lg:block',
            )}
          >
            <NeuralNetwork
              ref={netRef}
              data={network ?? null}
              loading={loadingNet}
              timeline={timeline}
              onSelect={openCard}
              className="absolute inset-0"
            />

            {/* 检索阶段指示 */}
            {stage && (
              <div className={cn(FLOAT, 'top-3 left-3 flex items-center gap-2 animate-fade-in')}>
                <span
                  className="size-1.5 rounded-full animate-pulse"
                  style={{ background: RECALL_LABEL[stage.key]?.color ?? 'currentColor' }}
                />
                <span className="text-[11.5px] text-[var(--text)]">
                  {RECALL_LABEL[stage.key]?.text ?? stage.key}
                </span>
                <span className="text-[11px] text-[var(--text-subtle)] tabular-nums">
                  {stage.count}
                </span>
              </div>
            )}

            {/* 图例。颜色必须取自当前调色板，否则切主题后图例和画面对不上 */}
            <div className="absolute top-3 right-3 flex flex-col gap-1 text-[10px] text-[var(--text-subtle)] pointer-events-none">
              {[
                [pal.nodeRewritten, '己见卡'],
                [pal.nodeDue, '待复习'],
                [pal.node, 'AI 原生'],
                [pal.nodeIsolated, '孤岛（濒临遗忘）'],
              ].map(([c, t]) => (
                <span key={t} className="flex items-center gap-1.5 justify-end">
                  {t}
                  <span
                    className="size-2 rounded-full"
                    style={{ background: c, outline: '1px solid rgb(0 0 0 / 0.06)' }}
                  />
                </span>
              ))}
            </div>

            {/* 时间轴：回放知识网络的生长过程 */}
            {!!network?.neurons.length && (
              <div className={cn(FLOAT, 'bottom-3 right-3 flex items-center gap-2')}>
                <button
                  onClick={() => setPlaying((p) => !p)}
                  title="回放你的知识网络是怎么长起来的"
                  className="size-5 shrink-0 flex items-center justify-center rounded-full text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  {playing ? (
                    <svg viewBox="0 0 24 24" className="size-3" fill="currentColor">
                      <rect x="6" y="5" width="4" height="14" rx="1" />
                      <rect x="14" y="5" width="4" height="14" rx="1" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" className="size-3" fill="currentColor">
                      <path d="M7 4.5v15l13-7.5z" />
                    </svg>
                  )}
                </button>
                <input
                  type="range"
                  min={0.02}
                  max={1}
                  step={0.01}
                  value={timeline}
                  onChange={(e) => {
                    setPlaying(false)
                    setTimeline(Number(e.target.value))
                  }}
                  className="w-24 accent-[var(--accent)] h-1"
                />
                <button
                  onClick={() => netRef.current?.fit()}
                  className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)] shrink-0"
                >
                  全览
                </button>
              </div>
            )}

            {/* 网络还小时给个预期，别让人觉得功能坏了 */}
            {!loadingNet && !!network?.neurons.length && network.neurons.length < 12 && (
              <div
                className={cn(
                  FLOAT,
                  'bottom-3 left-3 max-w-[260px] !rounded-[var(--radius)] pointer-events-none',
                )}
              >
                <div className="text-[11.5px] text-[var(--text-muted)] leading-relaxed">
                  网络才 {network.neurons.length} 个神经元。
                  <span className="text-[var(--text-subtle)]">
                    多学几节、多收几张卡，节点之间的聚类和孤岛会自己浮现出来。
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── 右：对话 ── */}
        {showChat && (
          <div className={cn('flex flex-col min-w-0', view === 'chat' ? 'grow' : 'grow')}>
            <div className="grow min-h-0 overflow-y-auto">
              <div className="max-w-[720px] mx-auto px-6 py-7">
                {!turns.length ? (
                  <div className="pt-2">
                    <h2 className="text-[18px] font-semibold tracking-[-0.015em]">
                      问问你自己学过什么
                    </h2>
                    <p className="text-[13px] text-[var(--text-muted)] mt-2 leading-relaxed">
                      我不会用通用知识给你兜底。检索不到就直说「你的学习记录里还没有涉及这部分」
                      —— 这是它和搜索引擎的根本区别。
                    </p>
                    <p className="text-[12.5px] text-[var(--text-subtle)] mt-3 leading-relaxed">
                      提问时留意左边：四路召回会依次点亮，你能看见我是怎么想起来的。
                    </p>

                    {!!recent?.suggestions?.length && (
                      <div className="mt-6 space-y-1.5">
                        {recent.suggestions.map((s) => (
                          <button
                            key={s}
                            onClick={() => ask(s)}
                            className="block w-full text-left px-3 py-2 text-[13px] border border-[var(--border)] rounded-[var(--radius)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] transition-colors"
                          >
                            {s}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-6">
                    {turns.map((t, i) =>
                      t.role === 'user' ? (
                        <div key={i} className="flex justify-end">
                          <div className="max-w-[82%] px-3.5 py-2 bg-[var(--bg-sunken)] border border-[var(--border)] rounded-[var(--radius-lg)] text-[13.5px] leading-relaxed">
                            {t.content}
                          </div>
                        </div>
                      ) : (
                        <div key={i}>
                          {!!t.citations?.length && (
                            <div className="flex flex-wrap gap-1.5 mb-3">
                              {t.citations.map((c, ci) => (
                                <button
                                  key={c.id}
                                  onClick={() => openCard(c.id)}
                                  onMouseEnter={() => netRef.current?.activate([c.id], 'picked', 1)}
                                  title={c.origin?.section_title}
                                  className={cn(
                                    'flex items-center gap-1.5 h-6 pl-1.5 pr-2 rounded-full',
                                    'border text-[11.5px] transition-colors',
                                    c.is_rewritten
                                      ? 'border-[color-mix(in_oklch,var(--sem-rewritten)_40%,transparent)] text-[var(--sem-rewritten)]'
                                      : 'border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]',
                                  )}
                                >
                                  <span className="size-3.5 flex items-center justify-center rounded-full bg-[var(--bg-sunken)] text-[9px] font-semibold tabular-nums">
                                    {ci + 1}
                                  </span>
                                  <span className="max-w-[170px] truncate">
                                    {c.label || c.selected_text}
                                  </span>
                                </button>
                              ))}
                            </div>
                          )}

                          {t.content ? (
                            <div className={cn(t.empty && 'text-[var(--text-muted)]')}>
                              <Markdown variant="read" onCitation={openCard}>
                                {t.content}
                              </Markdown>
                            </div>
                          ) : status ? (
                            <div className="flex items-center gap-2 text-[13px] text-[var(--text-muted)]">
                              <Spinner className="size-3.5 text-[var(--accent)]" />
                              {status}
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <div className="skeleton h-3.5 w-4/5" />
                              <div className="skeleton h-3.5 w-full" />
                              <div className="skeleton h-3.5 w-3/5" />
                            </div>
                          )}
                        </div>
                      ),
                    )}
                    <div ref={bottomRef} />
                  </div>
                )}
              </div>
            </div>

            <div className="shrink-0 border-t border-[var(--border)] bg-[var(--bg)]">
              <div className="max-w-[720px] mx-auto px-6 py-3 flex gap-2 items-end">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      ask(input)
                    }
                  }}
                  rows={1}
                  placeholder="我关于……都学过什么？"
                  className="min-h-9 max-h-40"
                  disabled={busy}
                />
                {busy ? (
                  <Button size="md" variant="outline" onClick={() => abortRef.current?.abort()}>
                    停止
                  </Button>
                ) : (
                  <Button
                    size="md"
                    variant="primary"
                    onClick={() => ask(input)}
                    disabled={!input.trim()}
                  >
                    提问
                  </Button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <Modal
        open={!!detail}
        onClose={() => setDetail(null)}
        width="max-w-xl"
        title={detail ? `⟨${detail.selected_text}⟩` : ''}
        subtitle={
          detail && (
            <span className="flex items-center gap-2">
              <span>{relativeTime(detail.created_at)}</span>
              {detail.is_rewritten && (
                <Badge tone="rewritten" className="ml-1">
                  己见
                </Badge>
              )}
            </span>
          )
        }
        footer={
          detail?.source_section_id && detail.origin_info?.course_id ? (
            <Button
              size="sm"
              onClick={() =>
                nav(`/courses/${detail.origin_info!.course_id}/sections/${detail.source_section_id}`)
              }
            >
              回到原文
            </Button>
          ) : undefined
        }
      >
        {detail && (
          <div className="space-y-3">
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
              <div className="border-l-2 border-[var(--sem-rewritten)] pl-3 py-1 text-[13px] leading-relaxed whitespace-pre-wrap bg-[color-mix(in_oklch,var(--sem-rewritten)_6%,transparent)]">
                {detail.user_note}
              </div>
            )}
            {!!detail.concept_tags.length && (
              <div className="flex flex-wrap gap-1.5">
                {detail.concept_tags.map((t) => (
                  <Badge key={String(t)}>{truncate(String(t), 16)}</Badge>
                ))}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
