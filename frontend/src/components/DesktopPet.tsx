import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api, sse } from '@/lib/api'
import { openPip, pipSupported, type PipHandle } from '@/lib/pip'
import { Pet, type PetMood } from '@/components/Pet'
import { Spinner } from '@/components/ui'
import { cn } from '@/lib/utils'

/**
 * 桌宠：一个常驻角落的小东西，会主动提起你该做的事，也能替你问第二大脑。
 *
 * ★ 它存在的理由是「**主动**」
 *   第二大脑是你问它才答。而收藏夹式产品真正的死因不是收不进去，是收了没人提。
 *   桌宠常驻，可以自己冒泡：该复习了、那一节划了词还没收成笔记、
 *   你自己写过「还没搞懂」的那个点。
 *   这些话通用助手一句都说不出来 —— 它没有你三个月前的困惑。
 *
 * ★ 它**不闲聊**
 *   第二大脑的立身之本是「只回答你自己学过的东西，检索不到就直说」。
 *   桌宠一旦能用通用知识兜底，用户就分不清哪句话是从他的记录里来的 ——
 *   可溯源这个最贵的资产当场作废。
 *   所以输入框直接转给 /brain/ask，一个字都不额外加工；它自己只负责**提起**。
 *
 * ★ 真·置顶靠 Document PiP
 *   浏览器里的 DOM 出不了标签页。支持的浏览器点「弹出」会得到一个操作系统级
 *   小窗（切到编辑器它还在）；不支持的就留在页面角落 —— 功能一样，
 *   只是切窗口看不见。见 lib/pip.ts。
 */

interface Nudge {
  kind: string
  text: string
  route: string
  cta: string
  ask?: string
}

const POS_KEY = 'ladder.pet.pos'
const HIDE_KEY = 'ladder.pet.hidden'

/** 贴边留白。太小会被浏览器滚动条压住 */
const EDGE = 18

function loadPos(): { x: number; y: number } {
  try {
    const raw = JSON.parse(localStorage.getItem(POS_KEY) || 'null')
    if (raw && typeof raw.x === 'number' && typeof raw.y === 'number') return raw
  } catch {
    /* 存坏了就用默认位置 */
  }
  return { x: -1, y: -1 } // -1 = 还没拖过，用右下角
}

