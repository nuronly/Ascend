import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * 概念图在真实浏览器里「有数据但画布空白」的复现测试。
 *
 * 数据层验证过是健康的（5 节点 5 边、无悬空、字段对齐），
 * 那就只剩组件渲染管线。这里把整个页面挂起来，喂真实 overlay 响应，
 * 盯住两件事：cytoscape 有没有真的初始化、有没有异常被吞掉。
 */

// 真实 overlay 响应（从本地游客账号的 Transformer 课导出）
const OVERLAY = {
  nodes: [
    { id: 'c1', label: '查询', description: '注意力机制中表示当前位置想要知道什么的向量', section_id: 's1', course_id: 'k1', card_count: 0, rewritten_count: 0 },
    { id: 'c2', label: '键', description: '被匹配的对象', section_id: 's1', course_id: 'k1', card_count: 0, rewritten_count: 0 },
    { id: 'c3', label: '注意力机制', description: '核心概念', section_id: 's2', course_id: 'k1', card_count: 2, rewritten_count: 1 },
    { id: 'c4', label: '值', description: '最终被加权聚合的信息', section_id: 's2', course_id: 'k1', card_count: 0, rewritten_count: 0 },
    { id: 'c5', label: '自注意力', description: 'QKV 同源', section_id: 's3', course_id: 'k1', card_count: 0, rewritten_count: 0 },
  ],
  edges: [
    { id: 'e1', from: 'c1', to: 'c3', relation: 'prerequisite' },
    { id: 'e2', from: 'c2', to: 'c3', relation: 'prerequisite' },
    { id: 'e3', from: 'c3', to: 'c5', relation: 'related' },
    { id: 'e4', from: 'c4', to: 'c3', relation: 'part_of' },
    { id: 'e5', from: 'c1', to: 'c2', relation: 'contrast' },
  ],
  attachments: {},
  blank_spots: [],
  coverage: 0.2,
}

const apiMock = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }))
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

describe('GraphPage 概念图渲染', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    apiMock.get.mockImplementation((url: string) => {
      if (url === '/courses') return Promise.resolve([{ id: 'k1', topic: 't', title: 'T 课', level: 'intermediate', status: 'ready', stats: {}, created_at: '', chapters: [] }])
      if (url.startsWith('/graph/overlay')) return Promise.resolve(OVERLAY)
      if (url.startsWith('/graph/cards')) return Promise.resolve({ nodes: [], parent_edges: [], links: [] })
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
