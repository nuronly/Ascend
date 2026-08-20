import { describe, expect, it } from 'vitest'
import type { ChapterBrief, SectionBrief } from '@/lib/types'
import { NODE_H, NODE_W, computeTreeLayout } from './treeLayout'

/**
 * 分层布局的语义正确性。
 *
 * 断言的不是像素，而是「层级有没有把学习顺序讲反」——
 * 把第 5 章的小节和第 1 章并排，用户就会以为它们能同时开始学；
 * 把前置排在后置下面，整张图的方向就是错的。这两种错都是静默的，
 * 看起来只是"有点怪"，所以必须钉住。
 */

function sec(id: string, idx: number, prereq: string[] = [], done = false): SectionBrief {
  return {
    id,
    idx,
    title: `节 ${id}`,
    summary: '',
    content_status: done ? 'ready' : 'pending',
    key_concepts: [],
    prerequisite_ids: prereq,
    completed: done,
    card_count: 0,
  }
}

function chap(id: string, idx: number, sections: SectionBrief[]): ChapterBrief {
  return { id, idx, title: `章 ${idx + 1}`, summary: '', sections }
}

/**
 *   第1章: s1(无前置) → s2
 *   第2章: s3(前置 s1), s4(无前置)
 *   第3章: s5(前置 s2 与 s3 —— 两条线汇聚)
 */
const CH: ChapterBrief[] = [
  chap('c1', 0, [sec('s1', 0), sec('s2', 1, ['s1'])]),
  chap('c2', 1, [sec('s3', 0, ['s1']), sec('s4', 1)]),
  chap('c3', 2, [sec('s5', 0, ['s2', 's3'])]),
]

const layerOf = (l: ReturnType<typeof computeTreeLayout>) =>
  Object.fromEntries(l.nodes.map((n) => [n.id, n.layer]))

/** 跨章长边：a1 在第 0 层，c1 在第 2 层，中间隔着一层 */
const LONG: ChapterBrief[] = [
  chap('c1', 0, [sec('a1', 0)]),
  chap('c2', 1, [sec('b1', 0), sec('b2', 1)]),
  chap('c3', 2, [sec('c1s', 0, ['a1'])]),
]

describe('computeTreeLayout · 分层', () => {
  it('有前置的小节排在它所有前置的下一层', () => {
    const y = layerOf(computeTreeLayout(CH))
    expect(y.s2).toBeGreaterThan(y.s1)
    expect(y.s3).toBeGreaterThan(y.s1)
  })

  it('多个前置汇聚：层级取最深那个前置再加一', () => {
    const y = layerOf(computeTreeLayout(CH))
    // s5 依赖 s2(层1) 和 s3(层1) → 层 2
    expect(y.s5).toBe(Math.max(y.s2, y.s3) + 1)
  })

  it('★ 章序号是层级下界：没有前置的小节不会窜到前面的章里', () => {
    const y = layerOf(computeTreeLayout(CH))
    // s4 一条依赖都没有。只按依赖分层它会落到第 0 层，和第 1 章的 s1 并排 ——
    // 看起来像「第 2 章的内容可以马上开始学」，课程的推进感就没了
    expect(y.s4).toBeGreaterThanOrEqual(1)
    expect(y.s4).toBeGreaterThan(y.s1)
  })

  it('层数等于最大层级加一', () => {
    const l = computeTreeLayout(CH)
    expect(l.layers).toBe(Math.max(...l.nodes.map((n) => n.layer)) + 1)
  })

  it('依赖全为空时，层级完全由章序决定（一章一层）', () => {
    const flat: ChapterBrief[] = [
      chap('a', 0, [sec('a1', 0), sec('a2', 1)]),
      chap('b', 1, [sec('b1', 0)]),
    ]
    const y = layerOf(computeTreeLayout(flat))
    expect(y.a1).toBe(0)
    expect(y.a2).toBe(0) // 同章无依赖 → 并排，表达「谁先学都行」
    expect(y.b1).toBe(1)
  })
})