export default function DesktopPet() {
  const nav = useNavigate()
  const [hidden, setHidden] = useState(() => localStorage.getItem(HIDE_KEY) === '1')
  const [pos, setPos] = useState(loadPos)
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [input, setInput] = useState('')
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState(false)
  const [cites, setCites] = useState(0)
  const [pip, setPip] = useState<PipHandle | null>(null)
  const dragging = useRef(false)
  const abort = useRef<AbortController | null>(null)

  const { data: nudge, refetch } = useQuery({
    queryKey: ['pet-nudge'],
    queryFn: () => api.get<Nudge>('/pet/nudge'),
    // 常驻组件，别把它做成一个每秒打服务器的东西。
    // 五分钟够了 —— 它提起的事都不是秒级变化的
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  })

  useEffect(() => () => abort.current?.abort(), [])

  /* ── 拖动。位置存 localStorage，换页面不会跳回去 ── */
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    const el = e.currentTarget as HTMLElement
    const rect = el.getBoundingClientRect()
    const offX = e.clientX - rect.left
    const offY = e.clientY - rect.top
    let moved = false
    dragging.current = false

    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - e.clientX) + Math.abs(ev.clientY - e.clientY) > 4) {
        moved = true
        dragging.current = true
      }
      if (!moved) return
      const x = Math.min(Math.max(ev.clientX - offX, EDGE), window.innerWidth - rect.width - EDGE)
      const y = Math.min(Math.max(ev.clientY - offY, EDGE), window.innerHeight - rect.height - EDGE)
      setPos({ x, y })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (moved) {
        setPos((p) => {
          localStorage.setItem(POS_KEY, JSON.stringify(p))
          return p
        })
      }
      // 让 click 先跑完再清标记，否则拖完会误触发展开
      window.setTimeout(() => (dragging.current = false), 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const ask = async (q: string) => {
    const question = q.trim()
    if (!question || busy) return
    setBusy(true)
    setAnswer('')
    setCites(0)
    setInput('')
    const ctrl = new AbortController()
    abort.current = ctrl
    let text = ''
    await sse('/brain/ask', {
      method: 'POST',
      body: { question },
      signal: ctrl.signal,
      onEvent: (ev, data) => {
        if (ev === 'citations') setCites((data?.citations ?? []).length)
        if (ev === 'empty') text = data?.message ?? ''
        if (ev === 'empty') setAnswer(text)
      },
      onDelta: (t) => {
        text += t
        setAnswer(text)
      },
      onError: (m) => setAnswer(`出错了：${m}`),
    }).catch(() => {})
    setBusy(false)
  }

  const popOut = async () => {
    const h = await openPip({ width: 320, height: 420 }, () => setPip(null)).catch(() => null)
    if (h) setPip(h)
  }

  const mood: PetMood = busy ? 'think' : answer ? 'talk' : nudge?.kind === 'idle' ? 'happy' : 'idle'
  const bubble = !dismissed && !open && !!nudge && nudge.kind !== 'idle'

  /* ── 内容本体。页面内浮窗与 PiP 小窗共用这一份 ── */
  const body = (inPip: boolean) => (
    <div
      className={cn(
        'flex flex-col',
        inPip ? 'h-screen w-screen bg-[var(--bg)] p-3' : 'items-end gap-2',
      )}
    >
      {/* 气泡 / 对话 */}
      {(bubble || open) && (
        <div
          data-no-drag
          className={cn(
            'rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-raised)]',
            'animate-fade-up',
            inPip ? 'grow overflow-y-auto p-3' : 'w-[268px] px-3.5 py-3 order-first',
          )}
          style={inPip ? undefined : { boxShadow: 'var(--shadow-float)' }}
        >
          {answer ? (
            <>
              <div className="text-[12.5px] leading-relaxed whitespace-pre-wrap">{answer}</div>
              {cites > 0 && (
                <button
                  onClick={() => nav('/brain')}
                  className="mt-2 text-[11px] text-[var(--accent)] hover:underline"
                >
                  引了你 {cites} 条记录 · 去第二大脑看出处
                </button>
              )}
            </>
          ) : busy ? (
            <div className="flex items-center gap-2 text-[12.5px] text-[var(--text-muted)]">
              <Spinner className="size-3 text-[var(--accent)]" />
              正在翻你的学习记录…
            </div>
          ) : (
            <>
              <div className="text-[12.5px] leading-relaxed">{nudge?.text}</div>
              <div className="flex items-center gap-2 mt-2">
                {!!nudge?.cta && !!nudge?.route && (
                  <button
                    onClick={() => {
                      nav(nudge.route)
                      setDismissed(true)
                      setOpen(false)
                    }}
                    className="text-[11.5px] font-medium text-[var(--accent)] hover:underline"
                  >
                    {nudge.cta} →
                  </button>
                )}
                {/* 它自己写过的困惑，可以一键丢给第二大脑 */}
                {!!nudge?.ask && (
                  <button
                    onClick={() => {
                      setOpen(true)
                      void ask(nudge.ask!)
                    }}
                    className="text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text)]"
                  >
                    问问它
                  </button>
                )}
                <div className="grow" />
                <button
                  onClick={() => setDismissed(true)}
                  className="text-[11px] text-[var(--text-subtle)] hover:text-[var(--text)]"
                >
                  知道了
                </button>
              </div>
            </>
          )}

          {open && (
            <div className="mt-2.5 flex gap-1.5">
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void ask(input)
                }}
                placeholder="问问我学过什么…"
                autoFocus
                className={cn(
                  'grow h-7 px-2 rounded-[var(--radius-sm)] text-[12px]',
                  'bg-[var(--bg)] border border-[var(--border)]',
                  'focus:outline-none focus:border-[var(--border-strong)]',
                )}
              />
              <button
                onClick={() => void ask(input)}
                disabled={!input.trim() || busy}
                className="shrink-0 h-7 px-2 rounded-[var(--radius-sm)] text-[11.5px] bg-[var(--accent)] text-white disabled:opacity-40"
              >
                问
              </button>
            </div>
          )}
        </div>
      )}

      {/* 宠物本体 + 一行小控件 */}
      <div className={cn('flex items-end gap-1', inPip && 'justify-center pt-1')}>
        <button
          onClick={() => {
            if (dragging.current) return
            setDismissed(false)
            setOpen((o) => !o)
            if (!open) void refetch()
          }}
          title="点一下问我；拖动可以换位置"
          className="cursor-grab active:cursor-grabbing"
        >
          <Pet mood={mood} size={inPip ? 76 : 58} alert={bubble} />
        </button>

        {!inPip && (
          <div
            data-no-drag
            className="flex flex-col gap-1 opacity-0 hover:opacity-100 focus-within:opacity-100 transition-opacity"
          >
            {pipSupported() && !pip && (
              <button
                onClick={popOut}
                title="弹成置顶小窗 —— 切到别的软件它还在"
                className="size-5 flex items-center justify-center rounded-[5px] text-[var(--text-subtle)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]"
              >
                <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                  <path d="M14 4h6v6M20 4l-8 8M10 6H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5" />
                </svg>
              </button>
            )}
            <button
              onClick={() => {
                setHidden(true)
                localStorage.setItem(HIDE_KEY, '1')
                pip?.close()
              }}
              title="今天不想看见它"
              className="size-5 flex items-center justify-center rounded-[5px] text-[var(--text-subtle)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]"
            >
              <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {inPip && (
        <button
          onClick={() => pip?.close()}
          className="mt-1 text-[11px] text-[var(--text-subtle)] hover:text-[var(--text)]"
        >
          收回页面
        </button>
      )}
    </div>
  )

  if (hidden) {
    // 藏起来之后留一个极小的回归入口 —— 否则用户点了叉就再也找不回来
    return (
      <button
        onClick={() => {
          setHidden(false)
          localStorage.removeItem(HIDE_KEY)
        }}
        title="叫回桌宠"
        className="fixed bottom-3 right-3 z-40 size-6 rounded-full border border-[var(--border)] bg-[var(--bg-raised)] text-[10px] text-[var(--text-subtle)] hover:text-[var(--text)]"
      >
        ᴖ
      </button>
    )
  }

  // 弹出去之后，页面里就不再画它 —— 两个地方同时有一只会很怪
  if (pip) return createPortal(body(true), pip.win.document.body)

  const style =
    pos.x < 0
      ? { right: EDGE, bottom: EDGE }
      : { left: pos.x, top: pos.y }

  return (
    <div
      onPointerDown={onPointerDown}
      className="fixed z-40 flex flex-col items-end gap-2 select-none touch-none"
      style={style}
    >
      {body(false)}
    </div>
  )
}
