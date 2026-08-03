import { useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { toast } from '@/lib/store'
import { Badge, Button, Empty, Input, Progress, Spinner } from '@/components/ui'
import { cn, relativeTime } from '@/lib/utils'

interface DocItem {
  id: string
  title: string
  filename: string
  origin: string
  page_count: number
  parse_status: string
  error: string | null
  created_at: string
  stats: { blocks: number; translated: number; cards: number }
}

export default function DocumentsPage() {
  const nav = useNavigate()
  const qc = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState('')
  const [dragging, setDragging] = useState(false)

  const { data: docs, isLoading } = useQuery({
    queryKey: ['documents'],
    queryFn: () => api.get<DocItem[]>('/documents'),
  })

  const { data: formats } = useQuery({
    queryKey: ['doc-formats'],
    queryFn: () => api.get<{ extensions: string[]; max_mb: number }>('/documents/meta/formats'),
    staleTime: Infinity,
  })

  const upload = async (file: File) => {
    setBusy('正在解析 ' + file.name)
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await fetch('/api/documents/upload', {
        method: 'POST',
        body: fd,
        credentials: 'same-origin',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.detail ?? '上传失败')
      }
      const doc = await res.json()
      qc.invalidateQueries({ queryKey: ['documents'] })
      toast.ok('已导入')
      nav(`/documents/${doc.id}`)
    } catch (e: any) {
      toast.error(e?.message ?? '上传失败')
    } finally {
      setBusy('')
    }
  }

  const importUrl = async () => {
    const u = url.trim()
    if (!u) return
    setBusy('正在抓取…')
    try {
      const doc = await api.post<DocItem>('/documents/import-url', { url: u })
      qc.invalidateQueries({ queryKey: ['documents'] })
      setUrl('')
      toast.ok('已导入')
      nav(`/documents/${doc.id}`)
    } catch (e: any) {
      toast.error(e?.message ?? '导入失败')
    } finally {
      setBusy('')
    }
  }

  const remove = async (id: string, title: string) => {
    if (!confirm(`删除《${title}》？这一篇下面的卡片会保留在仓库里。`)) return
    await api.del(`/documents/${id}`)
    qc.invalidateQueries({ queryKey: ['documents'] })
  }

  return (
    <div className="max-w-[880px] w-full mx-auto px-8 py-10 pb-24">
      <h1 className="text-[22px] font-semibold tracking-[-0.018em]">文档</h1>
      <p className="text-[13px] text-[var(--text-muted)] mt-1.5 leading-relaxed">
        导入论文或资料，段落级对照翻译，读到不懂的地方照样划词建卡 —— 和课程模式共用同一套卡片系统。
      </p>

      {/* 导入区 */}
      <div className="mt-7 grid gap-3 sm:grid-cols-[1fr_auto]">
        <div className="flex gap-2">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && !busy && importUrl()}
            placeholder="粘贴 arXiv 链接或论文编号（如 1706.03762），也支持普通网页"
            className="h-10"
            disabled={!!busy}
          />
          <Button
            variant="primary"
            size="md"
            onClick={importUrl}
            loading={busy === '正在抓取…'}
            disabled={!url.trim() || !!busy}
            className="h-10 shrink-0"
          >
            导入
          </Button>
        </div>
      </div>

      {/* 拖拽上传 */}
      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          const f = e.dataTransfer.files?.[0]
          if (f) upload(f)
        }}
        onClick={() => !busy && fileRef.current?.click()}
        className={cn(
          'mt-3 flex flex-col items-center justify-center gap-1.5 py-8 px-6',
          'border border-dashed rounded-[var(--radius-lg)] cursor-pointer transition-colors',
          dragging
            ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
            : 'border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
        )}
      >
        <input
          ref={fileRef}
          type="file"
          hidden
          accept={formats?.extensions.join(',')}
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) upload(f)
            e.target.value = ''
          }}
        />
        {busy && busy !== '正在抓取…' ? (
          <div className="flex items-center gap-2 text-[13px] text-[var(--text-muted)]">
            <Spinner className="size-4 text-[var(--accent)]" />
            {busy}
          </div>
        ) : (
          <>
            <svg viewBox="0 0 24 24" className="size-6 text-[var(--text-subtle)]" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 15V4m0 0L8 8m4-4 4 4" />
              <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
            </svg>
            <div className="text-[13px] font-medium">拖文件进来，或点击选择</div>
            <div className="text-[11.5px] text-[var(--text-subtle)]">
              {formats?.extensions.join(' · ')} · 最大 {formats?.max_mb ?? 40}MB
            </div>
          </>
        )}
      </div>

      <p className="mt-2.5 text-[11.5px] text-[var(--text-subtle)] leading-relaxed">
        arXiv 论文会自动走 HTML 版本，切段质量比解析 PDF 好一个量级。
        扫描件（图片型 PDF）没有文本层，暂不支持。
      </p>

      {/* 列表 */}
      <div className="mt-10">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-[14px] font-semibold">我的文档</h2>
          {!!docs?.length && (
            <span className="text-[12px] text-[var(--text-subtle)] tabular-nums">
              {docs.length} 篇
            </span>
          )}
        </div>

        {isLoading ? (
          <div className="space-y-2">
            {[0, 1].map((i) => (
              <div key={i} className="skeleton h-[68px]" />
            ))}
          </div>
        ) : !docs?.length ? (
          <Empty
            icon={
              <svg viewBox="0 0 48 48" className="size-9" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M12 6h16l8 8v28H12z" />
                <path d="M28 6v8h8" />
                <path d="M18 26h12M18 33h8" strokeLinecap="round" />
              </svg>
            }
            title="还没有文档"
            hint="试试粘贴一个 arXiv 编号，比如 1706.03762（Attention Is All You Need）。"
          />
        ) : (
          <div className="space-y-2">
            {docs.map((d) => {
              const ratio = d.stats.blocks ? d.stats.translated / d.stats.blocks : 0
              return (
                <div
                  key={d.id}
                  className="group flex items-center gap-4 px-4 py-3.5 border border-[var(--border)] rounded-[var(--radius-lg)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <button
                    onClick={() => nav(`/documents/${d.id}`)}
                    className="min-w-0 grow text-left"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[14px] font-medium truncate">{d.title}</span>
                      {d.origin === 'arxiv' && <Badge tone="accent">arXiv</Badge>}
                      {d.parse_status === 'failed' && (
                        <Badge className="text-[var(--sem-danger)]">解析失败</Badge>
                      )}
                      {!!d.stats.cards && <Badge tone="accent">{d.stats.cards} 卡</Badge>}
                    </div>
                    <div className="flex items-center gap-2.5 mt-1 text-[11.5px] text-[var(--text-subtle)]">
                      <span>{d.stats.blocks} 段</span>
                      <span className="opacity-40">·</span>
                      <span>
                        译 {d.stats.translated}/{d.stats.blocks}
                      </span>
                      <span className="opacity-40">·</span>
                      <span>{relativeTime(d.created_at)}</span>
                    </div>
                    {d.stats.blocks > 0 && (
                      <Progress value={ratio} className="mt-2.5 max-w-[260px]" />
                    )}
                    {d.error && (
                      <div className="text-[11.5px] text-[var(--sem-danger)] mt-1.5 line-clamp-2">
                        {d.error}
                      </div>
                    )}
                  </button>
                  <button
                    onClick={() => remove(d.id, d.title)}
                    className="shrink-0 size-7 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-subtle)] opacity-0 group-hover:opacity-100 hover:bg-[var(--bg-active)] hover:text-[var(--sem-danger)] transition-all"
                    title="删除"
                  >
                    <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
                      <path d="M5 7h14M10 7V5h4v2M6 7l1 13h10l1-13" />
                    </svg>
                  </button>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
