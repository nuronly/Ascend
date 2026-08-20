import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import RunTimeline, { type ToolStep } from './RunTimeline'

/**
 * 生成过程时间线的渲染。
 *
 * 这个组件唯一的职责就是「让等待可见」：模型在想什么、在查什么、查到了什么。
 * 它一空白，用户就以为卡死了 —— 所以这里断言的全是**看得见的字**，
 * 尤其是思维链原文：只显示「已推理 N 字」的老行为等于什么都没说。
 */

afterEach(cleanup)

const SEARCH: ToolStep = {
  name: 'web_search',
  query: 'Transformer 注意力机制 教程',
  state: 'done',
  detail: '找到 5 条结果',
  items: [
    {
      title: 'Attention Is All You Need',
      url: 'https://arxiv.org/abs/1706.03762',
      source: 'arxiv.org',
      kind: 'paper',
      authority: 2,
    },
  ],
}

describe('RunTimeline', () => {
  it('思维链原文要摊出来，不能只报字数', () => {
    render(<RunTimeline thinking={12} thinkingText="先确认这个领域的标准划分" tools={[]} />)
    expect(screen.getByText('先确认这个领域的标准划分')).toBeTruthy()
    expect(screen.getByText(/12/)).toBeTruthy()
  })

  it('思维链追加后显示的是完整的最新文本', () => {
    const { rerender } = render(<RunTimeline thinking={4} thinkingText="第一句。" tools={[]} />)
    rerender(<RunTimeline thinking={9} thinkingText="第一句。第二句。" tools={[]} />)
    expect(screen.getByText('第一句。第二句。')).toBeTruthy()
  })

  it('没有思维链原文时只显示状态行，不留空块', () => {
    const { container } = render(<RunTimeline thinking={30} tools={[]} />)
    expect(screen.getByText('正在深入思考')).toBeTruthy()
    // 只有那一行，没有多出一个空的滚动区
    expect(container.querySelectorAll('.whitespace-pre-wrap').length).toBe(0)
  })

  it('检索的查询词和来源都要露出来，用户才能判断可信度', () => {
    render(<RunTimeline thinking={0} tools={[SEARCH]} />)
    expect(screen.getByText('Transformer 注意力机制 教程')).toBeTruthy()
    expect(screen.getByText('找到 5 条结果')).toBeTruthy()
    const link = screen.getByText('Attention Is All You Need').closest('a')
    expect(link?.getAttribute('href')).toBe('https://arxiv.org/abs/1706.03762')
    // 权威来源要标出来：学习者靠它区分论文和随手一篇博客
    expect(screen.getByText('权威')).toBeTruthy()
    expect(screen.getByText('arxiv.org')).toBeTruthy()
  })

  it('章节标题逐条冒出来', () => {
    render(<RunTimeline thinking={0} tools={[]} titles={['开篇', '注意力', '多头']} />)
    expect(screen.getByText('多头')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('什么都还没发生时也要有话说 —— 空白最劝退', () => {
    render(<RunTimeline thinking={0} tools={[]} />)
    expect(screen.getByText('正在连接模型…')).toBeTruthy()
  })
})
