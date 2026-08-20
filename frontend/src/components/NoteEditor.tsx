import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Markdown } from '@/components/Markdown'
import {
  continueList,
  isHeading,
  joinBlocks,
  splitBlocks,
  togglePrefix,
  toggleWrap,
} from '@/lib/mdBlocks'
import { cn } from '@/lib/utils'

/**
 * ★ 笔记编辑器：点哪改哪
 *
 * 「一点修改，整篇变成 ## 和 $O(n^2)$ 的源码」是反人类的 —— 读的时候是排好的
 * 版，改的时候突然掉进源码里，尤其这种全是公式的笔记。
 *
 * 但根源不是"没有富文本"，而是**一次面对太多源码**。所以这里把粒度降到块：
 *   · 读态：整篇都是渲染好的，跟正文一个样
 *   · 点中某一段：只有那一段变成几行的小编辑框，公式只在你正在改的块里露原形
 *   · 改完点别处 / Esc：立刻渲染回去
 *
 * 顺带免费得到了块级操作（删这条、在下面加一条），那本来要单独做。
 * 也没有引入第二套渲染路径 —— 预览和正文用的是同一个 Markdown 组件，
 * 样式永远不会漂。
 *
 * 富文本编辑器（ProseMirror 系）留到真的需要拖拽块、粘贴富文本时再上；
 * 那要付三笔账：多一套渲染、Markdown 往返被规范化、KaTeX 得自己接成节点。
 */

interface Props {
  value: string
  onChange: (md: string) => void
  className?: string
}

const TOOLS: { label: string; title: string; apply: 'wrap' | 'prefix'; token: string }[] = [
  { label: 'B', title: '加粗  ⌘B', apply: 'wrap', token: '**' },
  { label: 'I', title: '斜体  ⌘I', apply: 'wrap', token: '*' },
  { label: '‹›', title: '行内代码', apply: 'wrap', token: '`' },
  { label: 'H2', title: '二级标题', apply: 'prefix', token: '## ' },
  { label: 'H3', title: '三级标题', apply: 'prefix', token: '### ' },
  { label: '•', title: '列表', apply: 'prefix', token: '- ' },
  { label: '❝', title: '引用', apply: 'prefix', token: '> ' },
]

