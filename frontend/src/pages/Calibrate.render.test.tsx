import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import CalibratePage from './Calibrate'

/**
 * 刷题式的边界校准页。
 *
 * 这一页取代了「入门 / 进阶 / 深入」，它有两条不能破的铁律：
 *
 *   1. **不许让用户对着空白等**。模型规划这十几个概念要想 20~30 秒，所以
 *      概念是一道一道流过来的：来一道就能答一道，还没来就把思维链摊出来。
 *   2. **不许挡住开课**。任何阶段都有出口，流式失败也要能拿已到手的几道继续。
 *
 * 所以这里断言的重点是「边到边答」和「出口一直在」，而不是排版。
 */

const { post, sse } = vi.hoisted(() => ({ post: vi.fn(), sse: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: { post, get: vi.fn(), del: vi.fn(), patch: vi.fn() },
  sse: (...args: any[]) => sse(...args),
}))

type Handlers = {
  onEvent?: (ev: string, data: any) => void
  onDone?: () => void
  onError?: (m: string) => void
}

/** 抓住页面注册的回调，测试自己控制事件节奏 —— 这才测得出「边到边答」 */
let h: Handlers = {}

function emit(ev: string, data: any) {
  act(() => h.onEvent?.(ev, data))
}
function finish() {
  act(() => h.onDone?.())
}

const C = (name: string, depth: 1 | 2 | 3, probe = '', preset = '') => ({
  name,
  gloss: `${name} 的一句话解释`,
  depth,
  probe,
  preset,
})

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

beforeEach(() => {
  post.mockReset()
  h = {}
  sse.mockReset()
  sse.mockImplementation((_url: string, opts: Handlers) => {
    h = opts
    return Promise.resolve()
  })
})
afterEach(cleanup)

