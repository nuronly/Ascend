import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api, sse } from '@/lib/api'
import { useCardSpace } from '@/lib/cardSpace'
import { toast } from '@/lib/store'
import { CardSpace } from '@/components/CardSpace'
import { SelectionPopover } from '@/components/SelectionPopover'
import { useSelection } from '@/components/useSelection'
import { Badge, Button, Progress, Segmented, Spinner } from '@/components/ui'
import { cn } from '@/lib/utils'

/**
 * 文档阅读页（PLAN §3.5）
 *
 * 沉浸式翻译的难点不在翻译，在切段 —— 那部分在后端。
 * 这一侧的关键是：**译文紧贴原文段落之下**，而不是左右分栏。
 * 段落级对照才能让人在读不懂时立刻对上，左右分栏一长就错位。
 *
 * 划词建卡完全复用课程模式那套（source_type='doc'），
 * 卡片空间、套娃、己见、收进仓库全部一致。
 */

interface DocBlockItem {
  id: string
  page: number
  idx: number
  type: string
  text: string
  translation: string | null
  cards: number
}

interface DocDetail {
  id: string
  title: string
  filename: string
  origin: string
  source_url: string | null
  page_count: number
  parse_status: string
  error: string | null
  stats: { blocks: number; translated: number }
  blocks: DocBlockItem[]
}

type Mode = 'bilingual' | 'source' | 'target'

