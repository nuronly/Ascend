/**
 * 记忆网络的物理布局与渲染。
 *
 * 为什么手写 Canvas 而不是再引一个图库：
 *   · 项目里已经有 React Flow（卡片画布）和 Cytoscape（概念图）两个图库了，
 *     第三个说不过去
 *   · 要的效果是「发光节点 + 沿突触行进的信号粒子 + 拖尾」，
 *     这些在 SVG/DOM 渲染器上做起来别扭且慢，Canvas 2D 反而最直接
 *   · 力导向布局本身不到一百行，几百个节点 O(n²) 完全够用
 */

export interface Neuron {
  id: string
  label: string
  term: string
  depth: number
  rewritten: boolean
  touch: number
  degree: number
  /** 0~1，来自 FSRS stability —— 记得越牢越亮 */
  strength: number
  due: boolean
  isolated: boolean
  reps: number
  created_at: string
  course_id: string
  tags: string[]
}

export interface Synapse {
  a: string
  b: string
  kind: 'parent' | 'real'
  relation?: string
}

export interface NetworkData {
  neurons: Neuron[]
  synapses: Synapse[]
  stats: Record<string, number>
}

export interface Body extends Neuron {
  x: number
  y: number
  vx: number
  vy: number
  r: number
  /** 激活强度 0~1，检索命中时拉满，之后自然衰减 */
  act: number
  actKind: 'fulltext' | 'vector' | 'graph' | 'picked' | null
  /** 出场动画进度 */
  born: number
}

export interface Signal {
  ax: number
  ay: number
  bx: number
  by: number
  t: number
  speed: number
  kind: 'graph' | 'picked'
}

const REPULSION = 5200
const SPRING = 0.0085
const SPRING_LEN = 78
const CENTER_PULL = 0.0022
const DAMPING = 0.86
const MAX_V = 6

export class NeuralLayout {
  bodies: Body[] = []
  index = new Map<string, Body>()
  edges: { a: Body; b: Body; kind: Synapse['kind']; relation?: string }[] = []
  signals: Signal[] = []
  /** 模拟温度：随时间衰减，收敛后停止计算物理，只渲染 */
  alpha = 1

  constructor(data: NetworkData, width: number, height: number) {
    const cx = width / 2
    const cy = height / 2

    // 初始位置按创建时间排成螺旋 —— 时间上相邻的记忆天然靠近，
    // 比纯随机初始化收敛更快，视觉上也更有秩序
    const n = data.neurons.length
    data.neurons.forEach((neu, i) => {
      const angle = i * 2.39996 // 黄金角
      const radius = Math.sqrt(i / Math.max(n, 1)) * Math.min(width, height) * 0.38
      const body: Body = {
        ...neu,
        x: cx + Math.cos(angle) * radius + (Math.random() - 0.5) * 12,
        y: cy + Math.sin(angle) * radius + (Math.random() - 0.5) * 12,
        vx: 0,
        vy: 0,
        r: 3.2 + Math.min(neu.touch, 12) * 0.42 + Math.min(neu.degree, 8) * 0.34,
        act: 0,
        actKind: null,
        born: 0,
      }
      this.bodies.push(body)
      this.index.set(neu.id, body)
    })

    for (const s of data.synapses) {
      const a = this.index.get(s.a)
      const b = this.index.get(s.b)
      if (a && b && a !== b) this.edges.push({ a, b, kind: s.kind, relation: s.relation })
    }
  }

  /** 物理步进。alpha 衰减到很小后自动停止，避免持续空转烧 CPU。 */
  step(width: number, height: number) {
    if (this.alpha < 0.004) return
    const bodies = this.bodies
    const n = bodies.length
    const cx = width / 2
    const cy = height / 2

    // 斥力：所有节点互相推开
    for (let i = 0; i < n; i++) {
      const a = bodies[i]
      for (let j = i + 1; j < n; j++) {
        const b = bodies[j]
        let dx = b.x - a.x
        let dy = b.y - a.y
        let d2 = dx * dx + dy * dy
        if (d2 < 0.01) {
          dx = Math.random() - 0.5
          dy = Math.random() - 0.5
          d2 = 0.01
        }
        if (d2 > 90000) continue // 太远的互不影响，省一半计算
        const d = Math.sqrt(d2)
        const f = (REPULSION * this.alpha) / d2
        const fx = (dx / d) * f
        const fy = (dy / d) * f
        a.vx -= fx
        a.vy -= fy
        b.vx += fx
        b.vy += fy
      }
    }

    // 引力：有突触的节点互相拉近
    for (const e of this.edges) {
      const dx = e.b.x - e.a.x
      const dy = e.b.y - e.a.y
      const d = Math.hypot(dx, dy) || 1
      // 父子链拉得更紧：它表达的是确定的思维序列
      const stiff = e.kind === 'parent' ? SPRING * 1.7 : e.kind === 'real' ? SPRING : SPRING * 0.4
      const f = (d - SPRING_LEN) * stiff * this.alpha
      const fx = (dx / d) * f
      const fy = (dy / d) * f
      e.a.vx += fx
      e.a.vy += fy
      e.b.vx -= fx
      e.b.vy -= fy
    }

    // 向心力 + 积分
    for (const b of bodies) {
      b.vx += (cx - b.x) * CENTER_PULL * this.alpha
      b.vy += (cy - b.y) * CENTER_PULL * this.alpha
      b.vx *= DAMPING
      b.vy *= DAMPING
      const v = Math.hypot(b.vx, b.vy)
      if (v > MAX_V) {
        b.vx = (b.vx / v) * MAX_V
        b.vy = (b.vy / v) * MAX_V
      }
      b.x += b.vx
      b.y += b.vy
    }

    this.alpha *= 0.988
  }

