import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { SelectionInfo } from './useSelection'
import { cn, truncate } from '@/lib/utils'

/**
 * 划词后就地浮出的提问框。
 *
 * 定位刻意用 fixed + portal：卡片空间是可平移缩放的画布，
 * 如果按绝对定位挂在容器里，画布一动按钮就飞了。
 */
export function SelectionPopover({
  selection,
  onAsk,
  onClose,
  label = '就这里提问',
  hint,
}: {
  selection: SelectionInfo | null
  onAsk: (question: string) => void
  onClose: () => void
  label?: string
  hint?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const [question, setQuestion] = useState('')
  const boxRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  useEffect(() => {
    setExpanded(false)
    setQuestion('')
  }, [selection?.start, selection?.text])

  useLayoutEffect(() => {
    if (!selection) return
    const w = expanded ? 340 : 132
    const h = expanded ? 150 : 34
    // 贴住选区末端，并夹回视口内
    let x = selection.x + 6
    let y = selection.y + 8
    if (x + w > window.innerWidth - 12) x = window.innerWidth - w - 12
    if (y + h > window.innerHeight - 12) y = Math.max(12, selection.y - h - 10)
    setPos({ x: Math.max(12, x), y })
  }, [selection, expanded])

  useEffect(() => {
    if (expanded) inputRef.current?.focus()
  }, [expanded])

  if (!selection) return null

  const submit = () => {
    onAsk(question.trim() || `「${selection.text}」是什么意思？`)
    onClose()
  }

  return createPortal(
    <div
      ref={boxRef}
      data-selection-ui
      className="fixed z-[60] animate-pop-in"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.preventDefault() /* 别让点击清掉选区 */}
    >
      {!expanded ? (
        <button
          onClick={() => setExpanded(true)}
          className={cn(
            'flex items-center gap-1.5 h-[30px] px-2.5 rounded-[var(--radius)]',
            'bg-[var(--accent)] text-[var(--accent-text)] text-[12.5px] font-medium',
            'shadow-[var(--shadow-pop)] hover:bg-[var(--accent-hover)] transition-colors',
          )}
        >
          <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M9.1 9a3 3 0 1 1 4.2 2.8c-.8.4-1.3 1.1-1.3 2v.4M12 17.5h.01" strokeLinecap="round" />
            <circle cx="12" cy="12" r="9.5" />
          </svg>
          {label}
        </button>
      ) : (
        <div
          className={cn(
            'w-[340px] bg-[var(--bg-raised)] border border-[var(--border-strong)]',
            'rounded-[var(--radius-lg)] shadow-[var(--shadow-pop)] overflow-hidden',
          )}
        >
          <div className="px-3 pt-2.5 pb-1.5 flex items-baseline gap-2 border-b border-[var(--border)]">
            <span className="text-[13px] font-semibold text-[var(--accent)] shrink-0">
              ⟨{truncate(selection.text, 18)}⟩
            </span>
            {hint && <span className="text-[11px] text-[var(--text-subtle)] truncate">{hint}</span>}
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
            placeholder="想问什么？留空则默认问「这是什么意思」"
            rows={3}
            className={cn(
              'w-full px-3 py-2 text-[13px] leading-relaxed bg-transparent resize-none',
              'placeholder:text-[var(--text-subtle)] focus:outline-none',
            )}
          />
          <div className="px-2.5 pb-2 flex items-center justify-between">
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
                className="h-6 px-2.5 text-[12px] font-medium rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)]"
              >
                建卡
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body,
  )
}
