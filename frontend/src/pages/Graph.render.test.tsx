import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * 问题图「有数据但画布空白」的复现测试。
 *
 * 数据层验证过是健康的（节点、边、字段都对齐），那就只剩组件渲染管线。
 * 这里把整个页面挂起来喂真实响应，盯住两件事：
 * cytoscape 有没有真的初始化、有没有异常被吞掉。
 */

// 真实 /graph/cards 响应的形状：一条两级的追问链
const CARDS = {
  nodes: [
    {
      id: 'k1',
      label: '注意力到底在算什么',
      depth: 0,
      is_rewritten: false,
      state: 'vault',
      parent_card_id: null,
      concept_tags: ['注意力'],
      touch_count: 2,
      created_at: '2026-01-01T00:00:00+00:00',
      section_id: 's1',
    },
    {
      id: 'k2',
      label: 'QKV 三个矩阵是怎么来的',
      depth: 1,
      is_rewritten: true,
      state: 'vault',
      parent_card_id: 'k1',
      concept_tags: [],
      touch_count: 1,
      created_at: '2026-01-01T00:01:00+00:00',
      section_id: 's1',
    },
  ],
  parent_edges: [{ from: 'k1', to: 'k2', kind: 'parent' }],
  links: [],
}

const apiMock = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(() => Promise.resolve({})),
}))
vi.mock('@/lib/api', () => ({ api: apiMock, sse: vi.fn() }))

// jsdom 没有 canvas 2d 上下文，cytoscape 会退化为不绘制但逻辑照跑
HTMLCanvasElement.prototype.getContext = vi.fn().mockReturnValue(null) as never

import GraphPage from './Graph'

function mount(courseId = 'k1') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[`/graph/${courseId}`]}>
        <Routes>
          <Route path="/graph/:courseId" element={<GraphPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('GraphPage 问题图渲染', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/courses')
        return Promise.resolve([
          {
            id: 'k1',
            topic: 't',
            title: 'T 课',
            level: 'intermediate',
            status: 'ready',
            stats: {},
            created_at: '',
            chapters: [],
          },
        ])
      if (url.startsWith('/graph/cards')) return Promise.resolve(CARDS)
      return Promise.reject(new Error(`未 mock 的 GET ${url}`))
    })
  })

  it('画布初始化失败时把错误显示出来，而不是一片空白', async () => {
    // jsdom 没有 2d canvas，cytoscape 必抛 "Could not create canvas of type 2d" ——
    // 正好拿它验证错误捕获路径：失败必须变成画布上可见的错误状态。
    // 曾经三次出现「有数据但画布空白」，没有错误显示就永远分不清是渲染挂了还是真空。
    const { findByText } = mount()
    const title = await findByText('图谱渲染失败', undefined, { timeout: 4000 })
    expect(title).toBeTruthy()
  })
})