  /** 激活衰减 + 出场动画推进 */
  decay(dt: number) {
    for (const b of this.bodies) {
      if (b.act > 0) {
        b.act = Math.max(0, b.act - dt * 0.28)
        if (b.act === 0) b.actKind = null
      }
      if (b.born < 1) b.born = Math.min(1, b.born + dt * 1.6)
    }
    this.signals = this.signals.filter((s) => {
      s.t += dt * s.speed
      return s.t < 1
    })
  }

  activate(ids: string[], kind: Body['actKind'], strength = 1) {
    for (const id of ids) {
      const b = this.index.get(id)
      if (b) {
        b.act = Math.max(b.act, strength)
        b.actKind = kind
      }
    }
  }

  /** 从种子节点沿突触发射信号 —— 图扩散的可视化 */
  emitFrom(seedIds: string[], kind: Signal['kind'] = 'graph') {
    const seeds = new Set(seedIds)
    for (const e of this.edges) {
      const fromA = seeds.has(e.a.id)
      const fromB = seeds.has(e.b.id)
      if (!fromA && !fromB) continue
      const src = fromA ? e.a : e.b
      const dst = fromA ? e.b : e.a
      this.signals.push({
        ax: src.x,
        ay: src.y,
        bx: dst.x,
        by: dst.y,
        t: 0,
        speed: 0.9 + Math.random() * 0.5,
        kind,
      })
    }
    // 信号太多会糊成一片，限制数量
    if (this.signals.length > 90) this.signals = this.signals.slice(-90)
  }

  /** 让布局重新活跃起来（新增节点、切换筛选时调用） */
  reheat(v = 0.55) {
    this.alpha = Math.max(this.alpha, v)
  }

  hitTest(x: number, y: number, tolerance = 8): Body | null {
    let best: Body | null = null
    let bestD = Infinity
    for (const b of this.bodies) {
      const d = Math.hypot(b.x - x, b.y - y)
      if (d < b.r + tolerance && d < bestD) {
        best = b
        bestD = d
      }
    }
    return best
  }

  bounds() {
    if (!this.bodies.length) return { x0: 0, y0: 0, x1: 1, y1: 1 }
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const b of this.bodies) {
      x0 = Math.min(x0, b.x)
      y0 = Math.min(y0, b.y)
      x1 = Math.max(x1, b.x)
      y1 = Math.max(y1, b.y)
    }
    return { x0, y0, x1, y1 }
  }
}

/* ── 配色 ────────────────────────────────────────────────────
 * 记忆网络原本恒定深底（PLAN §4.3.5 的"另一个空间"），后来改为跟随主题。
 *
 * ⚠️ 两套配色不是简单地把颜色取反 —— 深浅底的视觉语言根本不同：
 *      深底：靠「发光」表达记忆强度，弱记忆自己暗下去
 *      浅底：不能发光，改靠「饱和度」，弱记忆淡到接近背景
 *    所以激活色在深底是提亮（近白），在浅底必须是压深（深蓝紫），
 *    否则激活的瞬间节点会直接消失在白底里。
 */
export interface Palette {
  bg: string
  /** 拖尾用的半透明背景色，让信号有余晖 */
  trail: string
  edge: string
  edgeParent: string
  edgeReal: string
  node: string
  nodeRewritten: string
  nodeDue: string
  nodeIsolated: string
  actFulltext: string
  actVector: string
  actGraph: string
  actPicked: string
  /** 光晕强度系数：白底上柔和扩散，深底上可以更张扬 */
  haloScale: number
  /** 行进信号的 shadowBlur。白底上发光只会糊成一团灰，必须关掉 */
  glow: number
}

export const LIGHT_PALETTE: Palette = {
  bg: '#f7f9fc',
  trail: 'rgba(247, 249, 252, 0.32)',
  edge: 'rgba(100, 116, 139, 0.12)',
  edgeParent: 'rgba(100, 116, 139, 0.30)',
  edgeReal: 'rgba(217, 119, 6, 0.55)',
  node: '#7ba3d8',
  nodeRewritten: '#2fa37a',
  nodeDue: '#e0883a',
  // 孤岛卡在白底上"淡到几乎看不见"，与深底上"几乎熄灭"是同一个意思
  nodeIsolated: '#d3d9e2',
  actFulltext: '#1e3a8a',
  actVector: '#2563eb',
  actGraph: '#7c3aed',
  actPicked: '#c2410c',
  haloScale: 0.55,
  glow: 0,
}

export const DARK_PALETTE: Palette = {
  bg: '#0b0e14',
  trail: 'rgba(11, 14, 20, 0.32)',
  edge: 'rgba(148, 163, 200, 0.10)',
  edgeParent: 'rgba(148, 163, 200, 0.20)',
  edgeReal: 'rgba(214, 154, 74, 0.55)',
  node: '#4a5875',
  nodeRewritten: '#3f8f70',
  nodeDue: '#c8813c',
  nodeIsolated: '#242a36',
  actFulltext: '#e8eefc',
  actVector: '#6fa8ff',
  actGraph: '#a78bfa',
  actPicked: '#ffd28a',
  haloScale: 1,
  glow: 10,
}

export function neuronColor(b: Body, p: Palette): string {
  if (b.isolated) return p.nodeIsolated
  if (b.due) return p.nodeDue
  if (b.rewritten) return p.nodeRewritten
  return p.node
}

export function activationColor(kind: Body['actKind'], p: Palette): string {
  switch (kind) {
    case 'fulltext':
      return p.actFulltext
    case 'vector':
      return p.actVector
    case 'graph':
      return p.actGraph
    case 'picked':
      return p.actPicked
    default:
      return p.actFulltext
  }
}
