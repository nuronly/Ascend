import { useCallback, useEffect, useRef, useState } from 'react'
import { api, sse } from '@/lib/api'
import { toast } from '@/lib/store'
import { Markdown } from '@/components/Markdown'
import NoteEditor from '@/components/NoteEditor'
import RunTimeline from '@/components/RunTimeline'
import { Button, Spinner } from '@/components/ui'

/**
 * ★ 本节笔记卡 —— 卢曼卡片盒缺失的最上层
 *
 *   划词提问        → 闪念笔记
 *   回答 + 己见     → 文献笔记
 *   **汇流成一张**  → 永久笔记   ← 这里
 *
 * 三个刻意的设计：
 *
 * 1. **用户点一下才生成**。自动生成的东西没人看；他点了那一下，这份笔记的
 *    所有权才是他的。
 * 2. **汇流动画与流式生成是连续的一个动作**。最容易做砸的是「放 1 秒动画，
 *    然后让人对着转圈等 20 秒」—— 所以卡片飞向中心之后紧接着就开始逐字打，
 *    模型慢就让中心的卡悬浮着，绝不把动画拉长充数。
 * 3. **AI 原稿与用户终稿分开**。原稿永远留着（可以随时「看看 AI 原来写的」），
 *    用户改的存 user_note。知道原版还在，他才敢大胆删改。
 */

interface NoteState {
  exists: boolean
  card_id?: string
  content?: string
  ai_draft?: string
  state?: 'draft' | 'vault' | 'archived'
  edited?: boolean
  card_sources?: number
}

interface Source {
  id: string
  label: string
}

