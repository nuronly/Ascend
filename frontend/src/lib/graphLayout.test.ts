import { describe, expect, it } from 'vitest'
import cytoscape from 'cytoscape'
import { runLayout } from './graphLayout'

/**
 * 布局的语义正确性测试。
 *
 * 这里断言的不是"像素对不对"，而是"层级关系有没有把知识结构讲反"——
 * 把「牛顿法」排在「梯度下降」上面，用户就会当它是前置，那是实打实的误导。
 * dagre 升级、选项改名这类变动都会静默破坏这些性质，所以必须钉住。
 */

const layerOf = (cy: cytoscape.Core, axis: 'x' | 'y') => {
  const pos: Record<string, number> = {}
  cy.nodes().forEach((n) => {
    pos[n.id()] = Math.round(n.position(axis))
  })
  return pos
}

describe('概念图（TB：上→下 = 学习顺序）', () => {
  const build = () =>
    cytoscape({
      headless: true,
      elements: [
        ...['导数', '损失函数', '梯度下降', 'SGD', '过拟合', '正则化', '牛顿法'].map((id) => ({
          data: { id },
          classes: 'concept',
        })),
        // 多父：梯度下降同时需要导数和损失函数打底
        { data: { id: 'e1', source: '导数', target: '梯度下降' }, classes: 'prerequisite' },
        { data: { id: 'e2', source: '损失函数', target: '梯度下降' }, classes: 'prerequisite' },
        { data: { id: 'e3', source: '梯度下降', target: 'SGD' }, classes: 'part_of' },
        // 无向：不该产生上下关系
        { data: { id: 'e4', source: '过拟合', target: '正则化' }, classes: 'related' },
        { data: { id: 'e5', source: '梯度下降', target: '牛顿法' }, classes: 'contrast' },
      ],
    })

  it('多父节点的两个前置都排在它上方（图不被砍成树）', () => {
    const cy = build()
    runLayout(cy, 'concepts')
    const y = layerOf(cy, 'y')
    expect(y['导数']).toBeLessThan(y['梯度下降'])
    expect(y['损失函数']).toBeLessThan(y['梯度下降'])
  })

  it('part_of 的组成部分排在整体下方', () => {
    const cy = build()
    runLayout(cy, 'concepts')
    const y = layerOf(cy, 'y')
    expect(y['梯度下降']).toBeLessThan(y['SGD'])
  })

  it('只有 contrast 边的概念归位到对照对象同层，而不是被顶到顶层冒充前置', () => {
    const cy = build()
    runLayout(cy, 'concepts')
    const y = layerOf(cy, 'y')
    expect(y['牛顿法']).toBe(y['梯度下降'])
    expect(y['牛顿法']).not.toBe(y['导数'])
  })

  it('归位后不与同层节点重叠', () => {
    const cy = build()
    runLayout(cy, 'concepts')
    const p = cy.getElementById('梯度下降').position()
    const q = cy.getElementById('牛顿法').position()
    expect(Math.abs(p.x - q.x)).toBeGreaterThan(30)
  })

  it('互为 related 的孤立一对保持并排（无前置信息时不臆造层级）', () => {
    const cy = build()
    runLayout(cy, 'concepts')
    const y = layerOf(cy, 'y')
    expect(y['过拟合']).toBe(y['正则化'])
  })
})

describe('问题图（LR：左→右 = 追问深度）', () => {
  const build = () =>
    cytoscape({
      headless: true,
      elements: [
        ...['A根', 'A子', 'A孙', 'B根', 'B子'].map((id) => ({ data: { id }, classes: 'card' })),
        { data: { id: 'p1', source: 'A根', target: 'A子' }, classes: 'parent' },
        { data: { id: 'p2', source: 'A子', target: 'A孙' }, classes: 'parent' },
        { data: { id: 'p3', source: 'B根', target: 'B子' }, classes: 'parent' },
        // 跨树的意外关联：值钱，但不能让它决定布局
        { data: { id: 'r1', source: 'A孙', target: 'B子' }, classes: 'real' },
      ],
    })

  it('每棵追问树都向右生长', () => {
    const cy = build()
    runLayout(cy, 'cards')
    const x = layerOf(cy, 'x')
    expect(x['A根']).toBeLessThan(x['A子'])
    expect(x['A子']).toBeLessThan(x['A孙'])
    expect(x['B根']).toBeLessThan(x['B子'])
  })

  it('跨树 real link 不把另一棵树拽偏，两个根卡仍对齐在起跑线', () => {
    const cy = build()
    runLayout(cy, 'cards')
    const x = layerOf(cy, 'x')
    expect(x['B根']).toBe(x['A根'])
  })
})

describe('退化输入', () => {
  it('没有任何骨架边时退化为网格，不崩也不重叠成一点', () => {
    const cy = cytoscape({
      headless: true,
      elements: [1, 2, 3].map((i) => ({ data: { id: `n${i}` }, classes: 'concept' })),
    })
    expect(() => runLayout(cy, 'concepts')).not.toThrow()
    const xs = new Set(cy.nodes().map((n) => Math.round(n.position('x'))))
    expect(xs.size).toBeGreaterThan(1)
  })

  it('空图不崩', () => {
    const cy = cytoscape({ headless: true, elements: [] })
    expect(() => runLayout(cy, 'overlay')).not.toThrow()
  })
})
