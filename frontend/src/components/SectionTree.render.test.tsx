import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ChapterBrief } from '@/lib/types'
import SectionTree from './SectionTree'

/**
 * 学习路径树的渲染。
 *
 * 这是学习者打开课程看到的第一样东西，它一乱、一空，整个课程页就废了。
 * 早先画在 canvas 上，测试只能验证「初始化没抛异常」——真正要紧的
 * 「文字有没有显示、连线有没有画对」根本测不到（canvas 里没有 DOM）。
 * 改成 HTML 节点 + SVG 连线之后这些才变得可测，所以这里直接断言
 * 看得见的东西。分层与坐标的正确性在 lib/treeLayout.test.ts。
 */

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
  afterEach(cleanup)

  it('没有小节时什么都不渲染（大纲还没出来的阶段）', () => {
    const { container } = render(<SectionTree chapters={[]} onSelect={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('章里没有任何小节也不崩', () => {
    const empty: ChapterBrief[] = [{ id: 'c', idx: 0, title: '空章', summary: '', sections: [] }]
    const { container } = render(<SectionTree chapters={empty} onSelect={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it('每个小节的标题都显示出来（不是只有编号）', () => {
    const { getByText } = render(<SectionTree chapters={CHAPTERS} onSelect={() => {}} />)
    for (const t of ['什么是注意力', 'QKV 的来历', '多头注意力', '位置编码']) {
      expect(getByText(t)).toBeTruthy()
    }
  })

  // 注意查 .tree-edges 而不是 svg path：「学完」的对勾也是 svg path
  it('依赖被画成连线', () => {
    const { container } = render(<SectionTree chapters={CHAPTERS} onSelect={() => {}} />)
    // s2 依赖 s1、s3 依赖 s1 —— 两条线，从 s1 分叉出去
    expect(container.querySelectorAll('.tree-edges path').length).toBe(2)
  })

  it('没有任何依赖时不画线，但节点照常显示', () => {
    const noDeps = CHAPTERS.map((ch) => ({
      ...ch,
      sections: ch.sections.map((s) => ({ ...s, prerequisite_ids: [] })),
    }))
    const { container, getByText } = render(<SectionTree chapters={noDeps} onSelect={() => {}} />)
    expect(container.querySelectorAll('.tree-edges path').length).toBe(0)
    expect(getByText('多头注意力')).toBeTruthy()
  })

  it('小节编号按「章.节」显示', () => {
    const { getByText } = render(<SectionTree chapters={CHAPTERS} onSelect={() => {}} />)
    for (const n of ['1.1', '1.2', '2.1', '2.2']) {
      expect(getByText(n)).toBeTruthy()
    }
  })

  it('点小节回调它的 id', () => {
    const onSelect = vi.fn()
    const { getByText } = render(<SectionTree chapters={CHAPTERS} onSelect={onSelect} />)
    fireEvent.click(getByText('多头注意力'))
    expect(onSelect).toHaveBeenCalledWith('s3')
  })

  it('悬停时把要点和前置说清楚（标题在方块里会被截断）', () => {
    const { getByText, queryByText } = render(
      <SectionTree chapters={CHAPTERS} onSelect={() => {}} />,
    )
    expect(queryByText(/需先学/)).toBeNull()

    fireEvent.mouseEnter(getByText('QKV 的来历'))
    // 前置必须翻成人看得懂的名字，不能是 id
    expect(getByText(/需先学：1\.1 什么是注意力/)).toBeTruthy()
    expect(queryByText('s1')).toBeNull()
  })

  it('悬停已学完的小节会说明状态与卡片数', () => {
    const { getByText } = render(<SectionTree chapters={CHAPTERS} onSelect={() => {}} />)
    fireEvent.mouseEnter(getByText('什么是注意力'))
    expect(getByText(/已学完/)).toBeTruthy()
    expect(getByText(/2 张卡/)).toBeTruthy()
  })

  it('activeId 的小节被标成「下一步」', () => {
    const { getByText } = render(
      <SectionTree chapters={CHAPTERS} activeId="s2" onSelect={() => {}} />,
    )
    fireEvent.mouseEnter(getByText('QKV 的来历'))
    expect(getByText(/下一步/)).toBeTruthy()
  })

  it('图例把三种状态解释清楚（三个没有说明的颜色等于没有信息）', () => {
    const { getByText } = render(<SectionTree chapters={CHAPTERS} onSelect={() => {}} />)
    expect(getByText('未开始')).toBeTruthy()
    expect(getByText('读过')).toBeTruthy()
    expect(getByText('学完')).toBeTruthy()
  })
})