export default function DocReaderPage() {
  const { docId = '' } = useParams()
  const nav = useNavigate()
  const qc = useQueryClient()

  const [mode, setMode] = useState<Mode>('bilingual')
  const [translating, setTranslating] = useState(false)
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [live, setLive] = useState<Record<string, string>>({})
  const [activeBlock, setActiveBlock] = useState<string | null>(null)

  const cards = useCardSpace((s) => s.cards)
  const loadDoc = useCardSpace((s) => s.loadDoc)
  const resetCards = useCardSpace((s) => s.reset)
  const createAndAsk = useCardSpace((s) => s.createAndAsk)

  const { ref: readRef, selection, clear } = useSelection(true)
  const abortRef = useRef<AbortController | null>(null)

  const { data: doc, isLoading } = useQuery({
    queryKey: ['document', docId],
    queryFn: () => api.get<DocDetail>(`/documents/${docId}`),
  })

  useEffect(() => {
    loadDoc(docId)
    return () => {
      abortRef.current?.abort()
      resetCards()
    }
  }, [docId, loadDoc, resetCards])

  const translateAll = () => {
    if (translating) return
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setTranslating(true)
    setLive({})

    sse(`/documents/${docId}/translate`, {
      signal: ctrl.signal,
      onEvent: (ev, data) => {
        if (ev === 'start') {
          setProgress({ done: 0, total: data.todo ?? 0 })
          if (!data.todo) toast.info('全部段落都已翻译过了')
          else if (data.cached) toast.info(`${data.cached} 段命中缓存，只需翻 ${data.todo} 段`)
        }
        if (ev === 'block') {
          setProgress({ done: data.done + data.failed, total: data.total })
          if (data.translation) setLive((s) => ({ ...s, [data.id]: data.translation }))
        }
      },
      onDone: (data) => {
        setTranslating(false)
        qc.invalidateQueries({ queryKey: ['document', docId] })
        qc.invalidateQueries({ queryKey: ['documents'] })
        if (data?.failed) toast.error(`完成，${data.failed} 段失败`)
        else if (data?.translated) toast.ok(`译完 ${data.translated} 段`)
      },
      onError: (m) => {
        setTranslating(false)
        toast.error(m)
      },
    }).catch(() => setTranslating(false))
  }

  const retranslate = async (blockId: string) => {
    setLive((s) => ({ ...s, [blockId]: '' }))
    try {
      const r = await api.post<{ translation: string }>(
        `/documents/${docId}/blocks/${blockId}/translate`,
      )
      setLive((s) => ({ ...s, [blockId]: r.translation }))
    } catch (e: any) {
      toast.error(e?.message ?? '翻译失败')
    }
  }

  if (isLoading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Spinner className="size-5 text-[var(--text-subtle)]" />
      </div>
    )
  }
  if (!doc) return null

  const translatedCount =
    doc.stats.translated + Object.keys(live).filter((k) => live[k]).length
  const ratio = doc.stats.blocks ? Math.min(1, translatedCount / doc.stats.blocks) : 0

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <header className="shrink-0 h-11 flex items-center gap-3 px-4 border-b border-[var(--border)]">
        <button
          onClick={() => nav('/documents')}
          className="flex items-center gap-1.5 text-[12.5px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors shrink-0"
        >
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
          文档
        </button>
        <span className="text-[var(--border-strong)]">/</span>
        <span className="text-[13px] font-medium truncate min-w-0">{doc.title}</span>
        {doc.origin === 'arxiv' && <Badge tone="accent">arXiv HTML</Badge>}

        <div className="grow" />

        <Segmented
          value={mode}
          onChange={setMode}
          options={[
            { value: 'bilingual', label: '对照' },
            { value: 'source', label: '原文' },
            { value: 'target', label: '译文' },
          ]}
        />

        <span className="text-[11.5px] text-[var(--text-subtle)] tabular-nums hidden sm:block">
          {translatedCount}/{doc.stats.blocks} 段
        </span>

        {translating ? (
          <Button size="xs" variant="outline" onClick={() => abortRef.current?.abort()}>
            停止（{progress.done}/{progress.total}）
          </Button>
        ) : (
          <Button
            size="xs"
            variant={ratio >= 1 ? 'subtle' : 'primary'}
            onClick={translateAll}
            disabled={ratio >= 1}
          >
            {ratio >= 1 ? '已全部翻译' : '翻译全文'}
          </Button>
        )}
      </header>

      {translating && (
        <div className="shrink-0 px-4 py-1.5 border-b border-[var(--border)] bg-[var(--bg-sunken)]">
          <div className="flex items-center gap-2">
            <Spinner className="size-3 text-[var(--accent)]" />
            <Progress value={progress.total ? progress.done / progress.total : 0} className="grow" />
            <span className="text-[11px] text-[var(--text-muted)] tabular-nums shrink-0">
              {progress.done}/{progress.total}
            </span>
          </div>
        </div>
      )}

      <div className="grow min-h-0 flex">
        {/* 左：正文（划词区） */}
        <div className="grow min-w-0 overflow-y-auto lg:border-r border-[var(--border)]">
          <article ref={readRef} className="max-w-[760px] mx-auto px-8 lg:px-10 py-8 pb-28 select-text">
            <h1 className="text-[24px] font-semibold tracking-[-0.02em] leading-[1.3]">
              {doc.title}
            </h1>
            <div className="flex flex-wrap items-center gap-2 mt-2.5 text-[11.5px] text-[var(--text-subtle)]">
              <span>{doc.stats.blocks} 段</span>
              {doc.page_count > 1 && (
                <>
                  <span className="opacity-40">·</span>
                  <span>{doc.page_count} 页</span>
                </>
              )}
              {!!cards.length && (
                <>
                  <span className="opacity-40">·</span>
                  <span>{cards.length} 张卡</span>
                </>
              )}
              {doc.source_url && (
                <>
                  <span className="opacity-40">·</span>
                  <a
                    href={doc.source_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--accent)] hover:underline"
                  >
                    原始链接
                  </a>
                </>
              )}
            </div>

            <div className="h-px bg-[var(--border)] my-7" />

            <div className="space-y-5">
              {doc.blocks.map((b) => {
                const translation = live[b.id] ?? b.translation
                const isHeading = b.type === 'heading'
                const isCode = b.type === 'code'
                return (
                  <div
                    key={b.id}
                    onMouseEnter={() => setActiveBlock(b.id)}
                    onMouseLeave={() => setActiveBlock(null)}
                    data-block-id={b.id}
                    className="group relative"
                  >
                    {/* 原文 */}
                    {mode !== 'target' && (
                      <div
                        className={cn(
                          isHeading && 'text-[17px] font-semibold tracking-[-0.012em] mt-2',
                          isCode &&
                            'font-mono text-[12.5px] bg-[var(--bg-sunken)] border border-[var(--border)] rounded-[var(--radius)] p-3 overflow-x-auto whitespace-pre-wrap',
                          !isHeading && !isCode && 'text-[15px] leading-[1.75]',
                          b.type === 'list' && 'pl-4',
                          mode === 'bilingual' && translation && 'text-[var(--text-muted)]',
                        )}
                      >
                        {b.text}
                      </div>
                    )}

                    {/* 译文：紧贴原文之下，段落级对照 */}
                    {mode !== 'source' && translation && (
                      <div
                        className={cn(
                          'mt-1.5',
                          isHeading
                            ? 'text-[17px] font-semibold tracking-[-0.012em]'
                            : 'text-[15.5px] leading-[1.8]',
                          b.type === 'list' && 'pl-4',
                          mode === 'bilingual' &&
                            'border-l-2 border-[var(--accent)]/25 pl-3',
                        )}
                      >
                        {translation}
                      </div>
                    )}

                    {mode !== 'source' && !translation && !isCode && (
                      <div className="mt-1 text-[12px] text-[var(--text-subtle)] italic">
                        {translating ? '翻译中…' : '未翻译'}
                      </div>
                    )}

                    {/* 段落操作：hover 才出现，不干扰阅读 */}
                    <div
                      className={cn(
                        'absolute -left-9 top-0 flex flex-col gap-1 transition-opacity',
                        activeBlock === b.id ? 'opacity-100' : 'opacity-0',
                      )}
                    >
                      {!isCode && (
                        <button
                          onClick={() => retranslate(b.id)}
                          title={translation ? '重新翻译这段' : '翻译这段'}
                          className="size-6 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                        >
                          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 6h10M9 4v2c0 4-2.5 7-5 8" />
                            <path d="M7.5 11c1.5 2.5 3.5 4 6.5 5M13 20l4.5-10 4.5 10M15 17h5" />
                          </svg>
                        </button>
                      )}
                      {b.cards > 0 && (
                        <span
                          className="size-6 flex items-center justify-center rounded-[var(--radius-sm)] text-[10px] font-semibold text-[var(--accent)] bg-[var(--accent-soft)]"
                          title={`这一段有 ${b.cards} 张卡`}
                        >
                          {b.cards}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>

            {doc.stats.blocks > doc.blocks.length && (
              <div className="mt-8 text-center text-[12.5px] text-[var(--text-subtle)]">
                已显示前 {doc.blocks.length} 段，共 {doc.stats.blocks} 段
              </div>
            )}
          </article>
        </div>

        {/* 右：卡片空间（与课程模式完全一致） */}
        <aside className="shrink-0 bg-[var(--bg-sunken)] hidden lg:block lg:w-[clamp(380px,38vw,660px)]">
          <CardSpace />
        </aside>
      </div>

      {/* 划词 → 文档卡片 */}
      <SelectionPopover
        selection={selection}
        label="就这里提问"
        hint="将生成一张新卡"
        onClose={clear}
        onAsk={(q) => {
          // 找出选区落在哪一段，卡片要能精确回跳
          const el = document.querySelector(`[data-block-id="${activeBlock}"]`)
          const blockId =
            activeBlock && el ? activeBlock : (doc.blocks[0]?.id ?? null)
          createAndAsk(
            {
              selected_text: selection!.text,
              context_text: selection!.sentence,
              text_anchor: {
                exact: selection!.text,
                prefix: selection!.prefix,
                suffix: selection!.suffix,
                block_id: blockId,
                in: 'doc',
              },
              origin: 'source_text',
              source_doc_block_id: blockId,
            },
            q,
          )
          clear()
        }}
      />
    </div>
  )
}
