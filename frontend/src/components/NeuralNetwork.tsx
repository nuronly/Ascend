import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import {
  DARK_PALETTE,
  LIGHT_PALETTE,
  NeuralLayout,
  activationColor,
  neuronColor,
  strengthLabel,
  synapseColor,
  type Body,
  type NetworkData,
  type Palette,
} from '@/lib/neural'
import { useIsDark } from '@/lib/useTheme'
import { cn } from '@/lib/utils'

/**
 * ★ 记忆网络可视化。
 *
 * 这不是装饰。它把三件抽象的事变成可见的：
 *
 *   1. **你的知识长什么样** —— 骨架是课程结构本身：一门课是一串珠子，
 *      每章炸开一团小节与卡片。一眼能看出「Transformer 上堆了一大团，
 *      CRISPR 只有孤零零三张」
 *   2. **你走到哪、还有多少没走** —— 亮度是牢固度（卡片来自 FSRS
 *      stability，小节来自读过/学完/收成笔记），还没走到的地方淡着，
 *      那是待点亮而不是濒临遗忘
 *   3. **AI 是怎么找到答案的** —— 提问时四路召回依次点亮，
 *      信号沿突触扩散，最后被引用的节点持续脉冲。
 *      这一条让 GraphRAG 的「可解释性」从口号变成看得见的东西。
 *
 * ★ 为什么结构也是神经元，而不是脚手架
 *   学完一节课就是获得了一块知识 —— 正文是主干，卡片只是旁支。
 *   原来这张网只画卡片，于是认真读完十二节但不划词的人，网络几乎是空的。
 *
 * ★ 视觉词汇刻意压到最少（这一版的主要改动）
 *   上一版有 7 种节点色 · 5 种连线色 · 3 档线宽 · 5 档大小 · 每点一圈光晕 ·
 *   38 个常驻标题 —— 每一条单独看都有理由，叠起来就没人能读了。
 *   现在只剩两条规则：**辖下知识越多的点越大**、**点和线全都一个样**；
 *   颜色只留给三件要行动的事（待复习 / 己见 / 还没走到），
 *   名字只在点够大时出现（于是缩放成了详略旋钮），
 *   光晕只在检索命中的那一刻出现。
 *   信息没有丢，是从"同时全画"改成了"按需浮现"。
 */

export interface NeuralHandle {
  activate: (ids: string[], kind: Body['actKind'], strength?: number) => void
  emitFrom: (ids: string[]) => void
  reset: () => void
  focus: (id: string) => void
  fit: () => void
}

/**
 * 标签的出现门槛：屏幕上的半径（世界半径 × 缩放）小于它就不画名字。
 *
 * 这个值调大调小的体感差别很大 —— 它实际上决定了「全览时看见几个字」。
 * 5.5 大致对应：全览只剩课程名，放大一档浮出章名，再放大才到小节和卡片。
 */
const LABEL_MIN_R = 5.5

/** 节点类型的人话名字，hover 卡上标出来 —— 不然分不清点到的是节还是卡 */
const KIND_LABEL: Record<Body['kind'], string> = {
  course: '课程',
  chapter: '章',
  section: '小节',
  note: '笔记',
  card: '疑问卡',
}

interface Props {
  data: NetworkData | null
  className?: string
  /** 点中一个节点。卡片走 Modal，结构节点走路由 —— 由调用方按 kind 分派 */
  onSelect?: (node: Body) => void
  /** 时间轴：只显示这个时刻之前创建的节点，0~1 */
  timeline?: number
  loading?: boolean
}

