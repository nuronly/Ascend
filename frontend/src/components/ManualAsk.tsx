import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useCardSpace } from '@/lib/cardSpace'
import { cn } from '@/lib/utils'

/**
 * 不划词，直接建卡。
 *
 * 划词覆盖不了一类真实的疑问：整体性的问题 ——
 * 「这节和上节什么关系」「为什么要这么设计」——
 * 它们在正文里找不到一个可以划的词。
 *
 * 视觉刻意与 SelectionPopover 保持一致（同样的输入框、Enter 提交、
 * 同样的「建卡」按钮），让用户觉得这是同一件事的两个入口，
 * 而不是另一个功能。差别只有：没有引文那一行。
 */

function AskDialog({ onClose }: { onClose: () => void }) {
  const [question, setQuestion] = useState('')
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const createAndAsk = useCardSpace((s) => s.createAndAsk)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = () => {
    const q = question.trim()
    if (!q) return
    // selected_text 留空：手动卡没有划中的文本，
    // 卡片标题由 CardNode 自动回落到 question
    createAndAsk(
      { selected_text: '', context_text: '', text_anchor: {}, origin: 'manual' },
      q,
    )
    onClose()
  }

  return createPortal(
    <>
      <div className="fixed inset-0 z-[59] bg-black/20 animate-fade-in" onClick={onClose} />
      <div
        className={cn(
          'fixed z-[60] left-1/2 top-[22vh] -translate-x-1/2 w-[min(92vw,420px)]',
          'bg-[var(--bg-raised)] border border-[var(--border-strong)]',
          'rounded-[var(--radius-lg)] shadow-[var(--shadow-pop)] overflow-hidden animate-pop-in',
        )}
        role="dialog"
        aria-label="直接提问"
      >
        <div className="px-3.5 pt-3 pb-2 border-b border-[var(--border)]">
          <div className="text-[13px] font-semibold">直接提问</div>
          <div className="text-[11.5px] text-[var(--text-subtle)] mt-0.5 leading-relaxed">
            不用划词。适合问整节的问题，比如「这节和上一节什么关系」。
          </div>
        </div>
        <textarea
          ref={inputRef}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
            if (e.key === 'Escape') onClose()
          }}
          placeholder="想问什么？"
          rows={4}
          className={cn(
            'w-full px-3.5 py-2.5 text-[13px] leading-relaxed bg-transparent resize-none',
            'placeholder:text-[var(--text-subtle)] focus:outline-none',
          )}
        />
        <div className="px-3 pb-2.5 flex items-center justify-between">
          <span className="text-[10.5px] text-[var(--text-subtle)]">
            Enter 提问 · Shift+Enter 换行
          </span>
          <div className="flex gap-1.5">
            <button
              onClick={onClose}
              className="h-6 px-2 text-[12px] rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
            >
              取消
            </button>
            <button
              onClick={submit}
              disabled={!question.trim()}
              className={cn(
                'h-6 px-2.5 text-[12px] font-medium rounded-[var(--radius-sm)]',
                'bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)]',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              建卡
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  )
}

const ICON = (
  <svg
    viewBox="0 0 24 24"
    className="size-3.5 shrink-0"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M12 5.5v13M5.5 12h13" />
  </svg>
)

/** 空状态里的入口：与「划词」并列的第二条路 */
export function ManualAskInline() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className={cn(
          'flex items-center gap-1.5 h-7 px-3 rounded-full',
          'border border-[var(--border)] text-[12px] text-[var(--text-muted)]',
          'hover:text-[var(--text)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
          'transition-colors',
        )}
      >
        {ICON}
        不划词，直接提问
      </button>
      {open && <AskDialog onClose={() => setOpen(false)} />}
    </>
  )
}

/** 画布上的入口：和「全览」并排的小按钮 */
export function ManualAskToolbarButton() {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="不划词，直接提一个问题"
        className={cn(
          'flex items-center gap-1.5 h-6 px-2 rounded-[var(--radius-sm)]',
          'bg-[var(--bg-raised)] border border-[var(--border)]',
          'text-[12px] text-[var(--text-muted)]',
          'hover:text-[var(--text)] hover:border-[var(--border-strong)] transition-colors',
        )}
      >
        {ICON}
        提问
      </button>
      {open && <AskDialog onClose={() => setOpen(false)} />}
    </>
  )
}
