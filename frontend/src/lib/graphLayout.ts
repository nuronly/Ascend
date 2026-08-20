import cytoscape, { type Core, type EdgeSingular } from 'cytoscape'
import dagre from 'cytoscape-dagre'

cytoscape.use(dagre)

/**
 * 图谱分层布局。
 *
 * ── 为什么不用力导向（cose）────────────────────────────────
 * 力导向的本质是弹簧平衡，它不表达任何语义顺序，再干净的数据出来也是一团。
 * 但这两张图恰恰都有内在方向：
 *   学习路径图 —— prerequisite 定义了「先学什么」，是一条学习路径
 *   问题图     —— 追问链定义了「钻研的深度」
 * 所以统一用 dagre 分层，让方向显形。
 *
 * ── 数据本身不是树，也不该被砍成树 ─────────────────────────
 * 一个小节可以有多个前置（链式法则 + 梯度下降 → 反向传播），
 * 问题图的跨树 real link 更是整个第二大脑最值钱的东西。
 * 我们要的是「树的秩序感」，不是「树的数据结构」。
 */

/** 问题图：只有父子链定义「谁在前」；real link 是跨树的意外关联，一旦参与
 *  布局就会把本来独立的几棵树互相拽偏，毁掉森林的清爽结构，所以排除在外。 */
const CARD_SKELETON = 'node, edge.parent'

export function runCardLayout(cy: Core) {
  const skeleton = cy.elements(CARD_SKELETON)
  // 兜底：骨架为空（全是孤立节点）时 dagre 会退化成一条线，改用网格更好看
  const hasSkeleton = skeleton.edges().length > 0
  const target = hasSkeleton ? skeleton : cy.elements()

  target
    .layout({
      name: hasSkeleton ? 'dagre' : 'grid',
      // 问题图横着长：层间距拉大，让「追问的深度」在视觉上有距离感
      rankDir: 'LR',
      rankSep: 96,
      nodeSep: 22,
      edgeSep: 12,
      ranker: 'network-simplex',
      animate: false,
      fit: false,
      padding: 40,
      spacingFactor: 1,
    } as never)
    .run()
}

/**
 * 学习路径图（课程页左栏）。
 *
 * 骨架里有两种边，权重刻意拉开：
 *   dep   —— 真实的前置依赖。它决定谁必须排在谁上面，是这张图的信息本体。
 *   spine —— 章与章之间的推进（上一章末节 → 本章首节）。
 *
 * 为什么需要 spine：模型给的依赖是稀疏的（prompt 里明确要求「宁缺毋滥」），
 * 只靠 dep 的话，没有依赖的小节会散成一片孤岛，dagre 把它们全顶到第一层，
 * 看起来就像所有内容都能同时开始学 —— 完全丢掉了课程的推进感。
 * 加上 spine 之后，章的先后顺序始终成立，而同一章里互不依赖的小节
 * 自然并排在同一层，正好表达「这几节可以按任意顺序学」。
 */
export function runSectionTreeLayout(cy: Core) {
  cy.layout({
    name: 'dagre',
    rankDir: 'TB',
    rankSep: 46,
    nodeSep: 16,
    edgeSep: 8,
    ranker: 'network-simplex',
    // 真实依赖优先排近；脊线只负责保证章的顺序，别让它拽歪主干
    edgeWeight: (e: EdgeSingular) => (e.hasClass('dep') ? 4 : 1),
    animate: false,
    fit: false,
    padding: 20,
  } as never).run()
}
