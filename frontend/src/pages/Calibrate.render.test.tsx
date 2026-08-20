import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import CalibratePage from './Calibrate'

/**
 * 开课前的边界校准页。
 *
 * 这一页取代了「入门 / 进阶 / 深入」，它有一条不能破的铁律：
 * **永远不许挡住开课**。点开课的那一秒是这个产品最珍贵的资源 ——
 * 概念地图失败、模型超时、用户没耐心，都必须有一键直达的出口。
 * 所以这里断言的重点不是好看，而是「出口一直在」和「勾选真的会改变问的问题」。
 */

const { post } = vi.hoisted(() => ({ post: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: { post, get: vi.fn(), del: vi.fn(), patch: vi.fn() },
}))

const MAP = {
  concepts: [
    { name: '矩阵乘法', gloss: '两个矩阵相乘', depth: 1, probe: '为什么不可交换？', preset: '' },
    { name: 'softmax', gloss: '归一化成概率', depth: 2, probe: '它为什么对最大值敏感？', preset: 'known' },
    { name: '自注意力', gloss: '每个词看别的词', depth: 3, probe: '为什么要除以根号 d？', preset: '' },
  ],
  goals: [
    { kind: 'read_paper', label: '能读懂原论文的公式部分' },
    { kind: 'build', label: '能自己写一个 mini 实现' },
  ],
}

function view(search = '?topic=Transformer') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/new${search}`]}>
        <CalibratePage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => post.mockReset())
afterEach(cleanup)

describe('CalibratePage', () => {
  it('概念按依赖深度分三档摆出来，每个都带人话解释', async () => {
    post.mockResolvedValueOnce(MAP)
    view()
    await waitFor(() => expect(screen.getByText('自注意力')).toBeTruthy())
    expect(screen.getByText('外围基础')).toBeTruthy()
    expect(screen.getByText('直接前置')).toBeTruthy()
    expect(screen.getByText('主题内核心')).toBeTruthy()
    // 认不出名字的人会把「熟悉」误判成「没接触」，所以解释必须在
    expect(screen.getByText('每个词看别的词')).toBeTruthy()
  })

  it('学过的概念被预勾，并且明确告诉用户为什么', async () => {
    post.mockResolvedValueOnce(MAP)
    view()
    await waitFor(() => expect(screen.getByText(/已经替你勾了 1 个/)).toBeTruthy())
    // 预勾的那个默认就是「熟悉」，于是它的抽查题也已经出现
    expect(screen.getByText(/它为什么对最大值敏感/)).toBeTruthy()
  })

  it('抽查跟着勾选变：勾了最深的那个，问的就是它', async () => {
    post.mockResolvedValueOnce(MAP)
    view()
    await waitFor(() => expect(screen.getByText('自注意力')).toBeTruthy())
    expect(screen.queryByText(/为什么要除以根号 d/)).toBeNull()

    fireEvent.click(within(rowOf('自注意力')).getByText('熟悉'))

    await waitFor(() => expect(screen.getByText(/为什么要除以根号 d/)).toBeTruthy())
  })

  it('最深档全勾熟悉时，当场说这门课太浅', async () => {
    post.mockResolvedValueOnce({
      concepts: [1, 2, 3].map((i) => ({
        name: `核心${i}`,
        gloss: '',
        depth: 3,
        probe: `q${i}`,
        preset: 'known',
      })),
      goals: [],
    })
    view()
    await waitFor(() => expect(screen.getByText('这门课对你可能太浅了')).toBeTruthy())
  })

  it('概念地图失败也能一键开课 —— 绝不挡住最珍贵的那一秒', async () => {
    post.mockResolvedValueOnce({ concepts: [], goals: [], degraded: true })
    view()
    await waitFor(() => expect(screen.getByText('这次没能生成概念地图')).toBeTruthy())
    fireEvent.click(screen.getByText('直接开始'))
    // 第二次调用就是建课，且不带 calibration
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post.mock.calls[1][0]).toBe('/courses')
    expect(post.mock.calls[1][1]).not.toHaveProperty('calibration')
  })

  it('提交时把三态、目标、抽查回答一起送出去', async () => {
    post.mockResolvedValueOnce(MAP)
    post.mockResolvedValueOnce({ id: 'c1' })
    view('?topic=Transformer&extra=偏工程')
    await waitFor(() => expect(screen.getByText('自注意力')).toBeTruthy())

    fireEvent.click(within(rowOf('矩阵乘法')).getByText('听过'))
    fireEvent.click(screen.getByText('能自己写一个 mini 实现'))
    fireEvent.change(screen.getByPlaceholderText('一句话说说你的理解…'), {
      target: { value: '因为点积会随维度变大' },
    })
    fireEvent.click(screen.getByText('按这个边界开课'))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    const body = post.mock.calls[1][1] as any
    expect(body.topic).toBe('Transformer')
    expect(body.extra).toBe('偏工程')
    expect(body.calibration.concepts).toEqual([
      { name: '矩阵乘法', state: 'shaky' },
      { name: 'softmax', state: 'known' },
      { name: '自注意力', state: 'unknown' },
    ])
    expect(body.calibration.goal).toBe('能自己写一个 mini 实现')
    expect(body.calibration.goal_kind).toBe('build')
    expect(body.calibration.probes).toEqual([
      { concept: 'softmax', question: '它为什么对最大值敏感？', answer: '因为点积会随维度变大' },
    ])
  })

  it('跳过按钮一直在，且不带任何校准数据', async () => {
    post.mockResolvedValueOnce(MAP)
    post.mockResolvedValueOnce({ id: 'c1' })
    view()
    await waitFor(() => expect(screen.getByText('跳过，直接开始')).toBeTruthy())
    fireEvent.click(screen.getByText('跳过，直接开始'))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2))
    expect(post.mock.calls[1][1]).toEqual({ topic: 'Transformer', extra: '' })
  })
})

/** 定位某个概念所在的那一行。
 *  往上走到「自己就带着三态按钮」的那层为止 —— 不依赖具体 DOM 层数，
 *  改了排版也不会把测试一起改坏。 */
function rowOf(name: string): HTMLElement {
  let el: HTMLElement | null = screen.getByText(name)
  const hasStates = (n: HTMLElement) =>
    Array.from(n.querySelectorAll('button')).some((b) => b.textContent?.trim() === '熟悉')
  while (el && !hasStates(el)) el = el.parentElement
  if (!el) throw new Error(`找不到「${name}」所在的行`)
  return el
}
