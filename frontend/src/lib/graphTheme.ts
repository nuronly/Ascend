import type cytoscape from 'cytoscape'

/**
 * 图谱配色。
 *
 * ⚠️ 这里所有颜色都必须是字面量，不能写 var(--xxx)。
 *    cytoscape 走 Canvas 渲染而不是 DOM，CSS 变量在 Canvas 上下文里
 *    根本解析不出来 —— 曾经 node 的 background-color 写成 var(--graph-node)，
 *    结果节点被画成了默认色，在深底上几乎隐形，排查了很久。
 *
 * 视觉基调：浅底 + 彩色球 + 悬停卡片。
 *    颜色只用来编码语义（学没学过 / 关系是哪一类），不做装饰。
 */

export interface GraphPalette {
  bg: string
  text: string
  textSoft: string
  /** 学习路径图三档：还没开始 → 读过 → 学完（见 components/SectionTree） */
  blank: Fill
  covered: Fill
  owned: Fill
  /** 问题图 */
  card: Fill
  rewritten: Fill
  rootRing: string
  /** 边 */
  prerequisite: string
  partOf: string
  related: string
  contrast: string
  parent: string
  real: string
  selected: string
  hoverRing: string
}

interface Fill {
  fill: string
  stroke: string
  text?: string
}

export const LIGHT: GraphPalette = {
  bg: '#f7f9fc',
  text: '#334155',
  textSoft: '#94a3b8',
  // 空白 = 空心。用描边而不是填充来表达"还没碰过"，
  // 否则一门新课满屏都是同一个色块，看着像加载失败。
  // 描边一度用 #cbd5e1，实测对比度只有 1.41 —— 这就是"整张图看不见"的量化证据
  blank: { fill: '#ffffff', stroke: '#aab8c8', text: '#64748b' },
  covered: { fill: '#bfdbfe', stroke: '#60a5fa' },
  // 有己见才算真啃下来 —— 背过 ≠ 想过
  owned: { fill: '#a7f3d0', stroke: '#10b981' },
  card: { fill: '#dbeafe', stroke: '#93c5fd' },
  rewritten: { fill: '#a7f3d0', stroke: '#10b981' },
  rootRing: '#64748b',
  prerequisite: '#7dabf8',
  partOf: '#c3cbd6',
  related: '#cbd5e1',
  contrast: '#d8b4fe',
  parent: '#c3cbd6',
  real: '#f59e0b',
  selected: '#2563eb',
  hoverRing: '#3b82f6',
}

export const DARK: GraphPalette = {
  bg: '#12141a',
  text: '#e2e8f0',
  textSoft: '#8b94a5',
  blank: { fill: 'rgba(255,255,255,0.04)', stroke: 'rgba(255,255,255,0.34)', text: '#9aa3b2' },
  covered: { fill: '#3f5677', stroke: '#7ba3e0' },
  owned: { fill: '#2f6551', stroke: '#5ecfa0' },
  card: { fill: '#3f4c63', stroke: '#8595ad' },
  rewritten: { fill: '#2f6551', stroke: '#5ecfa0' },
  rootRing: '#b6c0d0',
  prerequisite: '#6f97d8',
  partOf: '#5b6577',
  related: '#59616f',
  contrast: '#a874c9',
  parent: '#5b6577',
  real: '#d69a4a',
  selected: '#7fa8ff',
  hoverRing: '#8ab4ff',
}

/** 悬停/选中时的描边宽度，抽出来是为了让各处保持一致 */
const RING = 3

/**
 * 问题图（卡片图）的样式表。
 *
 * 学习路径图不走这里 —— 它的节点是方块、语义是三档学习状态，
 * 自己在 components/SectionTree 里定义，只共用这份调色板。
 */
export function makeStylesheet(p: GraphPalette): cytoscape.StylesheetJson {
  const node = (f: Fill, extra: Record<string, unknown> = {}) => ({
    'background-color': f.fill,
    'border-color': f.stroke,
    'border-width': 1.5,
    color: f.text ?? p.text,
    ...extra,
  })

  return [
    {
      selector: 'node',
      style: {
        shape: 'ellipse',
        label: 'data(label)',
        width: 'data(size)',
        height: 'data(size)',
        'background-color': p.card.fill,
        'border-color': p.card.stroke,
        'border-width': 1.5,
        color: p.text,
        'font-size': 10.5,
        'font-family': 'Inter, PingFang SC, sans-serif',
        'text-valign': 'bottom',
        'text-margin-y': 4,
        'text-max-width': '96px',
        'text-wrap': 'ellipsis',
        'transition-property': 'background-color, border-color, border-width, opacity',
        'transition-duration': 140,
      } as never,
    },

    { selector: 'node.card', style: node(p.card, { 'font-size': 9.5 }) as never },
    { selector: 'node.rewritten', style: node(p.rewritten, { 'border-width': 2 }) as never },
    // 根卡 = 最初那个疑问，一条追问链的源头，值得被看见
    {
      selector: 'node.root',
      style: { 'border-color': p.rootRing, 'border-width': 2, 'font-size': 10.5 } as never,
    },

    {
      selector: 'node.hovered',
      style: { 'border-color': p.hoverRing, 'border-width': RING } as never,
    },
    {
      selector: 'node:selected',
      style: { 'border-color': p.selected, 'border-width': RING } as never,
    },

    {
      selector: 'edge',
      style: {
        width: 1.2,
        'line-color': p.related,
        'curve-style': 'bezier',
        'target-arrow-shape': 'none',
        opacity: 0.9,
      } as never,
    },

    // ── 有向的骨架边：撑起层级，画成带箭头的实线 ────────────────
    {
      selector: 'edge.parent',
      style: {
        'line-color': p.parent,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': p.parent,
        'arrow-scale': 0.7,
      } as never,
    },

    // 可能关联：AI 猜的，还没被用户确认，用虚线退到背景
    {
      selector: 'edge.potential',
      style: {
        'line-color': p.related,
        'line-style': 'dashed',
        'curve-style': 'unbundled-bezier',
        'control-point-distance': 32,
        'control-point-weight': 0.5,
      } as never,
    },
    // ★ real link：跨追问树的意外关联，第二大脑里最值钱的东西。
    //   琥珀 + 大弧线，让它明显"飞越"树结构而不是混进主干
    {
      selector: 'edge.real',
      style: {
        'line-color': p.real,
        width: 2,
        'curve-style': 'unbundled-bezier',
        'control-point-distance': 68,
        'control-point-weight': 0.5,
      } as never,
    },

    { selector: '.dimmed', style: { opacity: 0.14 } as never },
  ]
}