export const NeuralNetwork = forwardRef<NeuralHandle, Props>(function NeuralNetwork(
  { data, className, onSelect, timeline = 1, loading },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const layoutRef = useRef<NeuralLayout | null>(null)
  const rafRef = useRef(0)
  const lastRef = useRef(performance.now())

  // 视口变换（平移 + 缩放），用 ref 避免每帧 setState
  const viewRef = useRef({ x: 0, y: 0, k: 1 })
  const hoverRef = useRef<Body | null>(null)
  const timelineRef = useRef(timeline)
  // 悬停卡跟随鼠标。曾经固定在左下角，结果和「网络才 N 个神经元」那条提示
  // 叠在同一个位置，两张卡片直接糊在一起
  const [hovered, setHovered] = useState<{ body: Body; x: number; y: number } | null>(null)

  // draw 是每帧跑的 useCallback([])，配色只能through ref 递进去
  const dark = useIsDark()
  const pal = dark ? DARK_PALETTE : LIGHT_PALETTE
  const palRef = useRef<Palette>(pal)
  useEffect(() => {
    palRef.current = pal
  }, [pal])

  useEffect(() => {
    timelineRef.current = timeline
  }, [timeline])

  /** 把整张网不多不少地塞进视口。 */
  const fitView = useCallback(() => {
    const l = layoutRef.current
    const wrap = wrapRef.current
    if (!l || !wrap || !l.bodies.length) return
    const { x0, y0, x1, y1 } = l.bounds()
    const pad = 60
    const k = Math.min(
      (wrap.clientWidth - pad * 2) / Math.max(x1 - x0, 1),
      (wrap.clientHeight - pad * 2) / Math.max(y1 - y0, 1),
      1.6,
    )
    viewRef.current = {
      k,
      x: wrap.clientWidth / 2 - ((x0 + x1) / 2) * k,
      y: wrap.clientHeight / 2 - ((y0 + y1) / 2) * k,
    }
  }, [])

  /* ── 构建布局 ── */
  useEffect(() => {
    const wrap = wrapRef.current
    if (!data || !wrap) return
    const { clientWidth: w, clientHeight: h } = wrap
    layoutRef.current = new NeuralLayout(data, w || 800, h || 600)
    // 先跑几十步让布局大致成型，避免开场一团乱麻
    for (let i = 0; i < 60; i++) layoutRef.current.step(w || 800, h || 600)
    // ★ 开场就自动全览。以前固定 k=1，而节点数量是会变的（收起「还没走到」
    //   之后只剩几十个点），固定缩放的结果是网缩在正中央一小团 ——
    //   而标签的出现门槛看的正是 r × k，缩放不对连名字都不显示
    fitView()
  }, [data, fitView])

  useImperativeHandle(
    ref,
    () => ({
      activate: (ids, kind, strength) => {
        layoutRef.current?.activate(ids, kind, strength)
      },
      emitFrom: (ids) => layoutRef.current?.emitFrom(ids),
      reset: () => {
        const l = layoutRef.current
        if (!l) return
        for (const b of l.bodies) {
          b.act = 0
          b.actKind = null
        }
        l.signals = []
      },
      focus: (id) => {
        const l = layoutRef.current
        const wrap = wrapRef.current
        const b = l?.index.get(id)
        if (!b || !wrap) return
        const v = viewRef.current
        v.k = 1.7
        v.x = wrap.clientWidth / 2 - b.x * v.k
        v.y = wrap.clientHeight / 2 - b.y * v.k
      },
      fit: fitView,
    }),
    [fitView],
  )

  /* ── 渲染循环 ── */
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const wrap = wrapRef.current
    const layout = layoutRef.current
    if (!canvas || !wrap || !layout) return

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const w = wrap.clientWidth
    const h = wrap.clientHeight
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr
      canvas.height = h * dpr
      canvas.style.width = `${w}px`
      canvas.style.height = `${h}px`
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const P = palRef.current
    const now = performance.now()
    const dt = Math.min((now - lastRef.current) / 1000, 0.05)
    lastRef.current = now

    layout.step(w, h)
    layout.decay(dt)

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

    // ★ 拖尾只在真的有信号在跑的时候才铺
    //   原来是每帧无条件盖一层半透明背景色 —— 于是**静止的画面也在不停叠残影**，
    //   点和线周围永远糊着一圈上一帧的影子。这是"看起来乱"最隐蔽的一个来源：
    //   它不增加任何元素，只是让每个元素的边缘都不干净。
    if (layout.signals.length) {
      ctx.fillStyle = P.trail
      ctx.fillRect(0, 0, w, h)
    } else {
      ctx.clearRect(0, 0, w, h) // 容器自带 bg，清空即是干净底
    }

    const v = viewRef.current
    ctx.save()
    ctx.translate(v.x, v.y)
    ctx.scale(v.k, v.k)

    const tl = timelineRef.current
    const cutoff =
      tl >= 1
        ? Infinity
        : (() => {
            const times = layout.bodies.map((b) => new Date(b.created_at).getTime())
            const lo = Math.min(...times)
            const hi = Math.max(...times)
            return lo + (hi - lo) * tl
          })()
    const visible = (b: Body) =>
      cutoff === Infinity || new Date(b.created_at).getTime() <= cutoff

    /* ── 突触 ──
       所有系统自动连的线：同一个颜色、同一个宽度。
       曾经按 kind 分成五色三档宽（主干粗、骨架中、追问细），
       想法是"让人看出这条线是什么关系"，实际效果是一张图里五种线互相抢眼。
       关系已经由**形状**说清楚了：章是它那团的中心，卡片挂在小节外围。 */
    ctx.lineCap = 'round'
    for (const e of layout.edges) {
      if (!visible(e.a) || !visible(e.b)) continue
      const lit = Math.max(e.a.act, e.b.act)
      ctx.beginPath()
      ctx.moveTo(e.a.x, e.a.y)
      ctx.lineTo(e.b.x, e.b.y)
      if (lit > 0.05) {
        // 两端有激活时，连线跟着亮起来 —— 表现"信号通路"
        ctx.strokeStyle = activationColor(e.a.act > e.b.act ? e.a.actKind : e.b.actKind, P)
        ctx.globalAlpha = lit * 0.5
        ctx.lineWidth = 0.8 + lit * 1.4
      } else {
        ctx.strokeStyle = synapseColor(e.kind, P)
        // 两端都还没点亮的线一起淡下去，否则未走的那片会是
        // 「灰点 + 清晰的线」，看着像坏了
        ctx.globalAlpha = !e.a.learned && !e.b.learned ? 0.45 : 1
        ctx.lineWidth = 1
      }
      ctx.stroke()
    }
    ctx.globalAlpha = 1

    /* ── 行进中的信号 ── */
    for (const s of layout.signals) {
      const t = s.t
      const x = s.ax + (s.bx - s.ax) * t
      const y = s.ay + (s.by - s.ay) * t
      const fade = Math.sin(t * Math.PI)
      const color = s.kind === 'picked' ? P.actPicked : P.actGraph
      ctx.beginPath()
      ctx.arc(x, y, P.glow ? 1.8 : 2.2, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.globalAlpha = fade
      ctx.shadowBlur = P.glow
      ctx.shadowColor = color
      ctx.fill()
      ctx.shadowBlur = 0
    }
    ctx.globalAlpha = 1

    /* ── 神经元 ──
       ★ 常态光晕已经撤掉。原来只要 strength > 0.12 就画一层径向渐变，
         于是三百个点各自带一圈光斑，互相重叠 —— 画面糊成一片发亮的雾，
         这是"乱"的第二大来源（第一是常驻标签）。
         光晕现在只属于**检索命中的那一刻**：稀少，所以有意义。
         记忆强度改由不透明度独家表达，一个量一条通道。 */
    for (const b of layout.bodies) {
      if (!visible(b)) continue
      const base = neuronColor(b, P)
      // 不透明度 = 牢固度。还没走到的地方压到极淡 —— 看得见的「待点亮」。
      // 深底上表现为"还没亮起来"，浅底上表现为"淡进背景"，是同一件事。
      // ⚠️ 下限比原来高（0.45 / 0.55）：撤掉光晕之后，可见度全靠这条通道，
      //    再按原来的 0.3 起步，刚学的东西会直接看不见
      const lum = !b.learned
        ? 0.34
        : b.kind === 'card' || b.kind === 'note'
          ? 0.45 + b.strength * 0.55
          : 0.55 + b.strength * 0.45
      const r = b.r * b.born

      // 到期待复习的节点在呼吸。幅度从 0.14 压到 0.08 —— 它是提醒，不是警报
      const breathe = b.due ? 1 + Math.sin(now / 520 + b.x) * 0.08 : 1

      if (b.act > 0.02) {
        const ac = activationColor(b.actKind, P)
        const halo = r * (3.4 + b.act * 3.6)
        const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, halo)
        g.addColorStop(0, ac)
        g.addColorStop(0.28, ac)
        g.addColorStop(1, 'transparent')
        ctx.globalAlpha = b.act * 0.42 * P.haloScale
        ctx.beginPath()
        ctx.arc(b.x, b.y, halo, 0, Math.PI * 2)
        ctx.fillStyle = g
        ctx.fill()
        ctx.globalAlpha = 1
      }

      ctx.beginPath()
      ctx.arc(b.x, b.y, r * breathe, 0, Math.PI * 2)
      ctx.fillStyle = b.act > 0.02 ? activationColor(b.actKind, P) : base
      ctx.globalAlpha = b.act > 0.02 ? 1 : lum
      ctx.fill()
      ctx.globalAlpha = 1
      // 己见的那一圈描边也撤了：填充已经是己见色，描边是同一件事说两遍
    }

    /* ── 标签 ──
       ★ 一条规则取代原来的三条特例（课程常驻 / 章常驻 / 小节等 k>1.35）。
         常驻是上一版最大的问题：8 门课 + 30 章 = 38 个标题永远画着，
         在全览尺度下必然互相压字，图变成一团文字。
         现在只问一件事：**这个点在屏幕上够不够大**（r × k）。
         于是缩放变成了「详略调节旋钮」—— 缩小只剩几个课名，
         放大才逐层浮出章、节、卡片。Obsidian 就是这么做的。 */
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const b of layout.bodies) {
      if (!visible(b)) continue
      const rk = b.r * v.k // 屏幕上的实际半径
      if (rk < LABEL_MIN_R) continue
      // 阈值附近渐入，否则缩放时一排标签会同时闪现
      const fade = Math.min(1, (rk - LABEL_MIN_R) / 2)
      // 字号除以缩放：放大画布时文字不跟着变成巨物
      const size = 11.5 / Math.max(v.k, 0.5)
      ctx.font = `500 ${size}px system-ui, -apple-system, sans-serif`
      ctx.fillStyle = P.labelText
      ctx.globalAlpha = fade * (b.learned ? 0.95 : 0.5)
      const raw = b.term || b.label
      ctx.fillText(raw.length > 18 ? `${raw.slice(0, 17)}…` : raw, b.x, b.y + b.r + size * 0.85)
      ctx.globalAlpha = 1
    }

    /* ── hover 标签 ── */
    const hv = hoverRef.current
    if (hv && visible(hv)) {
      ctx.beginPath()
      ctx.arc(hv.x, hv.y, hv.r + 5, 0, Math.PI * 2)
      ctx.strokeStyle = P.actVector
      ctx.lineWidth = 1.2
      ctx.globalAlpha = 0.8
      ctx.stroke()
      ctx.globalAlpha = 1
      // 高亮它的邻域，一眼看出这条记忆连着什么
      for (const e of layout.edges) {
        if (e.a !== hv && e.b !== hv) continue
        ctx.beginPath()
        ctx.moveTo(e.a.x, e.a.y)
        ctx.lineTo(e.b.x, e.b.y)
        ctx.strokeStyle = P.actVector
        ctx.globalAlpha = 0.34
        ctx.lineWidth = 1.1
        ctx.stroke()
        ctx.globalAlpha = 1
      }
    }

    ctx.restore()
    rafRef.current = requestAnimationFrame(draw)
  }, [])

  useEffect(() => {
    lastRef.current = performance.now()
    rafRef.current = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(rafRef.current)
  }, [draw, data])

  /* ── 交互：平移 / 缩放 / 选中 ── */
  useEffect(() => {
    const wrap = wrapRef.current
    if (!wrap) return

    let panning = false
    let moved = false
    let lastX = 0
    let lastY = 0

    const toWorld = (e: MouseEvent) => {
      const rect = wrap.getBoundingClientRect()
      const v = viewRef.current
      return {
        x: (e.clientX - rect.left - v.x) / v.k,
        y: (e.clientY - rect.top - v.y) / v.k,
      }
    }

    const onDown = (e: MouseEvent) => {
      panning = true
      moved = false
      lastX = e.clientX
      lastY = e.clientY
    }
    const onMove = (e: MouseEvent) => {
      if (panning) {
        const dx = e.clientX - lastX
        const dy = e.clientY - lastY
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true
        viewRef.current.x += dx
        viewRef.current.y += dy
        lastX = e.clientX
        lastY = e.clientY
        return
      }
      const p = toWorld(e)
      const hit = layoutRef.current?.hitTest(p.x, p.y, 6 / viewRef.current.k) ?? null
      if (hit !== hoverRef.current) {
        hoverRef.current = hit
        wrap.style.cursor = hit ? 'pointer' : 'grab'
      }
      if (hit) {
        const rect = wrap.getBoundingClientRect()
        setHovered({ body: hit, x: e.clientX - rect.left, y: e.clientY - rect.top })
      } else if (hoverRef.current === null) {
        setHovered(null)
      }
    }
    const onUp = (e: MouseEvent) => {
      if (panning && !moved) {
        const p = toWorld(e)
        const hit = layoutRef.current?.hitTest(p.x, p.y, 6 / viewRef.current.k)
        // 整个 Body 传出去：调用方要靠 kind / route 决定是开 Modal 还是跳页
        if (hit) onSelect?.(hit)
      }
      panning = false
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = wrap.getBoundingClientRect()
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const v = viewRef.current
      const k2 = Math.max(0.25, Math.min(4, v.k * (e.deltaY < 0 ? 1.12 : 0.89)))
      // 以鼠标为锚点缩放
      v.x = mx - ((mx - v.x) / v.k) * k2
      v.y = my - ((my - v.y) / v.k) * k2
      v.k = k2
    }

    wrap.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    wrap.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      wrap.removeEventListener('mousedown', onDown)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      wrap.removeEventListener('wheel', onWheel)
    }
  }, [onSelect])

  return (
    <div
      ref={wrapRef}
      className={cn('relative overflow-hidden select-none', className)}
      style={{ background: pal.bg, cursor: 'grab' }}
    >
      <canvas ref={canvasRef} className="block" />

      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-[13px] text-[var(--text-muted)]">
          正在读取记忆网络…
        </div>
      )}

      {!loading && data && !data.neurons.length && (
        <div className="absolute inset-0 flex items-center justify-center px-8">
          <div className="text-center max-w-sm">
            <div className="text-[14px] font-medium text-[var(--text)]">网络还是空的</div>
            <div className="text-[12.5px] text-[var(--text-muted)] mt-2 leading-relaxed">
              开一门课，它的章节就会立刻在这里成形 —— 淡的是还没走到的地方。
              往后每读完一节、每收一张卡，对应的节点就亮起来。
            </div>
          </div>
        </div>
      )}

      {/* 悬停卡：跟着鼠标走，且贴近边缘时自动翻边，免得被容器裁掉 */}
      {hovered && (
        <div
          className="absolute z-20 w-[260px] px-3 py-2 rounded-[var(--radius)] bg-[var(--bg-raised)] border border-[var(--border)] pointer-events-none"
          style={{
            left: Math.min(Math.max(hovered.x, 8), (wrapRef.current?.clientWidth ?? 0) - 268),
            top: hovered.y > 150 ? hovered.y - 12 : hovered.y + 18,
            transform: hovered.y > 150 ? 'translateY(-100%)' : undefined,
            boxShadow: 'var(--shadow-float)',
          }}
        >
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] shrink-0 px-1 py-[1px] rounded-[3px] bg-[var(--bg-sunken)] text-[var(--text-subtle)]">
              {KIND_LABEL[hovered.body.kind]}
            </span>
            <span className="text-[12px] font-medium text-[var(--text)] truncate">
              {hovered.body.term || hovered.body.label}
            </span>
          </div>
          {hovered.body.label && hovered.body.label !== hovered.body.term && (
            <div className="text-[11.5px] text-[var(--text-muted)] mt-1 leading-relaxed line-clamp-2">
              {hovered.body.label}
            </div>
          )}
          <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-1.5 text-[10px] text-[var(--text-subtle)]">
            {hovered.body.learned ? (
              // ★ 小节没有复习记录，管它叫「记忆强度」是撒谎
              <span>
                {strengthLabel(hovered.body.kind)} {Math.round(hovered.body.strength * 100)}%
              </span>
            ) : (
              <span className="opacity-80">还没走到这里</span>
            )}
            {/* 一门整个灰着的课在这里显示 0/24 ——「开了课没走」该被看见 */}
            {hovered.body.total !== undefined && hovered.body.total > 0 && (
              <span>
                已学 {hovered.body.lit ?? 0}/{hovered.body.total} 节
              </span>
            )}
            <span>连接 {hovered.body.degree}</span>
            {(hovered.body.kind === 'card' || hovered.body.kind === 'note') && (
              <span>回想 {hovered.body.touch} 次</span>
            )}
            {hovered.body.rewritten && <span className="text-[var(--sem-rewritten)]">己见</span>}
            {hovered.body.due && <span className="text-[var(--sem-due)]">待复习</span>}
          </div>
        </div>
      )}
    </div>
  )
})
