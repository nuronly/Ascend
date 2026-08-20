import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import VaultPage from './Vault'

/**
 * 仓库里的笔记卡。
 *
 * ★ 这组测试来自一个真实的漏洞：笔记卡「收进仓库」之后**用户找不到它**。
 *   两处原因：卡片空间那边加了 kind 过滤（对的），但仓库列表默认也被过滤掉了；
 *   而且详情弹窗只渲染问答轮次，笔记卡没有 messages，点开是一片空白 ——
 *   它的正文在 user_note（终稿）/ ai_answer（原稿）里。
 *
 * 所以这里钉三件事：笔记有自己的入口、列表认得出它、点开能看到正文。
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: { get, post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}))

const NOTE = {
  id: 'n1',
  kind: 'note' as const,
  question: '1.2 QKV 的来历',
  ai_answer: '## 核心机制\nAI 原来写的那版。',
  user_note: '## 核心机制\n我自己改写过的版本。',
  is_rewritten: true,
  summary: '',
  concept_tags: ['QKV'],
  source_type: 'course',
  source_section_id: 's1',
  selected_text: 'QKV 的来历',
  context_text: '',
  text_anchor: {},
  origin: 'source_text',
  canvas_x: 0,
  canvas_y: 0,
  collapsed: false,
  pinned: false,
  parent_card_id: null,
  depth: 0,
  state: 'vault' as const,
  touch_count: 0,
  created_at: new Date().toISOString(),
  origin_info: { course_title: 'Transformer', section_title: 'QKV', course_id: 'co1' },
}

function view() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <VaultPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  get.mockReset()
  // 概览与列表共用一个 mock：按 url 分派
  get.mockImplementation((url: string) => {
    if (url.startsWith('/vault/overview')) return Promise.resolve({ total: 0 })
    if (url.startsWith('/vault?')) {
      return Promise.resolve(
        url.includes('kind=note') ? { total: 1, cards: [NOTE] } : { total: 0, cards: [] },
      )
    }
    if (url.startsWith('/cards/')) return Promise.resolve(NOTE)
    return Promise.resolve({})
  })
})
afterEach(cleanup)

describe('仓库里的笔记', () => {
  it('有独立的「笔记」入口', async () => {
    view()
    await waitFor(() => expect(screen.getByText('笔记')).toBeTruthy())
  })

  it('切到笔记栏时按 kind=note 查，并且连草稿一起要', async () => {
    view()
    fireEvent.click(screen.getByText('笔记'))
    await waitFor(() => {
      const urls = get.mock.calls.map((c) => String(c[0]))
      const hit = urls.find((u) => u.includes('kind=note'))
      expect(hit).toBeTruthy()
      // 生成了但还没收进仓库的笔记最需要被找回，所以 state=all
      expect(hit).toContain('state=all')
    })
  })

  it('列表认得出笔记卡，标题用它自己的样子', async () => {
    view()
    fireEvent.click(screen.getByText('笔记'))
    await waitFor(() => expect(screen.getByText(/1\.2 QKV 的来历/)).toBeTruthy())
    // 摘要取终稿正文，且不该把 Markdown 标题符号显示出来
    expect(screen.getByText(/我自己改写过的版本/)).toBeTruthy()
  })

  it('点开能看到笔记正文 —— 而不是一片空白', async () => {
    view()
    fireEvent.click(screen.getByText('笔记'))
    await waitFor(() => expect(screen.getByText(/1\.2 QKV 的来历/)).toBeTruthy())
    fireEvent.click(screen.getByText(/1\.2 QKV 的来历/))
    await waitFor(() =>
      expect(screen.getAllByText(/我自己改写过的版本/).length).toBeGreaterThan(0),
    )
    // 原稿仍然翻得出来
    expect(screen.getByText('看看 AI 原来写的')).toBeTruthy()
  })
})
