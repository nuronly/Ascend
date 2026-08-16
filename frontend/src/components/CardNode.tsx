import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Markdown } from './Markdown'
import { SelectionPopover } from './SelectionPopover'
import { useSelection } from './useSelection'
import { useCardSpace } from '@/lib/cardSpace'
import type { Card } from '@/lib/types'
import { cn, truncate, widthForDepth } from '@/lib/utils'

/**
 * ★ 卡片本体（PLAN §3.2.0）
 *
 * ┌─────────────────────────────┐
 * │ ⟨softmax⟩            1a  ⋮ │  划中的词 + Luhmann 编号 + 菜单
 * ├─────────────────────────────┤
 * │ 引：……通过 softmax 归一化…… │  原文语境（可折叠）
 * ├─────────────────────────────┤
 * │ Q: 这是什么？                │
 * │ A: softmax 是一种把向量映射   │  ← ★ 此区域文本【可再划词】
 * │    为概率分布的[归一化]函数… │     铁律 #1，不做这个整个产品就垮了
 * │ Q: 那它和 sigmoid 区别？     │  ← 同一张卡内可多轮
 * ├─────────────────────────────┤
 * │ ✎ 我的话：______________     │  ← 己见（也可划词）
 * ├─────────────────────────────┤
 * │ [收进仓库] [折叠] [删除]      │
 * └─────────────────────────────┘
 *
 * 视觉层级不靠颜色（颜色留给语义层）：尺寸递减 + 明度递降 + 编号长度。
 */

export interface CardNodeData extends Record<string, unknown> {
  card: Card
}

const NEST_HINT_KEY = 'ladder-seen-nest-hint'

/**
 * 「回答里也能选词」的一次性提示。
 *
 * 这是四条铁律里的第一条，也是整个产品区别于普通 chat 的关键 ——
 * 但它在界面上同样是不可见的。用户看到 AI 回答后的本能是继续在
 * 输入框里打字（那就退回一维 chat 了），必须主动告诉他还能往下钻。
 */
function useOnceHint(key: string): [boolean, () => void] {
  const [seen, setSeen] = useState(() => {
    try {
      return localStorage.getItem(key) === '1'
    } catch {
      return true
    }
  })
  const dismiss = () => {
    try {
      localStorage.setItem(key, '1')
    } catch {
      /* 隐私模式写不了，无所谓 */
    }
    setSeen(true)
  }
  return [seen, dismiss]
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn('size-3 transition-transform', open && 'rotate-90')}
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

/** AI 回答块 —— 这里必须可划词，否则套娃不成立。 */
function AnswerBlock({
  card,
  messageId,
  content,
  streaming,
}: {
  card: Card
  messageId: string
  content: string
  streaming?: boolean
}) {
  const { ref, selection, clear } = useSelection(!streaming)
  const createAndAsk = useCardSpace((s) => s.createAndAsk)

  return (
    <>
      <div
        ref={ref}
        className={cn('prose-card select-text cursor-text', streaming && 'stream-caret')}
      >
        <Markdown variant="card">{content}</Markdown>
      </div>
      <SelectionPopover
        selection={selection}
        label="追问"
        hint="将生成子卡"
        onClose={clear}
        onAsk={(q) => {
          createAndAsk(
            {
              selected_text: selection!.text,
              context_text: selection!.sentence,
              text_anchor: {
                exact: selection!.text,
                prefix: selection!.prefix,
                suffix: selection!.suffix,
                in: 'answer',
              },
              parent_card_id: card.id,
              origin: 'parent_answer',
              origin_message_id: messageId,
              origin_offset: { start: selection!.start, end: selection!.end },
            },
            q,
          )
          clear()
        }}
      />
    </>
  )
}