export default function NotePanel({
  courseId,
  sectionId,
  completed,
}: {
  courseId: string
  sectionId: string
  /** 学完了才把生成入口变成主按钮 —— 没学完先别急着收 */
  completed: boolean
}) {
  const [note, setNote] = useState<NoteState | null>(null)
  const [loading, setLoading] = useState(true)

  const [running, setRunning] = useState(false)
  const [sources, setSources] = useState<Source[]>([])
  const [flying, setFlying] = useState(false)
  const [streamed, setStreamed] = useState('')
  const [thinking, setThinking] = useState(0)
  const [thinkingText, setThinkingText] = useState('')

  const [editing, setEditing] = useState(false)
  const [draftText, setDraftText] = useState('')
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string>('')
  const [showAiDraft, setShowAiDraft] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const saveTimer = useRef<number | null>(null)

  const load = useCallback(async () => {
    try {
      const d = await api.get<NoteState>(`/courses/${courseId}/sections/${sectionId}/note`)
      setNote(d)
    } catch {
      setNote({ exists: false })
    } finally {
      setLoading(false)
    }
  }, [courseId, sectionId])

  useEffect(() => {
    setLoading(true)
    setNote(null)
    setStreamed('')
    setEditing(false)
    setRunning(false)
    load()
    return () => abortRef.current?.abort()
  }, [load])

  // 流式正文永远贴着最新一行
  useEffect(() => {
    const el = bodyRef.current
    if (el && running) el.scrollTop = el.scrollHeight
  }, [streamed, running])

  const generate = (force = false) => {
    abortRef.current?.abort()
    const ctrl = new AbortController()
    abortRef.current = ctrl

    setRunning(true)
    setStreamed('')
    setThinking(0)
    setThinkingText('')
    setSources([])
    setFlying(false)
    setEditing(false)

    let buf = ''
    sse(`/courses/${courseId}/sections/${sectionId}/note/stream${force ? '?force=true' : ''}`, {
      signal: ctrl.signal,
      onEvent: (ev, data) => {
        if (ev === 'start') {
          setSources(data?.sources ?? [])
          // 汇流：先让卡片飞进来（800ms），正文紧接着开始打
          setFlying(true)
          window.setTimeout(() => setFlying(false), 900)
        }
        if (ev === 'cached') {
          setNote({
            exists: true,
            card_id: data?.card_id,
            content: data?.content,
            ai_draft: data?.ai_draft,
            state: data?.state,
            edited: data?.edited,
          })
          setRunning(false)
        }
        if (ev === 'thinking') {
          setThinking(data?.chars ?? 0)
          if (data?.text) setThinkingText((t) => (t + data.text).slice(-2000))
        }
        if (ev === 'delta' && typeof data?.text === 'string') {
          buf += data.text
          setStreamed(buf)
        }
      },
      onDone: () => {
        setRunning(false)
        setFlying(false)
        load()
      },
      onError: (m) => {
        setRunning(false)
        setFlying(false)
        toast.error(m)
      },
    }).catch(() => setRunning(false))
  }

  const startEdit = () => {
    setDraftText(note?.content ?? streamed)
    setEditing(true)
  }

  /** 写终稿。
   *
   *  ★ 文本必须由调用方显式传进来，不能读 draftText：
   *    「不进编辑态直接保存」那条路上 setState 还没生效，读到的会是空字符串，
   *    等于把用户终稿存成空的。自测当场抓到过这个。 */
  const persist = useCallback(
    async (text: string) => {
      if (!note?.card_id) return
      setSaving(true)
      try {
        await api.patch(`/cards/${note.card_id}/note`, { user_note: text })
        setSavedAt(
          new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        )
      } catch (e: any) {
        toast.error(e?.message ?? '保存失败')
      } finally {
        setSaving(false)
      }
    },
    [note?.card_id],
  )

  /** 改一段就自动存一次（防抖 1.2s）。
   *
   *  长文让人手动点保存本身就是反人类的 —— 而且笔记是"以后还要回来改"的东西，
   *  丢一次就再也不会有人往里写了。 */
  const onEdit = useCallback(
    (md: string) => {
      setDraftText(md)
      setNote((n) => (n ? { ...n, content: md, edited: true } : n))
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => void persist(md), 1200)
    },
    [persist],
  )

  useEffect(
    () => () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current)
    },
    [],
  )

  /** 收进仓库：这才是"进图谱 / 检索 / 复习"的那一步，和保存内容是两件事 */
  const toVault = async (text: string) => {
    if (!note?.card_id) return
    setSaving(true)
    try {
      await api.patch(`/cards/${note.card_id}/note`, { user_note: text })
      await api.post(`/cards/${note.card_id}/vault`, {})
      toast.ok('笔记已收进仓库')
      setEditing(false)
      await load()
    } catch (e: any) {
      toast.error(e?.message ?? '保存失败')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="h-full grid place-items-center">
        <Spinner className="size-4 text-[var(--text-subtle)]" />
      </div>
    )
  }

  /* ── 生成中：汇流动画 + 流式正文 ── */
  if (running) {
    return (
      <div className="h-full flex flex-col overflow-hidden">
        <div className="shrink-0 px-4 py-3 border-b border-[var(--border)]">
          <div className="flex items-center gap-2 text-[13px] font-medium">
            <Spinner className="size-3.5 text-[var(--accent)]" />
            正在把这一节收成一张笔记卡
          </div>
          {!!sources.length && (
            <div className="text-[11.5px] text-[var(--text-subtle)] mt-1">
              {sources.length} 张卡片 + 本节原文正在汇入
            </div>
          )}
        </div>

        {/* 汇流：粒子数就是真实卡片数，用户能数出「我的 7 张卡进去了」 */}
        {flying && (
          <div className="relative h-[136px] shrink-0 overflow-hidden">
            {sources.slice(0, 10).map((s, i, arr) => {
              const angle = (i / Math.max(arr.length, 1)) * Math.PI * 2
              return (
                <div
                  key={s.id}
                  className="absolute left-1/2 top-1/2 max-w-[110px] truncate px-2 py-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-raised)] text-[11px] text-[var(--text-muted)] note-fly"
                  style={{
                    // 从环形外侧飞向中心：--fx/--fy 是起点偏移，动画在 index.css
                    ['--fx' as string]: `${Math.cos(angle) * 150}px`,
                    ['--fy' as string]: `${Math.sin(angle) * 90}px`,
                    animationDelay: `${i * 55}ms`,
                  }}
                >
                  {s.label}
                </div>
              )
            })}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 size-9 rounded-full bg-[color-mix(in_oklch,var(--accent)_18%,transparent)] animate-pulse" />
          </div>
        )}

        <div ref={bodyRef} className="grow min-h-0 overflow-y-auto px-4 py-4">
          {streamed ? (
            <div className="stream-caret">
              <Markdown variant="read" streaming>
                {streamed}
              </Markdown>
            </div>
          ) : (
            <RunTimeline thinking={thinking} thinkingText={thinkingText} tools={[]} />
          )}
        </div>
      </div>
    )
  }

  /* ── 还没有笔记 ── */
  if (!note?.exists) {
    return (
      <div className="h-full flex flex-col items-center justify-center px-8 text-center">
        <div className="size-11 rounded-[var(--radius-lg)] border border-dashed border-[var(--border-strong)] grid place-items-center">
          <svg viewBox="0 0 24 24" className="size-5 text-[var(--text-subtle)]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H15l4 4v12.5A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-15Z" />
            <path d="M14.5 3v4.5H19M8.5 12h7M8.5 16h4.5" />
          </svg>
        </div>
        <div className="text-[13.5px] font-medium mt-3">把这一节收成一张笔记卡</div>
        <p className="text-[12px] text-[var(--text-muted)] mt-1.5 leading-relaxed max-w-[34ch]">
          正文
          {note?.card_sources ? ` 和你提的 ${note.card_sources} 个问题` : ''}
          会汇成一张笔记，AI 先写一版草稿，然后由你改成自己的话。
        </p>
        <Button
          variant={completed ? 'primary' : 'outline'}
          size="sm"
          onClick={() => generate()}
          className="mt-4"
        >
          生成本节笔记
        </Button>
        {!completed && (
          <div className="text-[11px] text-[var(--text-subtle)] mt-2">
            建议读完这一节再生成，素材更全
          </div>
        )}
      </div>
    )
  }

  /* ── 已有笔记：读 / 改 ── */
  const body = note.content || ''
  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-[var(--border)]">
        <span className="text-[12.5px] font-medium">本节笔记</span>
        {note.state === 'draft' ? (
          <span className="text-[11px] px-1.5 py-[1px] rounded-[4px] bg-[var(--bg-sunken)] text-[var(--text-muted)]">
            草稿 · 未保存进仓库
          </span>
        ) : (
          <span className="text-[11px] px-1.5 py-[1px] rounded-[4px] bg-[color-mix(in_oklch,var(--sem-ok)_14%,transparent)] text-[var(--sem-ok)]">
            已保存
          </span>
        )}
        {note.edited && (
          <span className="text-[11px] text-[var(--sem-rewritten,var(--accent))]">已改写</span>
        )}
        <div className="grow" />
        {saving ? (
          <span className="text-[11px] text-[var(--text-subtle)]">保存中…</span>
        ) : (
          savedAt && <span className="text-[11px] text-[var(--text-subtle)]">已保存 {savedAt}</span>
        )}
        {editing ? (
          <Button size="xs" variant="outline" onClick={() => setEditing(false)}>
            完成
          </Button>
        ) : (
          <Button size="xs" variant="outline" onClick={startEdit}>
            修改
          </Button>
        )}
        {note.state === 'draft' && (
          <Button
            size="xs"
            variant="primary"
            onClick={() => toVault(editing ? draftText : body)}
            loading={saving}
          >
            收进仓库
          </Button>
        )}
      </div>

      <div className="grow min-h-0 overflow-y-auto">
        {editing ? (
          <div className="px-5 py-4">
            {/* 点哪改哪：读的时候是排好的版，只有点中的那一段变成小编辑框 ——
                不必面对整篇 ## 和 $O(n^2)$ 的源码 */}
            <NoteEditor value={draftText} onChange={onEdit} />
            <div className="text-[11px] text-[var(--text-subtle)] mt-5 leading-relaxed">
              点任意一段就能改，改完点别处或按 Esc。「我的理解」「我还没搞懂的」两节是
              特意留空的 —— 那两处是这份笔记里最值钱的地方。
            </div>
          </div>
        ) : (
          <div className="px-4 py-4">
            <Markdown variant="read">{body}</Markdown>

            {/* 原稿一直留着：知道原版还在，才敢大胆删改 */}
            {note.edited && note.ai_draft && (
              <div className="mt-8 pt-4 border-t border-[var(--border)]">
                <button
                  onClick={() => setShowAiDraft((v) => !v)}
                  className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
                >
                  {showAiDraft ? '收起 AI 原稿' : '看看 AI 原来写的'}
                </button>
                {showAiDraft && (
                  <div className="mt-3 opacity-70">
                    <Markdown variant="read">{note.ai_draft}</Markdown>
                  </div>
                )}
              </div>
            )}

            <div className="mt-8 pt-4 border-t border-[var(--border)] flex items-center gap-2 flex-wrap">
              <Button size="xs" variant="ghost" onClick={() => generate(true)}>
                重新生成一份
              </Button>
              <span className="text-[11px] text-[var(--text-subtle)]">
                不会覆盖现在这张 —— 新的会另建一张，你自己挑
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
