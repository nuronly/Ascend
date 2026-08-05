import { useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react'
import {
  DARK_PALETTE,
  LIGHT_PALETTE,
  NeuralLayout,
  activationColor,
  neuronColor,
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
 *   1. **你的知识长什么样** —— 神经元的疏密、聚类、孤岛
 *   2. **你正在遗忘什么** —— 亮度直接来自 FSRS 的 stability，
 *      快忘掉的节点会自己暗下去，孤岛卡几乎熄灭
 *   3. **AI 是怎么找到答案的** —— 提问时四路召回依次点亮，
 *      信号沿突触扩散，最后被引用的节点持续脉冲。
 *      这一条让 GraphRAG 的「可解释性」从口号变成看得见的东西。
 */

export interface NeuralHandle {
  activate: (ids: string[], kind: Body['actKind'], strength?: number) => void
  emitFrom: (ids: string[]) => void
  reset: () => void
  focus: (id: string) => void
  fit: () => void
}

interface Props {
  data: NetworkData | null
  className?: string
  onSelect?: (id: string) => void
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
  const [hovered, setHovered] = useState<Body | null>(null)

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

  /* ── 构建布局 ── */
  useEffect(() => {
    const wrap = wrapRef.current
    if (!data || !wrap) return
    const { clientWidth: w, clientHeight: h } = wrap
    layoutRef.current = new NeuralLayout(data, w || 800, h || 600)
    viewRef.current = { x: 0, y: 0, k: 1 }
    // 先跑几十步让布局大致成型，避免开场一团乱麻
    for (let i = 0; i < 60; i++) layoutRef.current.step(w || 800, h || 600)
  }, [data])

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
      fit: () => {
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
      },
    }),
    [],
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

    // 轻微拖尾：让信号有余晖，画面更"活"
    ctx.fillStyle = P.trail
    ctx.fillRect(0, 0, w, h)

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

    /* ── 突触 ── */
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
        ctx.strokeStyle =
          e.kind === 'real' ? P.edgeReal : e.kind === 'parent' ? P.edgeParent : P.edgePotential
        ctx.globalAlpha = 1
        ctx.lineWidth = e.kind === 'parent' ? 0.9 : e.kind === 'real' ? 1.1 : 0.7
        if (e.kind === 'potential') ctx.setLineDash([3, 4])
      }
      ctx.stroke()
      ctx.setLineDash([])
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

    /* ── 神经元 ── */
    for (const b of layout.bodies) {
      if (!visible(b)) continue
      const base = neuronColor(b, P)
      const grow = b.born
      // 不透明度 = 记忆强度。孤岛卡压到极淡 —— 看得见的遗忘。
      // 深底上表现为"暗下去"，浅底上表现为"淡进背景"，是同一件事
      const lum = b.isolated ? 0.22 : 0.3 + b.strength * 0.7
      const r = b.r * grow

      // 到期待复习的节点在呼吸
      const breathe = b.due ? 1 + Math.sin(now / 480 + b.x) * 0.14 : 1

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
      } else if (!b.isolated && b.strength > 0.12) {
        // 平时也有一层与记忆强度成正比的微光
        const halo = r * (1.8 + b.strength * 1.6)
        const g = ctx.createRadialGradient(b.x, b.y, 0, b.x, b.y, halo)
        g.addColorStop(0, base)
        g.addColorStop(1, 'transparent')
        ctx.globalAlpha = (0.09 + b.strength * 0.2) * P.haloScale
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

      // 己见卡加一圈描边：这是他真正内化过的
      if (b.rewritten && !b.isolated) {
        ctx.beginPath()
        ctx.arc(b.x, b.y, r * breathe + 1.6, 0, Math.PI * 2)
        ctx.strokeStyle = P.nodeRewritten
        ctx.globalAlpha = 0.5 + b.act * 0.5
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.globalAlpha = 1
      }
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
        setHovered(hit)
        wrap.style.cursor = hit ? 'pointer' : 'grab'
      }
    }
    const onUp = (e: MouseEvent) => {
      if (panning && !moved) {
        const p = toWorld(e)
        const hit = layoutRef.current?.hitTest(p.x, p.y, 6 / viewRef.current.k)
        if (hit) onSelect?.(hit.id)
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
              每收进仓库一张卡，这里就会多一个神经元。
              等你积累起几十张，它们之间的连接会自己显形。
            </div>
          </div>
        </div>
      )}

      {/* hover 卡片浮层 */}
      {hovered && (
        <div
          className="absolute left-3 bottom-3 max-w-[300px] px-3 py-2 rounded-[var(--radius)] bg-[var(--bg-raised)] border border-[var(--border)] pointer-events-none"
          style={{ boxShadow: 'var(--shadow-float)' }}
        >
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[9.5px] text-[var(--text-subtle)]">
              {hovered.luhmann_id}
            </span>
            <span className="text-[12px] font-medium text-[var(--text)] truncate">
              ⟨{hovered.term || hovered.label}⟩
            </span>
          </div>
          {hovered.label && hovered.label !== hovered.term && (
            <div className="text-[11.5px] text-[var(--text-muted)] mt-1 leading-relaxed line-clamp-2">
              {hovered.label}
            </div>
          )}
          <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 mt-1.5 text-[10px] text-[var(--text-subtle)]">
            <span>记忆强度 {Math.round(hovered.strength * 100)}%</span>
            <span>连接 {hovered.degree}</span>
            <span>回想 {hovered.touch} 次</span>
            {hovered.rewritten && <span className="text-[var(--sem-rewritten)]">己见</span>}
            {hovered.due && <span className="text-[var(--sem-due)]">待复习</span>}
            {hovered.isolated && <span className="opacity-70">孤岛</span>}
          </div>
        </div>
      )}
    </div>
  )
})