/** 己见区 —— 用户常在自述中发现新疑问，所以这里同样可划词。 */
function NoteBlock({ card }: { card: Card }) {
  const saveNote = useCardSpace((s) => s.saveNote)
  const createAndAsk = useCardSpace((s) => s.createAndAsk)
  const [editing, setEditing] = useState(!card.user_note)
  const [value, setValue] = useState(card.user_note)
  const { ref, selection, clear } = useSelection(!editing)
  const taRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => setValue(card.user_note), [card.user_note])

  const autoSize = useCallback(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [])

  useEffect(autoSize, [value, editing, autoSize])

  if (editing) {
    return (
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => {
          setValue(e.target.value)
          saveNote(card.id, e.target.value)
        }}
        onBlur={() => value.trim() && setEditing(false)}
        placeholder="用你自己的话重写一遍 —— 改过的卡才算真正想过"
        rows={2}
        className={cn(
          'nodrag w-full px-2 py-1.5 text-[12.5px] leading-relaxed resize-none',
          'bg-transparent border border-dashed border-[var(--border-strong)]',
          'rounded-[var(--radius-sm)] placeholder:text-[var(--text-subtle)]',
          'focus:outline-none focus:border-solid focus:border-[var(--sem-rewritten)]',
        )}
      />
    )
  }

  return (
    <>
      <div
        ref={ref}
        onDoubleClick={() => setEditing(true)}
        title="双击编辑 · 划词可继续追问"
        className={cn(
          'px-2 py-1.5 text-[12.5px] leading-relaxed cursor-text select-text',
          'border-l-2 border-[var(--sem-rewritten)]',
          'bg-[color-mix(in_oklch,var(--sem-rewritten)_6%,transparent)]',
          'rounded-r-[var(--radius-sm)] whitespace-pre-wrap break-words',
        )}
      >
        {value}
      </div>
      <SelectionPopover
        selection={selection}
        label="追问"
        hint="从你自己的理解里追问"
        onClose={clear}
        onAsk={(q) => {
          createAndAsk(
            {
              selected_text: selection!.text,
              context_text: selection!.sentence,
              text_anchor: { exact: selection!.text, prefix: selection!.prefix, in: 'note' },
              parent_card_id: card.id,
              origin: 'parent_note',
              origin_offset: { start: selection!.start, end: selection!.end },
            },
            q,
          )
          clear()
        }}
      />
    </>
  )
}

