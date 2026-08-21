import { describe, expect, it } from 'vitest'
import {
  DARK_PALETTE,
  LIGHT_PALETTE,
  NeuralLayout,
  neuronColor,
  nodeRadius,
  pruneUnlit,
  synapseColor,
  type Body,
  type NetworkData,
  type Neuron,
  type NeuronKind,
  type Synapse,
} from './neural'

/**
 * 记忆网络的数据整形与视觉规则。
 *
 * 为什么这一层值得测：它的三种坏法**都不报错**，只是画面变得没法读 ——
 *
 *   1. 摘掉未走到的节点却不重接骨架 → 链断开，剩下的章浮成孤岛。
 *      悬空的边在 NeuralLayout 构造时被静默丢弃（index.get 拿不到就跳过），
 *      表现成「连线时有时无」，查起来毫无头绪
 *   2. 半径规则一旦回退成"按 kind 查表"，240 节的课会和一张卡一样大
 *      （课程只连第一章，degree 恒为 1）
 *   3. 颜色优先级排错 → 系统里最有价值的单元被画成最暗的一点
 *      （这正是上一版的真实事故：唯一那张永久笔记被判成"孤岛，濒临遗忘"）
 */

const neuron = (id: string, kind: NeuronKind, learned: boolean, extra: Partial<Neuron> = {}) =>
  ({
    id,
    kind,
    label: id,
    term: id,
    depth: 0,
    rewritten: false,
    touch: 0,
    degree: 0,
    strength: 0,
    due: false,
    learned,
    reps: 0,
    created_at: '2026-01-01T00:00:00Z',
    course_id: 'c1',
    tags: [],
    route: '',
    ...extra,
  }) satisfies Neuron

/** 一门课 3 章，每章 1 节；只有第 2 章走过 —— 刻意让链在头尾都断 */
function fixture(): NetworkData {
  const neurons: Neuron[] = [
    neuron('co:c1', 'course', true, { total: 3, lit: 1 }),
    neuron('ch:1', 'chapter', false, { total: 1, lit: 0 }),
    neuron('ch:2', 'chapter', true, { total: 1, lit: 1 }),
    neuron('ch:3', 'chapter', false, { total: 1, lit: 0 }),
    neuron('sec:1', 'section', false),
    neuron('sec:2', 'section', true),
    neuron('sec:3', 'section', false),
    neuron('card:a', 'card', true),
  ]
  const synapses: Synapse[] = [
    { a: 'co:c1', b: 'ch:1', kind: 'structure' },
    { a: 'ch:1', b: 'ch:2', kind: 'spine' },
    { a: 'ch:2', b: 'ch:3', kind: 'spine' },
    { a: 'ch:1', b: 'sec:1', kind: 'structure' },
    { a: 'ch:2', b: 'sec:2', kind: 'structure' },
    { a: 'ch:3', b: 'sec:3', kind: 'structure' },
    { a: 'sec:2', b: 'card:a', kind: 'origin' },
  ]
  return { neurons, synapses, stats: {} }
}

const has = (ss: Synapse[], a: string, b: string) =>
  ss.some((s) => (s.a === a && s.b === b) || (s.a === b && s.b === a))

describe('pruneUnlit：只留走过的地方', () => {
  it('未点亮的节点连同它们的边一起消失', () => {
    const out = pruneUnlit(fixture())
    expect(out.neurons.map((n) => n.id)).toEqual(['co:c1', 'ch:2', 'sec:2', 'card:a'])
    const kept = new Set(out.neurons.map((n) => n.id))
    for (const s of out.synapses) {
      expect(kept.has(s.a), s.a).toBe(true)
      expect(kept.has(s.b), s.b).toBe(true)
    }
  })

  it('★ 第一章没走过时，课程要重连到第一个走过的章 —— 否则整门课和自己的章断开', () => {
    const out = pruneUnlit(fixture())
    expect(has(out.synapses, 'co:c1', 'ch:2')).toBe(true)
  })

  it('★ 没有任何节点掉出骨架：留下的每个点都还连着东西', () => {
    const out = pruneUnlit(fixture())
    const touched = new Set(out.synapses.flatMap((s) => [s.a, s.b]))
    for (const n of out.neurons) expect(touched.has(n.id), n.id).toBe(true)
  })

  it('中间的章被摘掉时，前后两章直接接上（顺序取自 spine 边，不靠数组下标）', () => {
    const data = fixture()
    // 让 1、3 章走过，2 章没走 —— 断在中间
    for (const n of data.neurons) {
      if (n.id === 'ch:2' || n.id === 'sec:2') n.learned = false
      if (n.id === 'ch:1' || n.id === 'ch:3' || n.id === 'sec:1' || n.id === 'sec:3')
        n.learned = true
    }
    const out = pruneUnlit(data)
    expect(has(out.synapses, 'co:c1', 'ch:1')).toBe(true)
    expect(has(out.synapses, 'ch:1', 'ch:3')).toBe(true)
    expect(has(out.synapses, 'ch:1', 'ch:2')).toBe(false)
  })

  it('全都走过时原样返回（同一个对象，省掉一次布局重建）', () => {
    const data = fixture()
    for (const n of data.neurons) n.learned = true
    expect(pruneUnlit(data)).toBe(data)
  })

  it('骨架成环也不会转不出来（脏数据不该把页面挂死）', () => {
    const data = fixture()
    data.synapses.push({ a: 'ch:3', b: 'ch:1', kind: 'spine' })
    for (const n of data.neurons) n.learned = true
    // 全点亮走的是原样返回那条路，这里改一个未点亮的逼它真的走链
    data.neurons[1].learned = false
    expect(() => pruneUnlit(data)).not.toThrow()
  })

  it('摘完之后布局里没有悬空边', () => {
    const out = pruneUnlit(fixture())
    const layout = new NeuralLayout(out, 800, 600)
    expect(layout.edges.length).toBe(out.synapses.length)
  })
})