describe('CalibratePage', () => {
  it('第一道还没到时显示思考过程，不留空白', async () => {
    view()
    expect(screen.getByText('正在规划要问你哪些概念…')).toBeTruthy()
    emit('thinking', { chars: 42, text: '先确认这个主题需要哪些前置' })
    await waitFor(() => expect(screen.getByText('先确认这个主题需要哪些前置')).toBeTruthy())
    // 等不及也能直接走
    expect(screen.getByText('不等了，直接开课')).toBeTruthy()
  })

  it('总题数一到就说得出还剩几道', async () => {
    view()
    emit('total', { total: 15 })
    emit('concept', { ...C('矩阵乘法', 1), idx: 1 })
    await waitFor(() => expect(screen.getByText('1 / 15')).toBeTruthy())
    expect(screen.getByText(/已规划 1 \/ 15/)).toBeTruthy()
  })

  it('来一道答一道：答完当前的就等下一道，而不是卡住', async () => {
    view()
    emit('total', { total: 3 })
    emit('concept', { ...C('矩阵乘法', 1), idx: 1 })
    await waitFor(() => expect(screen.getByText('矩阵乘法')).toBeTruthy())

    fireEvent.click(screen.getByText('熟悉'))
    // 下一道还没到 → 显示「正在规划下一道」，不是空白也不是结束
    await waitFor(() => expect(screen.getByText('正在规划下一道…')).toBeTruthy())

    emit('concept', { ...C('softmax', 2), idx: 2 })
    await waitFor(() => expect(screen.getByText('softmax')).toBeTruthy())
    expect(screen.getByText('2 / 3')).toBeTruthy()
  })

  it('键盘 1/2/3 能答题，← 能回上一道改答案', async () => {
    view()
    emit('concept', { ...C('矩阵乘法', 1), idx: 1 })
    emit('concept', { ...C('softmax', 2), idx: 2 })
    await waitFor(() => expect(screen.getByText('矩阵乘法')).toBeTruthy())

    act(() => void fireEvent.keyDown(window, { key: '2' }))
    await waitFor(() => expect(screen.getByText('softmax')).toBeTruthy())

    act(() => void fireEvent.keyDown(window, { key: 'ArrowLeft' }))
    await waitFor(() => expect(screen.getByText('矩阵乘法')).toBeTruthy())
  })

  it('答完全部且流结束后进入定目标', async () => {
    view()
    emit('concept', { ...C('矩阵乘法', 1), idx: 1 })
    emit('goals', { goals: [{ kind: 'build', label: '能自己写一个 mini 实现' }] })
    finish()
    await waitFor(() => expect(screen.getByText('矩阵乘法')).toBeTruthy())
    fireEvent.click(screen.getByText('没接触'))
    await waitFor(() => expect(screen.getByText('学完之后你想能做什么')).toBeTruthy())
    expect(screen.getByText('能自己写一个 mini 实现')).toBeTruthy()
  })

  it('最深档全勾熟悉时当场说这门课太浅', async () => {
    view()
    ;[1, 2, 3].forEach((i) => emit('concept', { ...C(`核心${i}`, 3, `q${i}`), idx: i }))
    emit('goals', { goals: [] })
    finish()
    await waitFor(() => expect(screen.getByText('核心1')).toBeTruthy())
    fireEvent.click(screen.getByText('熟悉'))
    fireEvent.click(screen.getByText('熟悉'))
    fireEvent.click(screen.getByText('熟悉'))
    await waitFor(() => expect(screen.getByText('这门课对你可能太浅了')).toBeTruthy())
  })

  it('一道都没规划出来也能一键开课 —— 绝不挡住最珍贵的那一秒', async () => {
    post.mockResolvedValueOnce({ id: 'c1' })
    view()
    emit('error', { message: '上游 500' })
    finish()
    await waitFor(() => expect(screen.getByText('这次没能规划出概念')).toBeTruthy())
    fireEvent.click(screen.getByText('直接开始'))
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    expect(post.mock.calls[0][0]).toBe('/courses')
    expect(post.mock.calls[0][1]).toEqual({ topic: 'Transformer', extra: '' })
  })

  it('中途失败也用已经到手的几道继续，不浪费', async () => {
    view()
    emit('concept', { ...C('矩阵乘法', 1), idx: 1 })
    emit('error', { message: '断了' })
    finish()
    await waitFor(() => expect(screen.getByText('矩阵乘法')).toBeTruthy())
    fireEvent.click(screen.getByText('听过'))
    await waitFor(() => expect(screen.getByText(/用已经问到的 1 道继续/)).toBeTruthy())
  })

  it('提交时把三态、目标、抽查回答一起送出去', async () => {
    post.mockResolvedValueOnce({ id: 'c1' })
    view('?topic=Transformer&extra=偏工程')
    emit('concept', { ...C('矩阵乘法', 1), idx: 1 })
    emit('concept', { ...C('自注意力', 3, '为什么要除以根号 d？'), idx: 2 })
    emit('goals', { goals: [{ kind: 'build', label: '能自己写一个 mini 实现' }] })
    finish()

    await waitFor(() => expect(screen.getByText('矩阵乘法')).toBeTruthy())
    fireEvent.click(screen.getByText('听过'))
    await waitFor(() => expect(screen.getByText('自注意力')).toBeTruthy())
    fireEvent.click(screen.getByText('熟悉'))

    await waitFor(() => expect(screen.getByText('学完之后你想能做什么')).toBeTruthy())
    fireEvent.click(screen.getByText('能自己写一个 mini 实现'))
    fireEvent.click(screen.getByText('下一步'))

    await waitFor(() => expect(screen.getByText('顺手确认一下')).toBeTruthy())
    fireEvent.change(screen.getByPlaceholderText('一句话说说你的理解…'), {
      target: { value: '因为点积会随维度变大' },
    })
    fireEvent.click(screen.getByText('按这个边界开课'))

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1))
    const body = post.mock.calls[0][1] as any
    expect(body.topic).toBe('Transformer')
    expect(body.extra).toBe('偏工程')
    expect(body.calibration.concepts).toEqual([
      { name: '矩阵乘法', state: 'shaky' },
      { name: '自注意力', state: 'known' },
    ])
    expect(body.calibration.goal).toBe('能自己写一个 mini 实现')
    expect(body.calibration.probes).toEqual([
      { concept: '自注意力', question: '为什么要除以根号 d？', answer: '因为点积会随维度变大' },
    ])
  })

  it('学过的概念预勾成熟悉，并当场说明为什么', async () => {
    view()
    emit('concept', { ...C('softmax', 2, 'q', 'known'), idx: 1 })
    await waitFor(() => expect(screen.getByText('你之前学过它，已经替你勾上了')).toBeTruthy())
  })
})