export const CardNode = memo(function CardNode({ data }: NodeProps) {
  const { card } = data as CardNodeData
  const streaming = useCardSpace((s) => s.streaming[card.id])
  const busy = useCardSpace((s) => s.busy.has(card.id))
  const isHovered = useCardSpace((s) => s.hoverCardId === card.id)
  // 焦点态从 store 订阅而非走 node.selected：
  // 后者会让 focus 一变就重建整个 nodes 数组，同屏所有卡片跟着重绘
  const selected = useCardSpace((s) => s.focusCardId === card.id)
  const setHover = useCardSpace((s) => s.setHover)
  const setFocus = useCardSpace((s) => s.setFocus)
  const { ask, toVault, toggleCollapse, remove, stopStreaming, regenerate } = useCardSpace()

  const [followUp, setFollowUp] = useState('')
  const [showContext, setShowContext] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [showNote, setShowNote] = useState(!!card.user_note)
  const [nestHintSeen, dismissNestHint] = useOnceHint(NEST_HINT_KEY)

  const width = widthForDepth(card.depth)
  const isVault = card.state === 'vault'
  const messages = card.messages ?? []
  // 只在「第一张根卡刚拿到回答」时提示一次，之后永不打扰
  const showNestHint =
    !nestHintSeen &&
    !card.parent_card_id &&
    streaming === undefined &&
    messages.some((m) => m.role === 'assistant' && m.content)

  // 折叠态：只剩一个标题条，链再长也不会淹没屏幕
  if (card.collapsed) {
    return (
      <div
        style={{ width: Math.max(200, width * 0.62) }}
        onMouseEnter={() => setHover(card.id)}
        onMouseLeave={() => setHover(null)}
        onClick={() => toggleCollapse(card.id)}
        className={cn(
          'flex items-center gap-2 h-9 px-2.5 cursor-pointer',
          'bg-[var(--bg-raised)] border rounded-[var(--radius)]',
          'shadow-[var(--shadow-float)] transition-all',
          isVault ? 'border-solid border-[var(--border-strong)]' : 'border-dashed border-[var(--border)]',
          (selected || isHovered) && 'ring-2 ring-[color-mix(in_oklch,var(--accent)_35%,transparent)]',
        )}
      >
        <Handle type="target" position={Position.Left} />
        <Handle type="source" position={Position.Right} />
        <span className="text-[12.5px] font-medium truncate grow">
          {card.selected_text || truncate(card.question, 24)}
        </span>
        {card.is_rewritten && (
          <span className="size-1.5 rounded-full bg-[var(--sem-rewritten)] shrink-0" title="己见卡" />
        )}
        <Chevron open={false} />
      </div>
    )
  }

  return (
    <div
      style={{ width }}
      onMouseEnter={() => setHover(card.id)}
      onMouseLeave={() => setHover(null)}
      onClick={() => setFocus(card.id)}
      className={cn(
        'flex flex-col bg-[var(--bg-raised)] rounded-[var(--radius-lg)]',
        // 己见卡实心描边，AI 原生卡虚线描边（PLAN §4.3.2）
        isVault ? 'border border-[var(--border-strong)]' : 'border border-dashed border-[var(--border)]',
        card.is_rewritten && 'border-l-2 border-l-[var(--sem-rewritten)]',
        // 唯一允许用阴影的地方：卡片要"浮在旁边"而非"压在上面"
        'shadow-[var(--shadow-float)] transition-shadow',
        (selected || isHovered) &&
          'ring-2 ring-[color-mix(in_oklch,var(--accent)_32%,transparent)] shadow-[var(--shadow-pop)]',
      )}
    >
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />

      {/* ── 头部（可拖拽区域）── */}
      <div className="drag-handle cursor-grab active:cursor-grabbing flex items-center gap-1.5 px-2.5 h-8 border-b border-[var(--border)] shrink-0">
        <span className="text-[12.5px] font-semibold text-[var(--accent)] truncate grow min-w-0">
          ⟨{truncate(card.selected_text || card.question, 22)}⟩
        </span>
        {card.depth > 0 && (
          <span
            className="font-mono text-[10px] text-[var(--text-subtle)] shrink-0 tabular-nums"
            title="追问链深度"
          >
            L{card.depth + 1}
          </span>
        )}
        {isVault && (
          <span className="size-1.5 rounded-full bg-[var(--sem-ok)] shrink-0" title="已收进仓库" />
        )}
        <div className="relative shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation()
              setMenuOpen((v) => !v)
            }}
            className="nodrag size-5 flex items-center justify-center rounded-[var(--radius-sm)] text-[var(--text-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
          >
            <svg viewBox="0 0 24 24" className="size-3.5" fill="currentColor">
              <circle cx="12" cy="5" r="1.6" />
              <circle cx="12" cy="12" r="1.6" />
              <circle cx="12" cy="19" r="1.6" />
            </svg>
          </button>
          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
              <div className="nodrag absolute right-0 top-6 z-20 w-36 py-1 bg-[var(--bg-raised)] border border-[var(--border)] rounded-[var(--radius)] shadow-[var(--shadow-pop)]">
                {[
                  { label: '折叠', fn: () => toggleCollapse(card.id) },
                  ...(messages.length
                    ? [{ label: '重答最后一问', fn: () => regenerate(card.id) }]
                    : []),
                  { label: showNote ? '隐藏己见' : '写我的话', fn: () => setShowNote((v) => !v) },
                ].map((it) => (
                  <button
                    key={it.label}
                    onClick={() => {
                      it.fn()
                      setMenuOpen(false)
                    }}
                    className="w-full px-2.5 py-1.5 text-left text-[12px] hover:bg-[var(--bg-hover)]"
                  >
                    {it.label}
                  </button>
                ))}
                <div className="my-1 h-px bg-[var(--border)]" />
                <button
                  onClick={() => {
                    setMenuOpen(false)
                    if (confirm('删除这张卡？它的子卡会一并删除。')) remove(card.id)
                  }}
                  className="w-full px-2.5 py-1.5 text-left text-[12px] text-[var(--sem-danger)] hover:bg-[color-mix(in_oklch,var(--sem-danger)_10%,transparent)]"
                >
                  删除
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ── 引：原文语境 ── */}
      {card.context_text && (
        <div className="px-2.5 pt-1.5 shrink-0">
          <button
            onClick={() => setShowContext((v) => !v)}
            className="nodrag flex items-start gap-1 w-full text-left text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
          >
            <span className="mt-[3px] shrink-0">
              <Chevron open={showContext} />
            </span>
            <span className={cn('leading-relaxed', !showContext && 'truncate')}>
              引：{card.context_text}
            </span>
          </button>
        </div>
      )}

      {/* ── 对话区 ── */}
      <div className="nowheel px-2.5 py-2 space-y-2.5 overflow-y-auto max-h-[440px] grow">
        {messages.map((m) =>
          m.role === 'user' ? (
            <div key={m.id} className="flex gap-1.5">
              <span className="shrink-0 text-[11px] font-semibold text-[var(--text-subtle)] mt-[1px]">
                Q
              </span>
              <span className="text-[12.5px] leading-relaxed text-[var(--text-muted)] break-words">
                {m.content}
              </span>
            </div>
          ) : (
            <div key={m.id} className="flex gap-1.5">
              <span className="shrink-0 text-[11px] font-semibold text-[var(--accent)] mt-[1px]">
                A
              </span>
              <div className="min-w-0 grow nodrag">
                <AnswerBlock card={card} messageId={m.id} content={m.content} />
              </div>
            </div>
          ),
        )}

        {streaming !== undefined && (
          <div className="flex gap-1.5">
            <span className="shrink-0 text-[11px] font-semibold text-[var(--accent)] mt-[1px]">
              A
            </span>
            <div className="min-w-0 grow nodrag">
              {streaming ? (
                <div className="prose-card stream-caret">
                  <Markdown variant="card" streaming>
                    {streaming}
                  </Markdown>
                </div>
              ) : (
                <div className="space-y-1.5 py-0.5">
                  <div className="skeleton h-2.5 w-4/5" />
                  <div className="skeleton h-2.5 w-full" />
                  <div className="skeleton h-2.5 w-2/3" />
                </div>
              )}
            </div>
          </div>
        )}

        {!messages.length && streaming === undefined && (
          <div className="text-[12px] text-[var(--text-subtle)] py-1">还没有提问</div>
        )}

        {/* 铁律 #1 的引导：回答里的词同样能选 */}
        {showNestHint && (
          <div className="nodrag flex items-start gap-1.5 mt-1 px-2 py-1.5 rounded-[var(--radius-sm)] border border-dashed border-[var(--border-strong)] bg-[var(--bg-sunken)]">
            <span className="text-[11px] leading-[1.6] text-[var(--text-muted)] grow">
              上面这段回答里的词<b className="text-[var(--text)]">也能选中</b>
              —— 选一个还不懂的，会长出一张子卡。
            </span>
            <button
              onClick={dismissNestHint}
              className="shrink-0 text-[10.5px] text-[var(--accent)] hover:underline mt-[1px]"
            >
              知道了
            </button>
          </div>
        )}
      </div>

      {/* ── 己见 ── */}
      {showNote && (
        <div className="px-2.5 pb-2 shrink-0 nodrag">
          <div className="flex items-center gap-1 mb-1 text-[10.5px] text-[var(--text-subtle)]">
            <span>✎ 我的话</span>
            {!card.is_rewritten && <span className="opacity-70">· 改一句，这张卡才算你的</span>}
          </div>
          <NoteBlock card={card} />
        </div>
      )}

      {/* ── 追问输入 + 操作 ── */}
      <div className="border-t border-[var(--border)] shrink-0">
        <div className="flex items-center gap-1 px-2 py-1.5 nodrag">
          <input
            value={followUp}
            onChange={(e) => setFollowUp(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && followUp.trim() && !busy) {
                ask(card.id, followUp.trim())
                setFollowUp('')
              }
            }}
            disabled={busy}
            placeholder="继续追问…"
            className="grow min-w-0 h-6 px-1.5 text-[12px] bg-transparent placeholder:text-[var(--text-subtle)] focus:outline-none disabled:opacity-50"
          />
          {busy ? (
            <button
              onClick={() => stopStreaming(card.id)}
              className="shrink-0 h-6 px-2 text-[11.5px] rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
            >
              停止
            </button>
          ) : (
            <>
              {!showNote && (
                <button
                  onClick={() => setShowNote(true)}
                  title="写下自己的理解"
                  className="shrink-0 h-6 px-2 text-[11.5px] rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
                >
                  ✎
                </button>
              )}
              {!isVault && messages.length > 0 && (
                <button
                  onClick={() => toVault(card.id)}
                  className="shrink-0 h-6 px-2 text-[11.5px] font-medium rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)]"
                >
                  收进仓库
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
},
/**
 * ★ 拖动流畅度的最后一块拼图。
 *
 * React Flow 在拖动时**每一帧**都会更新 positionAbsoluteX/Y、dragging
 * 这些 props。默认的浅比较会因此判定「props 变了」，于是整张卡片
 * —— 连同里面的 Markdown 渲染和代码高亮 —— 每帧重绘一次。
 * 十几张卡同屏时必然掉帧。
 *
 * 而位置其实是 React Flow 通过外层容器的 transform 施加的，
 * 卡片内容根本不需要知道自己在哪。所以只比较真正影响渲染的东西：
 * 卡片数据本身。其余状态（流式内容、hover、focus）都是从 store
 * 单独订阅的，不走 props，各自精准更新。
 */
(prev, next) =>
  prev.id === next.id &&
  (prev.data as CardNodeData).card === (next.data as CardNodeData).card)
