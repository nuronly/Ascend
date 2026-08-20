import { describe, expect, it } from 'vitest'
import cytoscape from 'cytoscape'
import { runCardLayout, runSectionTreeLayout } from './graphLayout'

/**
 * 布局的语义正确性测试。
 *
 * 这里断言的不是"像素对不对"，而是"层级关系有没有把知识结构讲反"——
 * 把第 5 章的小节排在第 1 章旁边，用户就会以为它们可以同时开始学，
 * 那是实打实的误导。dagre 升级、选项改名这类变动都会静默破坏这些性质，
 * 所以必须钉住。
 */

const layerOf = (cy: cytoscape.Core, axis: 'x' | 'y') => {
  const pos: Record<string, number> = {}
  cy.nodes().forEach((n) => {
    pos[n.id()] = Math.round(n.position(axis))
  })
  return pos
}

describe('学习路径图（TB：上→下 = 学习顺序）', () => {
  /**
   * 两章五节的真实形状：
   *   第 1 章：1.1 → 1.2（依赖），1.3 无前置
   *   第 2 章：2.1 同时依赖 1.1 和 1.2（多前置），2.2 无前置
   * 2.2 没有任何依赖，只能靠脊线（1.3 → 2.2）把它压到第二章的位置。
   */
  const build = () =>
    cytoscape({
      headless: true,
      elements: [
        ...['1.1', '1.2', '1.3', '2.1', '2.2'].map((id) => ({ data: { id } })),
        { data: { id: 'd1', source: '1.1', target: '1.2' }, classes: 'dep' },
        { data: { id: 'd2', source: '1.1', target: '2.1' }, classes: 'dep' },
        { data: { id: 'd3', source: '1.2', target: '2.1' }, classes: 'dep' },
        // 脊线只连「没有前置」的小节：2.1 已被依赖定位，所以只给 2.2 连
        { data: { id: 's1', source: '1.3', target: '2.2' }, classes: 'spine' },
      ],
    })

  it('多前置的两个依赖都排在它上方（图没有被砍成树）', () => {
    const cy = build()
    runSectionTreeLayout(cy)
    const y = layerOf(cy, 'y')
    expect(y['1.1']).toBeLessThan(y['2.1'])
    expect(y['1.2']).toBeLessThan(y['2.1'])
  })

  it('依赖链严格向下', () => {
    const cy = build()
    runSectionTreeLayout(cy)
    const y = layerOf(cy, 'y')
    expect(y['1.1']).toBeLessThan(y['1.2'])
  })

  it('同章内互不依赖的小节并排在同一层（不臆造先后）', () => {
    const cy = build()
    runSectionTreeLayout(cy)
    const y = layerOf(cy, 'y')
    // 1.1 和 1.3 都没有前置，应该并排 —— 表达「这两节谁先学都行」
    expect(y['1.3']).toBe(y['1.1'])
  })

  it('★ 没有前置的小节靠脊线压在它所属的章里，不会被顶到第一层', () => {
    const cy = build()
    runSectionTreeLayout(cy)
    const y = layerOf(cy, 'y')
    // 这条是整张图可读性的命门：2.2 一条依赖都没有，
    // 若不靠脊线约束就会和第 1 章的小节并排，课程的推进感全丢
    expect(y['2.2']).toBeGreaterThan(y['1.3'])
    expect(y['2.2']).toBeGreaterThan(y['1.1'])
  })

  it('并排的同层节点不重叠', () => {
    const cy = build()
    runSectionTreeLayout(cy)
    const p = cy.getElementById('1.1').position()
    const q = cy.getElementById('1.3').position()
    expect(Math.abs(p.x - q.x)).toBeGreaterThan(20)
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
    runCardLayout(cy)
    const x = layerOf(cy, 'x')
    expect(x['A根']).toBeLessThan(x['A子'])
    expect(x['A子']).toBeLessThan(x['A孙'])
    expect(x['B根']).toBeLessThan(x['B子'])
  })

  it('跨树 real link 不把另一棵树拽偏，两个根卡仍对齐在起跑线', () => {
    const cy = build()
    runCardLayout(cy)
    const x = layerOf(cy, 'x')
    expect(x['B根']).toBe(x['A根'])
  })
})

describe('退化输入', () => {
  it('问题图没有任何骨架边时退化为网格，不崩也不重叠成一点', () => {
    const cy = cytoscape({
      headless: true,
      elements: [1, 2, 3].map((i) => ({ data: { id: `n${i}` }, classes: 'card' })),
    })
    expect(() => runCardLayout(cy)).not.toThrow()
    const xs = new Set(cy.nodes().map((n) => Math.round(n.position('x'))))
    expect(xs.size).toBeGreaterThan(1)
  })

  it('路径图只有孤立小节（模型一条依赖都没给）时不崩', () => {
    const cy = cytoscape({
      headless: true,
      elements: [1, 2, 3].map((i) => ({ data: { id: `s${i}` } })),
    })
    expect(() => runSectionTreeLayout(cy)).not.toThrow()
  })

  it('空图不崩', () => {
    const cy = cytoscape({ headless: true, elements: [] })
    expect(() => runCardLayout(cy)).not.toThrow()
    expect(() => runSectionTreeLayout(cy)).not.toThrow()
  })
})
