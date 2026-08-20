import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { ChapterBrief } from '@/lib/types'

/**
 * 学习路径图的渲染管线测试。
 *
 * 这张图是学习者打开课程看到的第一样东西，它一空白，整个课程页就等于废了。
 * 而「有数据但画布空白」在 cytoscape 上出现过三次（容器塌成宽×0、
 * zoom 被算成 0、异常被吞掉），每次都因为空白和「真没数据」长得一模一样
 * 而排查很久。所以这里钉住两条：
 *   1. 没有小节时安静地什么都不渲染（不是留一个空壳容器）
 *   2. 初始化失败时必须把错误显示出来
 */

// jsdom 没有 canvas 2d 上下文，cytoscape 初始化必然抛错 ——
// 正好拿它验证错误捕获路径
HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null) as never

import SectionTree, { sectionGridPositions } from './SectionTree'

/** 两章四节：1.1 → 1.2 有依赖，2.1 跨章依赖 1.1，2.2 无前置 */
const CHAPTERS: ChapterBrief[] = [
  {
    id: 'c1',
    idx: 0,
    title: '基础',
    summary: '',
    sections: [
      {
        id: 's1',
        idx: 0,
        title: '什么是注意力',
        summary: '从检索的类比讲起',
        content_status: 'ready',
        key_concepts: ['注意力'],
        prerequisite_ids: [],
        completed: true,
        card_count: 2,
      },
      {
        id: 's2',
        idx: 1,
        title: 'QKV 的来历',
        summary: '',
        content_status: 'ready',
        key_concepts: [],
        prerequisite_ids: ['s1'],
        completed: false,
        card_count: 0,
      },
    ],
  },
  {
    id: 'c2',
    idx: 1,
    title: '深入',
    summary: '',
    sections: [
      {
        id: 's3',
        idx: 0,
        title: '多头注意力',
        summary: '',
        content_status: 'pending',
        key_concepts: [],
        prerequisite_ids: ['s1'],
        completed: false,
        card_count: 0,
      },
      {
        id: 's4',
        idx: 1,
        title: '位置编码',
        summary: '',
        content_status: 'pending',
        key_concepts: [],
        prerequisite_ids: [],
        completed: false,
        card_count: 0,
      },
    ],
  },
]

describe('SectionTree', () => {
  // 这个文件里 render 了多次；不清理的话上一次的 DOM 还挂着，
  // 按文本查询会撞上「找到多个元素」
  afterEach(cleanup)

  it('没有小节时什么都不渲染（大纲还没出来的阶段）', () => {
    const { container } = render(
      <SectionTree chapters={[]} onSelect={() => {}} />,
    )
    expect(container.firstChild).toBeNull()
  })

  it('章里没有任何小节也不崩', () => {
    const empty: ChapterBrief[] = [{ id: 'c', idx: 0, title: '空章', summary: '', sections: [] }]
    const { container } = render(<SectionTree chapters={empty} onSelect={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('画布初始化失败时把错误显示出来，而不是一片空白', async () => {
    const { findByText } = render(
      <SectionTree chapters={CHAPTERS} activeId="s2" onSelect={() => {}} />,
    )
    const title = await findByText('路径图渲染失败', undefined, { timeout: 4000 })
    expect(title).toBeTruthy()
  })

  it('图例把三种状态解释清楚（三个没有说明的颜色等于没有信息）', async () => {
    const { findByText } = render(<SectionTree chapters={CHAPTERS} onSelect={() => {}} />)
    expect(await findByText('未开始')).toBeTruthy()
    expect(await findByText('读过')).toBeTruthy()
    expect(await findByText('学完')).toBeTruthy()
  })
})

/**
 * 网格坐标。
 *
 * 这张图刻意不跑自动布局 —— dagre 在 44% 屏宽的容器里会把 20 多个带标题的
 * 方块挤成一团（真实数据上试过，没法看）。改成一章一行的确定性网格之后，
 * 「位置可预测」就是它唯一的卖点，所以必须钉死。
 */
describe('sectionGridPositions', () => {
  it('一章一行：同章小节的 y 相同', () => {
    const p = sectionGridPositions(CHAPTERS)
    expect(p['s1'].y).toBe(p['s2'].y)
    expect(p['s3'].y).toBe(p['s4'].y)
  })

  it('章按顺序往下排', () => {
    const p = sectionGridPositions(CHAPTERS)
    expect(p['s3'].y).toBeGreaterThan(p['s1'].y)
  })

  it('章内小节从左到右，且各章对齐成列', () => {
    const p = sectionGridPositions(CHAPTERS)
    expect(p['s2'].x).toBeGreaterThan(p['s1'].x)
    // 每章的第一节都在同一列 —— 对齐是「整齐」的全部来源
    expect(p['s3'].x).toBe(p['s1'].x)
    expect(p['s4'].x).toBe(p['s2'].x)
  })

  it('没有小节时返回空对象', () => {
    expect(sectionGridPositions([])).toEqual({})
  })
})
