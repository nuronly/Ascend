import cytoscape, { type Collection, type Core, type EdgeSingular, type NodeSingular } from 'cytoscape'
import dagre from 'cytoscape-dagre'

cytoscape.use(dagre)

export type GraphView = 'overlay' | 'concepts' | 'cards'

/**
 * 图谱分层布局。
 *
 * ── 为什么不用力导向（cose）────────────────────────────────
 * 力导向的本质是弹簧平衡，它不表达任何语义顺序，再干净的数据出来也是一团。
 * 但这几张图恰恰都有内在方向：
 *   概念图 —— prerequisite 定义了"先学什么"，是一条学习路径
 *   问题图 —— 追问链定义了"钻研的深度"
 * 所以统一改成 dagre 分层，让方向显形。
 *
 * ── 数据本身不是树，也不该被砍成树 ─────────────────────────
 * 概念图存在多前置节点（导数、损失函数 → 梯度下降），
 * 问题图的跨树 real link 更是整个第二大脑最值钱的东西。
 * 我们要的是「树的秩序感」，不是「树的数据结构」。
 */

/**
 * 参与分层计算的「骨架边」：只有带方向的关系能定义"谁在上、谁在前"。
 *
 * related / contrast 无向，不在此列；它们靠布局后的 alignFlatOnly() 归位。
 * 问题图则刻意排除 real link —— 它们是跨追问树的意外关联，
 * 一旦参与布局就会把本来独立的几棵树互相拽偏，毁掉森林的清爽结构。
 */
export const SKELETON: Record<GraphView, string> = {
  concepts: 'node, edge.prerequisite, edge.part_of',
  overlay: 'node, edge.prerequisite, edge.part_of',
  cards: 'node, edge.parent',
}

/** 无向关系：只表达"这俩有关系"，不表达先后 */
export const isFlat = (e: EdgeSingular) => e.hasClass('related') || e.hasClass('contrast')

export function runLayout(cy: Core, view: GraphView) {
  const horizontal = view === 'cards'
  const skeleton = cy.elements(SKELETON[view])
  // 兜底：骨架为空（全是孤立节点）时 dagre 会退化成一条线，改用网格更好看
  const hasSkeleton = skeleton.edges().length > 0
  const target = hasSkeleton ? skeleton : cy.elements()

  target
    .layout({
      name: hasSkeleton ? 'dagre' : 'grid',
      rankDir: horizontal ? 'LR' : 'TB',
      // 问题图横着长：层间距拉大，让"追问的深度"在视觉上有距离感
      rankSep: horizontal ? 96 : 62,
      nodeSep: horizontal ? 22 : 26,
      edgeSep: 12,
      ranker: 'network-simplex',
      // 强关系优先排近，弱关系让路
      edgeWeight: (e: EdgeSingular) => (e.hasClass('prerequisite') ? 3 : 2),
      animate: false,
      fit: false,
      padding: 40,
      spacingFactor: 1,
    } as any)
    .run()

  if (!horizontal) alignFlatOnly(cy, skeleton)
}

/**
 * 给「只有无向边」的概念归位。
 *
 * dagre 只认有向边，这类概念无处安放就会被一律顶到第一层 ——
 * 「牛顿法」和「梯度下降」明明是对照关系，却排在梯度下降上面，
 * 看起来就像它的前置，纯粹误导。
 *
 * 本来想让无向边以 minLen 0 参与布局（0 表示"允许同层"），实测 dagre 直接抛异常：
 * 它硬性要求 minlen >= 1，换任何 ranker 都一样。所以改为布局后手动归位：
 * 挪到 flat 邻居的同一层，并排放在该层右侧。
 */
export function alignFlatOnly(cy: Core, skeleton: Collection) {
  const anchored = new Set(skeleton.edges().connectedNodes().map((n) => n.id()))
  if (!anchored.size) return

  // 每层当前最右边缘，用于依次排开、避免重叠
  const rightEdge = new Map<number, number>()
  const w = (n: NodeSingular) => n.width() || 70

  cy.nodes().forEach((n) => {
    if (!anchored.has(n.id())) return
    const y = Math.round(n.position('y'))
    rightEdge.set(y, Math.max(rightEdge.get(y) ?? -Infinity, n.position('x') + w(n) / 2))
  })

  cy.nodes().forEach((n) => {
    if (anchored.has(n.id())) return
    const host = n
      .connectedEdges()
      .filter(isFlat)
      .connectedNodes()
      .filter((m) => m.id() !== n.id() && anchored.has(m.id()))
      .first() as NodeSingular
    // 完全孤立的概念没有参照，就留在 dagre 给的位置
    if (!host.length) return

    const y = Math.round(host.position('y'))
    const x = (rightEdge.get(y) ?? host.position('x')) + w(n) / 2 + 34
    n.position({ x, y })
    rightEdge.set(y, x + w(n) / 2)
  })
}