describe('nodeRadius：一条规则管五种节点', () => {
  it('★ 240 节的课比一张孤卡大，但只大三倍左右', () => {
    const course = nodeRadius(neuron('co:x', 'course', true, { total: 240, lit: 30 }))
    const card = nodeRadius(neuron('k', 'card', true, { degree: 1 }))
    expect(course).toBeGreaterThan(card * 2)
    expect(course).toBeLessThan(card * 4)
  })

  it('★ 课程不能因为 degree 恒为 1 而缩成最小的点', () => {
    // 课程只连第一章 —— 纯按 degree 算，一门 240 节的课和一张卡一样大
    const course = neuron('co:x', 'course', true, { total: 240, degree: 1 })
    const chapter = neuron('ch:x', 'chapter', true, { total: 6, degree: 7 })
    expect(nodeRadius(course)).toBeGreaterThan(nodeRadius(chapter))
  })

  it('还没走到的地方压小成薄雾', () => {
    const on = neuron('s', 'section', true, { degree: 3 })
    const off = neuron('s', 'section', false, { degree: 3 })
    expect(nodeRadius(off)).toBeLessThan(nodeRadius(on) * 0.6)
  })

  it('被反复回想的卡片会长大 —— 那是它值钱的唯一证据', () => {
    const cold = neuron('k', 'card', true, { degree: 1, touch: 0 })
    const warm = neuron('k', 'card', true, { degree: 1, touch: 8 })
    expect(nodeRadius(warm)).toBeGreaterThan(nodeRadius(cold))
  })
})

describe('颜色：只有三件要行动的事配得上一个颜色', () => {
  const body = (n: Neuron): Body => ({
    ...n,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    r: 3,
    act: 0,
    actKind: null,
    born: 1,
  })

  for (const [name, P] of [
    ['深底', DARK_PALETTE],
    ['浅底', LIGHT_PALETTE],
  ] as const) {
    it(`${name}：还没走到 → 最淡；该复习 → 提醒色；亲手写过 → 己见色`, () => {
      expect(neuronColor(body(neuron('a', 'section', false)), P)).toBe(P.nodeUnlit)
      expect(neuronColor(body(neuron('a', 'card', true, { due: true })), P)).toBe(P.nodeDue)
      expect(neuronColor(body(neuron('a', 'card', true, { rewritten: true })), P)).toBe(
        P.nodeRewritten,
      )
      // ★ 笔记本身就是"亲手写过"，不该再靠一圈描边说第二遍
      expect(neuronColor(body(neuron('a', 'note', true)), P)).toBe(P.nodeRewritten)
      // 课程 / 章 / 小节 / 疑问卡不再各占一色，类型交给大小和位置表达
      for (const k of ['course', 'chapter', 'section', 'card'] as const) {
        expect(neuronColor(body(neuron('a', k, true)), P), k).toBe(P.node)
      }
    })
  }

  it('★ 待复习压过己见 —— 该复习是有时限的行动，己见是状态', () => {
    const P = DARK_PALETTE
    const both = body(neuron('a', 'note', true, { due: true, rewritten: true }))
    expect(neuronColor(both, P)).toBe(P.nodeDue)
  })

  it('系统自动连的线全都一个样，只有亲手拉的线例外', () => {
    const P = DARK_PALETTE
    for (const k of ['structure', 'spine', 'origin', 'parent'] as const) {
      expect(synapseColor(k, P), k).toBe(P.edge)
    }
    expect(synapseColor('real', P)).toBe(P.edgeReal)
  })
})
