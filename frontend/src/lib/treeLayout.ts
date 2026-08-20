import type { ChapterBrief, SectionBrief } from '@/lib/types'

/**
 * 学习路径树的分层布局。
 *
 * 纯计算，不碰 DOM —— 渲染交给 HTML 节点 + SVG 连线（见 components/SectionTree）。
 * 之所以自己算而不用 dagre：需要的只是「分层 + 同层排序」这两步，
 * 而我们对分层有一条 dagre 表达不了的额外约束（见下面的 layer 公式）。
 *
 * ── 层级怎么定 ─────────────────────────────────────────────
 *   layer(s) = max( 章序号, 1 + max(layer(前置)) )
 *
 * 后半截是标准的最长路径分层：有前置就必须排在所有前置的下一层，
 * 于是「多个前置汇聚到一个小节」会自然画成一个收口。
 *
 * 前半截 `章序号` 是关键的一条额外约束。模型给的依赖是稀疏的
 * （prompt 里明确要求「宁缺毋滥」），所以**多数**小节没有前置；
 * 只按依赖分层的话，第 5 章那些没有前置的小节会全部落到第 0 层，
 * 和第 1 章的内容并排 —— 看起来像「这些都能马上开始学」，
 * 课程的推进感彻底消失。把章序号作为层级下界，阶段的先后就永远成立。
 *
 * 依赖只会指向更早的小节（后端 _persist_outline 已经保证并剪过边），
 * 所以按 (章, 节) 顺序遍历一次就能把层级算完，不需要迭代到收敛。
 */

export const NODE_W = 132
export const NODE_H = 34
const GAP_X = 14
const GAP_Y = 38

export interface TreeNode {
  id: string
  section: SectionBrief
  chapter: ChapterBrief
  layer: number
  /** 左上角坐标 */
  x: number
  y: number
}

export interface TreeEdge {
  id: string
  from: string
  to: string
  /** SVG path，父节点底部中心 → 子节点顶部中心 */
  d: string
}

export interface TreeLayout {
  nodes: TreeNode[]
  edges: TreeEdge[]
  width: number
  height: number
  layers: number
}

export function computeTreeLayout(chapters: ChapterBrief[]): TreeLayout {
  const flat: { s: SectionBrief; ch: ChapterBrief }[] = []
  for (const ch of chapters) for (const s of ch.sections) flat.push({ s, ch })

  if (!flat.length) return { nodes: [], edges: [], width: 0, height: 0, layers: 0 }

  const byId = new Map(flat.map((f) => [f.s.id, f]))
  const depsOf = (s: SectionBrief) =>
    (s.prerequisite_ids ?? []).filter((p) => byId.has(p) && p !== s.id)

  // ── 1. 分层 ──
  const layer = new Map<string, number>()
  for (const { s, ch } of flat) {
    const known = depsOf(s).filter((p) => layer.has(p))
    const byDep = known.length ? Math.max(...known.map((p) => layer.get(p)!)) + 1 : 0
    layer.set(s.id, Math.max(ch.idx, byDep))
  }

  // ── 2. 同层排序（重心法，减少连线交叉）──
  // 把每个节点挪到「它的前置们的平均位置」附近，交叉会显著变少。
  // 只跑一轮：层数不多，收益已经吃到，多跑几轮反而可能让无前置的节点乱窜。
  const layers: string[][] = []
  for (const { s } of flat) {
    const l = layer.get(s.id)!
    ;(layers[l] ??= []).push(s.id)
  }
  for (let l = 0; l < layers.length; l++) layers[l] ??= []

  const orderIn = new Map<string, number>()
  layers.forEach((ids) => ids.forEach((id, i) => orderIn.set(id, i)))

  for (let l = 1; l < layers.length; l++) {
    const row = layers[l]
    const bary = new Map<string, number>()
    row.forEach((id, i) => {
      const ds = depsOf(byId.get(id)!.s).filter((p) => orderIn.has(p))
      // 没有前置的节点没有重心可言，保持它原来的相对次序（+1000 让它们排在右侧，
      // 不去插队打断有依赖关系的那几条线）
      bary.set(id, ds.length ? ds.reduce((a, p) => a + orderIn.get(p)!, 0) / ds.length : 1000 + i)
    })
    row.sort((a, b) => bary.get(a)! - bary.get(b)!)
    row.forEach((id, i) => orderIn.set(id, i))
  }

  // ── 3. 坐标：每层水平居中 ──
  const maxInRow = Math.max(...layers.map((r) => r.length))
  const width = maxInRow * NODE_W + (maxInRow - 1) * GAP_X
  const rowStep = NODE_H + GAP_Y

  const nodes: TreeNode[] = []
  layers.forEach((row, l) => {
    const rowW = row.length * NODE_W + (row.length - 1) * GAP_X
    const offset = (width - rowW) / 2
    row.forEach((id, i) => {
      const f = byId.get(id)!
      nodes.push({
        id,
        section: f.s,
        chapter: f.ch,
        layer: l,
        x: offset + i * (NODE_W + GAP_X),
        y: l * rowStep,
      })
    })
  })

  // ── 4. 连线 ──
  const pos = new Map(nodes.map((n) => [n.id, n]))
  const edges: TreeEdge[] = []
  const seen = new Set<string>()
  for (const n of nodes) {
    for (const p of depsOf(n.section)) {
      const from = pos.get(p)
      if (!from || from.layer >= n.layer) continue // 同层或倒挂的边不画
      const id = `${p}->${n.id}`
      if (seen.has(id)) continue
      seen.add(id)

      const x1 = from.x + NODE_W / 2
      const y1 = from.y + NODE_H
      const x2 = n.x + NODE_W / 2
      const y2 = n.y
      // 三次贝塞尔，控制点在竖直方向 —— 出入口都是垂直的，
      // 汇聚到同一个子节点的几条线会在收口处并成一束，比直线整齐得多
      const dy = Math.max(18, (y2 - y1) / 2)
      edges.push({ id, from: p, to: n.id, d: `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}` })
    }
  }

  return {
    nodes,
    edges,
    width,
    height: layers.length * rowStep - GAP_Y,
    layers: layers.length,
  }
}