describe('computeTreeLayout · 坐标', () => {
  it('同层节点不重叠', () => {
    const l = computeTreeLayout(CH)
    for (let i = 0; i < l.layers; i++) {
      const row = l.nodes.filter((n) => n.layer === i).sort((a, b) => a.x - b.x)
      for (let k = 1; k < row.length; k++) {
        expect(row[k].x).toBeGreaterThanOrEqual(row[k - 1].x + NODE_W)
      }
    }
  })

  it('层与层之间在竖直方向拉开，且顺序与层级一致', () => {
    const l = computeTreeLayout(CH)
    const y = new Map(l.nodes.map((n) => [n.layer, n.y]))
    expect(y.get(1)!).toBeGreaterThanOrEqual(y.get(0)! + NODE_H)
    expect(y.get(2)!).toBeGreaterThan(y.get(1)!)
  })

  it('每层水平居中：节点少的那层不会全都挤在左边', () => {
    const l = computeTreeLayout(CH)
    const only = l.nodes.find((n) => n.id === 's5')!
    // s5 是它那层唯一的节点，应该居中而不是靠左
    expect(only.x).toBeCloseTo((l.width - NODE_W) / 2, 1)
  })

  it('画布尺寸能装下所有节点', () => {
    const l = computeTreeLayout(CH)
    for (const n of l.nodes) {
      expect(n.x + NODE_W).toBeLessThanOrEqual(l.width + 0.001)
      expect(n.y + NODE_H).toBeLessThanOrEqual(l.height + 0.001)
    }
  })
})

describe('computeTreeLayout · 连线', () => {
  it('每条有效依赖都画一条线', () => {
    const l = computeTreeLayout(CH)
    // s1→s2, s1→s3, s2→s5, s3→s5
    expect(l.edges.length).toBe(4)
  })

  it('两条线汇聚到同一个子节点', () => {
    const l = computeTreeLayout(CH)
    expect(l.edges.filter((e) => e.to === 's5')).toHaveLength(2)
  })

  it('一个节点分叉出两条线', () => {
    const l = computeTreeLayout(CH)
    expect(l.edges.filter((e) => e.from === 's1')).toHaveLength(2)
  })

  it('线从父节点底部出发、到子节点顶部结束', () => {
    const l = computeTreeLayout(CH)
    const e = l.edges.find((x) => x.from === 's1' && x.to === 's2')!
    const from = l.nodes.find((n) => n.id === 's1')!
    const to = l.nodes.find((n) => n.id === 's2')!
    expect(e.d.startsWith(`M${from.x + NODE_W / 2},${from.y + NODE_H}`)).toBe(true)
    expect(e.d.endsWith(`${to.x + NODE_W / 2},${to.y}`)).toBe(true)
  })

  it('★ 跨多层的长边被拆成逐层的段，不再一条曲线压过中间层', () => {
    const l = computeTreeLayout(LONG)
    const e = l.edges.find((x) => x.from === 'a1' && x.to === 'c1s')!
    // 跨 2 层 → 2 段。段数 = 跨层数，说明中间那层插了通道点
    expect(e.span).toBe(2)
    expect(e.d.match(/C/g)).toHaveLength(2)
  })

  it('相邻层的边只有一段', () => {
    const l = computeTreeLayout(CH)
    const e = l.edges.find((x) => x.from === 's1' && x.to === 's2')!
    expect(e.span).toBe(1)
    expect(e.d.match(/C/g)).toHaveLength(1)
  })

  it('长边的通道把中间层撑宽，从而给线让出位置', () => {
    // 同样两个小节的中间层，有长边穿过时必须更宽 —— 这就是「让路」的证据
    const withLong = computeTreeLayout(LONG)
    const noLong: ChapterBrief[] = [
      chap('c1', 0, [sec('a1', 0)]),
      chap('c2', 1, [sec('b1', 0), sec('b2', 1)]),
      chap('c3', 2, [sec('c1s', 0)]), // 去掉那条跨章依赖
    ]
    expect(withLong.width).toBeGreaterThan(computeTreeLayout(noLong).width)
  })

  it('虚拟通道点不会漏进 nodes（它不该被渲染成方块）', () => {
    const l = computeTreeLayout(LONG)
    expect(l.nodes).toHaveLength(4)
    expect(l.nodes.every((n) => !n.id.startsWith('~'))).toBe(true)
  })

  it('指向不存在的小节不画线（悬空依赖）', () => {
    const l = computeTreeLayout([chap('c', 0, [sec('x', 0, ['不存在'])])])
    expect(l.edges).toHaveLength(0)
    expect(l.nodes).toHaveLength(1)
  })

  it('自引用不画线', () => {
    const l = computeTreeLayout([chap('c', 0, [sec('x', 0, ['x'])])])
    expect(l.edges).toHaveLength(0)
  })
})

describe('computeTreeLayout · 退化输入', () => {
  it('没有章时返回空布局', () => {
    const l = computeTreeLayout([])
    expect(l.nodes).toHaveLength(0)
    expect(l.width).toBe(0)
  })

  it('章里没有小节时返回空布局', () => {
    const l = computeTreeLayout([chap('c', 0, [])])
    expect(l.nodes).toHaveLength(0)
  })
})
