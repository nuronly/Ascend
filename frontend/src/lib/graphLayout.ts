import cytoscape, { type Core } from 'cytoscape'
import dagre from 'cytoscape-dagre'

cytoscape.use(dagre)

/**
 * 问题图的分层布局。
 *
 * ── 为什么不用力导向（cose）────────────────────────────────
 * 力导向的本质是弹簧平衡，它不表达任何语义顺序，再干净的数据出来也是一团。
 * 但这张图有内在方向：追问链定义了「钻研的深度」。所以用 dagre 分层，
 * 让方向显形 —— 左→右 就是一个问题被挖了多深。
 *
 * ── 数据不是树，也不该被砍成树 ─────────────────────────────
 * 跨追问树的 real link 是整个第二大脑最值钱的东西，不能为了画成树而丢掉。
 * 我们要的是「树的秩序感」，不是「树的数据结构」。
 *
 * 注：学习路径图（课程页左栏）不在这里 —— 它用的是确定性网格坐标，
 * 一章一行，不跑任何自动布局。理由见 components/SectionTree 的注释：
 * 自动分层在窄容器里会把 20 多个带标题的方块挤成一团。
 */

/** 只有父子链定义「谁在前」；real link 是跨树的意外关联，一旦参与布局
 *  就会把本来独立的几棵树互相拽偏，毁掉森林的清爽结构，所以排除在外。 */
const CARD_SKELETON = 'node, edge.parent'

export function runCardLayout(cy: Core) {
  const skeleton = cy.elements(CARD_SKELETON)
  // 兜底：骨架为空（全是孤立节点）时 dagre 会退化成一条线，改用网格更好看
  const hasSkeleton = skeleton.edges().length > 0
  const target = hasSkeleton ? skeleton : cy.elements()

  target
    .layout({
      name: hasSkeleton ? 'dagre' : 'grid',
      // 横着长：层间距拉大，让「追问的深度」在视觉上有距离感
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
