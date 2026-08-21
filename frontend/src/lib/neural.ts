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

/**
 * ★ 神经元的五种类型 —— 结构本身就是知识单元
 *
 *   学完一节课就是获得了一块知识，这跟划词提问获得一块知识是同一件事，
 *   而且正文是主干、卡片只是旁支。原来这张网只画卡片，于是一个认真读完
 *   十二节但不怎么划词的人，网络里几乎是空的 —— 他明明学了很多。
 */
export type NeuronKind = 'course' | 'chapter' | 'section' | 'card' | 'note'

export interface Neuron {
  id: string
  kind: NeuronKind
  label: string
  term: string
  depth: number
  rewritten: boolean
  touch: number
  degree: number
  /**
   * 0~1 的牢固度。⚠️ 两种不同的量共用这一条通道：
   *   卡片 / 笔记 → FSRS stability（真实复习记录）
   *   小节 / 章 / 课 → 学习进度的粗略代理（读过 / 学完 / 收成笔记）
   * 视觉上共用是刻意的（都在回答「这块知识有多牢」），
   * 但 hover 文案必须分开说 —— 管小节叫「记忆强度」是撒谎。
   */
  strength: number
  due: boolean
  /** 已点亮 = 真的学过。未点亮的小节淡着，本身就是行动指引 */
  learned: boolean
  reps: number
  created_at: string
  course_id: string
  tags: string[]
  /** 点它去哪。卡片为空串 —— 卡片走 Modal，不跳页 */
  route: string
}

export interface Synapse {
  a: string
  b: string
  /**
   * structure 课程/章→节的骨架 · spine 章与章的递进 ·
   * origin 小节→挂在它上面的卡 · parent 追问的父子链 · real 用户手建
   */
  kind: 'structure' | 'spine' | 'origin' | 'parent' | 'real'
  relation?: string
}

export interface NetworkData {
  neurons: Neuron[]
  synapses: Synapse[]
  stats: Record<string, number | Record<string, number>>
}

/** 节点半径。层级越高越大 —— 课程是恒星，卡片是尘埃 */
const BASE_RADIUS: Record<NeuronKind, number> = {
  course: 9,
  chapter: 6.4,
  section: 4.4,
  // 笔记比碎卡大一档：它是人工改写过、有完整语境的阅读单元
  note: 5.2,
  card: 3.2,
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
        // 结构节点的大小由层级决定；卡片的大小由「被回想过多少次、连了多少东西」决定
        r:
          BASE_RADIUS[neu.kind] +
          (neu.kind === 'card' || neu.kind === 'note'
            ? Math.min(neu.touch, 12) * 0.42 + Math.min(neu.degree, 8) * 0.34
            : Math.min(neu.degree, 10) * 0.18),
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
      // ★ 刚度决定了「一堆连在一起」这件事成不成立：
      //   骨架（章→节）拉最紧，让一章的东西团成一颗恒星；
      //   spine（章与章）松一点，让珠子串开而不是挤成一坨；
      //   origin（节→卡）中等，卡片围着小节转；父子链紧，那是确定的思维序列
      const stiff =
        e.kind === 'structure'
          ? SPRING * 2.2
          : e.kind === 'spine'
            ? SPRING * 0.5
            : e.kind === 'parent'
              ? SPRING * 1.7
              : e.kind === 'origin'
                ? SPRING * 1.2
                : SPRING
      const len = e.kind === 'spine' ? SPRING_LEN * 2.4 : SPRING_LEN
      const f = (d - len) * stiff * this.alpha
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
  /** 课程/章→节的骨架线 */
  edgeStructure: string
  /** 章与章的递进（主干），比骨架显眼一档 —— 它就是学习路径 */
  edgeSpine: string
  node: string
  nodeRewritten: string
  nodeDue: string
  nodeCourse: string
  nodeChapter: string
  nodeSection: string
  nodeNote: string
  /** 还没走到的小节：淡到接近背景，是「待点亮」而不是「濒临遗忘」 */
  nodeUnlit: string
  /** 结构节点的标签文字 */
  labelText: string
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
  edgeStructure: 'rgba(100, 116, 139, 0.22)',
  edgeSpine: 'rgba(71, 85, 105, 0.42)',
  node: '#7ba3d8',
  nodeRewritten: '#2fa37a',
  nodeDue: '#e0883a',
  nodeCourse: '#5b6b8c',
  nodeChapter: '#7a86a8',
  nodeSection: '#93a7c6',
  nodeNote: '#2fa37a',
  // 未点亮在白底上"淡到几乎看不见"，与深底上"还没亮起来"是同一个意思
  nodeUnlit: '#dde2ea',
  labelText: 'rgba(51, 65, 85, 0.82)',
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
  edgeStructure: 'rgba(148, 163, 200, 0.16)',
  edgeSpine: 'rgba(180, 195, 230, 0.34)',
  node: '#4a5875',
  nodeRewritten: '#3f8f70',
  nodeDue: '#c8813c',
  nodeCourse: '#8fa4d4',
  nodeChapter: '#6b7ba0',
  nodeSection: '#55637f',
  nodeNote: '#3f8f70',
  nodeUnlit: '#1c2230',
  labelText: 'rgba(200, 212, 236, 0.78)',
  actFulltext: '#e8eefc',
  actVector: '#6fa8ff',
  actGraph: '#a78bfa',
  actPicked: '#ffd28a',
  haloScale: 1,
  glow: 10,
}

/**
 * 节点颜色。
 *
 * ★ 优先级的教训：原来 isolated 排在最前面，压过 due 和 rewritten ——
 *   于是唯一那张永久笔记（degree 恒为 0，因为没人给笔记连线）被画成
 *   「濒临遗忘」的最暗一档，明明它是 due=True 且是系统里最有价值的单元。
 *   现在 isolated 这个概念整个撤掉了（骨架化之后不存在孤岛），
 *   顶替它的 unlit 只对**还没走到的小节**成立 —— 那是「待点亮」，不是「快忘了」。
 */
export function neuronColor(b: Body, p: Palette): string {
  if (!b.learned) return p.nodeUnlit
  switch (b.kind) {
    case 'course':
      return p.nodeCourse
    case 'chapter':
      return p.nodeChapter
    case 'section':
      // 收成过笔记的那一节，用己见色标出来 —— 亲手写过的地方最值得回访
      return b.rewritten ? p.nodeRewritten : p.nodeSection
    case 'note':
      return p.nodeNote
    default:
      if (b.due) return p.nodeDue
      if (b.rewritten) return p.nodeRewritten
      return p.node
  }
}

/** 突触颜色。 */
export function synapseColor(kind: Synapse['kind'], p: Palette): string {
  switch (kind) {
    case 'spine':
      return p.edgeSpine
    case 'structure':
      return p.edgeStructure
    case 'real':
      return p.edgeReal
    case 'parent':
      return p.edgeParent
    default:
      return p.edge
  }
}

/** hover 卡上「牢固度」该叫什么 —— 小节没有复习记录，不能管它叫记忆强度。 */
export function strengthLabel(kind: NeuronKind): string {
  return kind === 'card' || kind === 'note' ? '记忆强度' : '掌握程度'
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
