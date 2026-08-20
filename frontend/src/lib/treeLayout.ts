import type { ChapterBrief, SectionBrief } from '@/lib/types'

/**
 * 学习路径树的分层布局。
 *
 * 纯计算，不碰 DOM —— 渲染交给 HTML 节点 + SVG 连线（见 components/SectionTree）。
 *
 * ── 层级怎么定 ─────────────────────────────────────────────
 *   layer(s) = max( 章序号, 1 + max(layer(前置)) )
 *
 * 后半截是标准的最长路径分层：有前置就必须排在所有前置的下一层，
 * 于是「多个前置汇聚到一个小节」自然画成一个收口。
 *
 * 前半截 `章序号` 是必须补的一条约束。模型给的依赖很稀疏
 * （prompt 明确要求「宁缺毋滥」），多数小节没有前置；只按依赖分层的话，
 * 第 5 章那些没有前置的小节会全部落到第 0 层、和第 1 章并排 ——
 * 看起来像「这些都能马上开始学」，课程的推进感彻底消失。
 *
 * 依赖只会指向更早的小节（后端 _persist_outline 已保证并剪过边），
 * 所以按 (章, 节) 顺序遍历一次就能算完层级，不需要迭代到收敛。
 *
 * ── ★ 长边为什么要插虚拟节点 ────────────────────────────────
 * 依赖天生是跨章的：prompt 刻意不让模型输出「1.1 → 1.2」这种相邻关系
 * （顺序本身已经表达了），要求它只标跨章的硬依赖。于是「1.1 → 3.2」这类
 * 跨好几层的边是常态，而不是意外。
 *
 * 一条贝塞尔直接从起点拉到终点的话，曲线会**压过中间层的节点** ——
 * 看起来就是「线穿在方块上」，这是整张图最主要的视觉噪音来源。
 *
 * 解法是 Sugiyama 算法里的 dummy node：给跨多层的边在每个中间层插一个
 * 不可见的占位点，让它和真实节点一起参与同层排序，从而**为长边挤出一条
 * 通道**；边沿着这些点走成平滑折线，绕开节点而不是压过去。
 * 代价是每条长边会让所经过的层各宽出 14px，很值。
 */

export const NODE_W = 132
export const NODE_H = 34
/** 长边通道宽度。够让线错开，又不至于把层撑太宽 */
const DUMMY_W = 14
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
  /** 跨了几层。1 = 相邻层直连 */
  span: number
  /** SVG path：父节点底部中心 → （沿通道）→ 子节点顶部中心 */
  d: string
}

export interface TreeLayout {
  nodes: TreeNode[]
  edges: TreeEdge[]
  width: number
  height: number
  layers: number
}

/** 层内的一个占位：真实小节，或者长边借道用的虚拟点 */
interface Slot {
  id: string
  w: number
  real?: { s: SectionBrief; ch: ChapterBrief }
}

function pathThrough(points: { x: number; y: number }[]): string {
  let d = `M${points[0].x},${points[0].y}`
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]
    const b = points[i]
    // 每段都垂直出入：汇聚到同一个子节点的几条线会在收口处并成一束
    const dy = Math.max(12, (b.y - a.y) / 2)
    d += ` C${a.x},${a.y + dy} ${b.x},${b.y - dy} ${b.x},${b.y}`
  }
  return d
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
  const layerCount = Math.max(...layer.values()) + 1

  // ── 2. 铺 slot：真实节点 + 长边的通道占位 ──
  const rows: Slot[][] = Array.from({ length: layerCount }, () => [])
  for (const { s, ch } of flat) rows[layer.get(s.id)!].push({ id: s.id, w: NODE_W, real: { s, ch } })

  /** edgeId → 依次经过的 slot id（含两端）*/
  const chains = new Map<string, string[]>()
  for (const { s } of flat) {
    const lv = layer.get(s.id)!
    for (const p of depsOf(s)) {
      const lu = layer.get(p)!
      if (lu >= lv) continue // 同层或倒挂：后端已剪过，这里再兜一层
      const edgeId = `${p}->${s.id}`
      const chain: string[] = [p]
      for (let l = lu + 1; l < lv; l++) {
        const did = `~${edgeId}@${l}`
        rows[l].push({ id: did, w: DUMMY_W })
        chain.push(did)
      }
      chain.push(s.id)
      chains.set(edgeId, chain)
    }
  }

  // ── 3. 同层排序（重心法，减少交叉）──
  // 虚拟点也参与：它就是长边的「代表」，把它排到合理位置，长边自然绕开节点。
  const prevOf = new Map<string, string[]>()
  for (const chain of chains.values()) {
    for (let i = 1; i < chain.length; i++) {
      const arr = prevOf.get(chain[i]) ?? []
      arr.push(chain[i - 1])
      prevOf.set(chain[i], arr)
    }
  }

  const orderIn = new Map<string, number>()
  rows.forEach((row) => row.forEach((sl, i) => orderIn.set(sl.id, i)))

  for (let l = 1; l < rows.length; l++) {
    const row = rows[l]
    const bary = new Map<string, number>()
    row.forEach((sl, i) => {
      const ps = (prevOf.get(sl.id) ?? []).filter((p) => orderIn.has(p))
      // 没有前驱的节点没有重心可言，保持原有相对次序并排到该层右侧，
      // 不去插队打断有依赖关系的那几条线
      bary.set(sl.id, ps.length ? ps.reduce((a, p) => a + orderIn.get(p)!, 0) / ps.length : 1000 + i)
    })
    row.sort((a, b) => bary.get(a.id)! - bary.get(b.id)!)
    row.forEach((sl, i) => orderIn.set(sl.id, i))
  }

  // ── 4. 坐标：每层按 slot 宽度铺开并水平居中 ──
  const rowW = rows.map((row) => row.reduce((a, s) => a + s.w, 0) + Math.max(0, row.length - 1) * GAP_X)
  const width = Math.max(...rowW)
  const rowStep = NODE_H + GAP_Y

  /** slot id → 中心 x */
  const cx = new Map<string, number>()
  const nodes: TreeNode[] = []
  rows.forEach((row, l) => {
    let x = (width - rowW[l]) / 2
    for (const sl of row) {
      cx.set(sl.id, x + sl.w / 2)
      if (sl.real) {
        nodes.push({
          id: sl.id,
          section: sl.real.s,
          chapter: sl.real.ch,
          layer: l,
          x,
          y: l * rowStep,
        })
      }
      x += sl.w + GAP_X
    }
  })

  // ── 5. 连线：沿 chain 串起各段 ──
  const layerOfSlot = new Map<string, number>()
  rows.forEach((row, l) => row.forEach((sl) => layerOfSlot.set(sl.id, l)))

  const edges: TreeEdge[] = []
  for (const [edgeId, chain] of chains) {
    const pts = chain.map((id, i) => {
      const l = layerOfSlot.get(id)!
      const x = cx.get(id)!
      if (i === 0) return { x, y: l * rowStep + NODE_H } // 起点：父节点底部
      if (i === chain.length - 1) return { x, y: l * rowStep } // 终点：子节点顶部
      return { x, y: l * rowStep + NODE_H / 2 } // 中间：通道中点
    })
    const [from, to] = edgeId.split('->')
    edges.push({ id: edgeId, from, to, span: chain.length - 1, d: pathThrough(pts) })
  }

  return {
    nodes,
    edges,
    width,
    height: rows.length * rowStep - GAP_Y,
    layers: rows.length,
  }
}
