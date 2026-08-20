import { describe, expect, it } from 'vitest'
import cytoscape from 'cytoscape'
import { runCardLayout } from './graphLayout'

/**
 * 布局的语义正确性测试。
 *
 * 这里断言的不是"像素对不对"，而是"方向有没有被讲反"——
 * 追问链要是排乱了，用户就看不出一个问题被挖了多深。dagre 升级、
 * 选项改名这类变动都会静默破坏这些性质，所以必须钉住。
 *
 * 学习路径图的坐标测试在 components/SectionTree.render.test.tsx ——
 * 它不跑自动布局，用的是确定性网格。
 */

const layerOf = (cy: cytoscape.Core, axis: 'x' | 'y') => {
  const pos: Record<string, number> = {}
  cy.nodes().forEach((n) => {
    pos[n.id()] = Math.round(n.position(axis))
  })
  return pos
}

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

  it('空图不崩', () => {
    const cy = cytoscape({ headless: true, elements: [] })
    expect(() => runCardLayout(cy)).not.toThrow()
  })
})