export default function NoteEditor({ value, onChange, className }: Props) {
  const blocks = useMemo(() => splitBlocks(value), [value])
  const [active, setActive] = useState<number | null>(null)
  const [text, setText] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)

  /** 进入某块的编辑态 */
  const enter = useCallback(
    (i: number) => {
      setActive(i)
      setText(blocks[i] ?? '')
    },
    [blocks],
  )

  /** 退出编辑：把这一块写回整篇 */
  const commit = useCallback(
    (nextText?: string) => {
      if (active === null) return
      const body = nextText ?? text
      const next = [...blocks]
      if (body.trim()) next[active] = body
      else next.splice(active, 1) // 清空 = 删掉这一块
      setActive(null)
      const joined = joinBlocks(next)
      if (joined !== value) onChange(joined)
    },
    [active, blocks, onChange, text, value],
  )

  // 编辑框高度跟着内容长 —— 不出现内部滚动条，视觉上仍像正文的一段
  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text, active])

  useEffect(() => {
    if (active !== null) taRef.current?.focus()
  }, [active])

  /** 工具条与快捷键共用：改文本 + 摆好光标 */
  const applyTool = (apply: 'wrap' | 'prefix', token: string) => {
    const el = taRef.current
    if (!el) return
    const { selectionStart: s, selectionEnd: e } = el
    if (apply === 'wrap') {
      const r = toggleWrap(text, s, e, token)
      setText(r.text)
      requestAnimationFrame(() => el.setSelectionRange(r.start, r.end))
    } else {
      const r = togglePrefix(text, s, token)
      setText(r.text)
      requestAnimationFrame(() => el.setSelectionRange(r.caret, r.caret))
    }
  }

  const onKeyDown = (ev: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const meta = ev.metaKey || ev.ctrlKey
    if (ev.key === 'Escape') {
      ev.preventDefault()
      commit()
      return
    }
    if (meta && (ev.key === 'Enter' || ev.key === 's')) {
      ev.preventDefault()
      commit()
      return
    }
    if (meta && (ev.key === 'b' || ev.key === 'i')) {
      ev.preventDefault()
      applyTool('wrap', ev.key === 'b' ? '**' : '*')
      return
    }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      const el = ev.currentTarget
      const r = continueList(text, el.selectionStart)
      if (r) {
        ev.preventDefault()
        setText(r.text)
        requestAnimationFrame(() => el.setSelectionRange(r.caret, r.caret))
      }
    }
  }

  const insertAfter = (i: number) => {
    const next = [...blocks]
    next.splice(i + 1, 0, '')
    setActive(i + 1)
    setText('')
    // 空块先不落进 value（避免留下空段），等 commit 时再写
    void next
  }

  if (!blocks.length) {
    return (
      <div className={className}>
        <EmptyLine onClick={() => { setActive(0); setText('') }} />
        {active === 0 && (
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => commit()}
            placeholder="写下你自己的说法…"
            className="w-full mt-2 p-2.5 rounded-[var(--radius)] bg-[var(--bg)] border border-[var(--accent)] outline-none text-[13.5px] leading-[1.85] font-mono resize-none"
          />
        )}
      </div>
    )
  }

  return (
    <div className={cn('space-y-1', className)}>
      {blocks.map((b, i) =>
        active === i ? (
          <div key={`edit-${i}`} className="rounded-[var(--radius)] bg-[var(--bg-sunken)] p-1.5">
            {/* 工具条：把 Markdown 标记藏到按钮后面，用户不必记语法 */}
            <div className="flex items-center gap-0.5 px-0.5 pb-1.5">
              {TOOLS.map((t) => (
                <button
                  key={t.label}
                  title={t.title}
                  // mousedown 里阻止默认，否则 textarea 先失焦，选区就丢了
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => applyTool(t.apply, t.token)}
                  className="h-6 min-w-6 px-1.5 rounded-[var(--radius-sm)] text-[11.5px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] transition-colors"
                >
                  {t.label}
                </button>
              ))}
              <div className="grow" />
              <span className="text-[10.5px] text-[var(--text-subtle)] pr-1">
                Esc 完成 · 清空则删除
              </span>
            </div>
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
              onBlur={() => commit()}
              spellCheck={false}
              className={cn(
                'w-full p-2.5 rounded-[var(--radius)] resize-none',
                'bg-[var(--bg)] border border-[var(--accent)] outline-none',
                'text-[13.5px] leading-[1.85] font-mono',
              )}
            />
          </div>
        ) : (
          <div key={`read-${i}`} className="group relative">
            <button
              onClick={() => enter(i)}
              className={cn(
                'block w-full text-left px-2.5 py-1 -mx-2.5 rounded-[var(--radius)]',
                'hover:bg-[var(--bg-hover)] transition-colors cursor-text',
              )}
            >
              {/* 只有标题、下面没内容 = 留白位置，点它就是开始写 */}
              {isHeading(b) && !blocks[i + 1] ? (
                <>
                  <Markdown variant="read">{b}</Markdown>
                  <div className="text-[12.5px] text-[var(--accent)] mt-1">
                    点这里写下你自己的说法…
                  </div>
                </>
              ) : (
                <Markdown variant="read">{b}</Markdown>
              )}
            </button>
            <button
              title="在下面加一段"
              onClick={() => insertAfter(i)}
              className="absolute -left-6 top-1 size-5 hidden group-hover:grid place-items-center rounded-[var(--radius-sm)] text-[var(--text-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <path d="M12 5v14M5 12h14" />
              </svg>
            </button>
          </div>
        ),
      )}

      {/* 末尾追加 */}
      <EmptyLine
        onClick={() => {
          setActive(blocks.length)
          setText('')
        }}
      />
      {active === blocks.length && (
        <div className="rounded-[var(--radius)] bg-[var(--bg-sunken)] p-1.5">
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={() => {
              if (text.trim()) onChange(joinBlocks([...blocks, text]))
              setActive(null)
            }}
            placeholder="继续写…"
            className="w-full p-2.5 rounded-[var(--radius)] bg-[var(--bg)] border border-[var(--accent)] outline-none text-[13.5px] leading-[1.85] font-mono resize-none"
          />
        </div>
      )}
    </div>
  )
}

function EmptyLine({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left px-2.5 py-2 -mx-2.5 rounded-[var(--radius)] text-[12.5px] text-[var(--text-subtle)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-muted)] transition-colors"
    >
      ＋ 在这里继续写…
    </button>
  )
}
