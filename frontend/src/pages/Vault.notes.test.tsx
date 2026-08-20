import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import VaultPage from './Vault'

/**
 * 笔记主界面（原「灵感仓库」）。
 *
 * ★ 这一页的立意：卡片整理进仓库其实没人回来看 —— 粒度太碎、网格不是阅读单元、
 *   「归档」本身就是心理上的完结、而且它是过程产物不是成果。所以卡片降级成
 *   素材层，主界面换成笔记。
 *
 * 于是这里钉四件事：
 *   1. 默认就是笔记，按「课程 → 小节」分组（不是时间流）
 *   2. 点开能读到笔记正文（笔记卡没有问答轮次，走错分支会是一片空白）
 *   3. 「未消化的疑问」必须显眼 —— 那是卡片被降级之后唯一的安全阀
 *   4. 疑问那一栏只查划词卡（kind=card），不能把笔记混回去
 */

const { get } = vi.hoisted(() => ({ get: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: { get, post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}))

const NOTEBOOK = {
  undigested: 7,
  groups: [
    {
      course_id: 'co1',
      course_title: 'Transformer 入门',
      sections_total: 12,
      notes: [
        {
          card_id: 'n1',
          section_id: 's1',
          title: '1.2 QKV 的来历',
          state: 'vault',
          edited: true,
          excerpt: '注意力用点积算相似度，除以 √d 是为了让方差不随维度膨胀。',
          cards: 3,
          updated_at: new Date().toISOString(),
        },
        {
          card_id: 'n2',
          section_id: 's2',
          title: '1.3 多头注意力',
          state: 'draft',
          edited: false,
          excerpt: '多个头各看一种关系。',
          cards: 0,
          updated_at: null,
        },
      ],
    },
  ],
}

const NOTE_FULL = {
  id: 'n1',
  kind: 'note' as const,
  question: '1.2 QKV 的来历',
  ai_answer: '## 核心机制\nAI 原来写的那版。',
  user_note: '## 核心机制\n我自己改写过的版本。',
  is_rewritten: true,
  summary: '',
  concept_tags: [],
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
  origin_info: { course_title: 'Transformer 入门', section_title: 'QKV', course_id: 'co1' },
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

/** tab 是按钮，页面标题是 h1 —— 「笔记」两处都有，得按角色区分 */
const tabButton = (label: string) =>
  screen.getAllByRole('button').find((b) => b.textContent?.trim() === label)!

beforeEach(() => {
  get.mockReset()
  get.mockImplementation((url: string) => {
    if (url.startsWith('/vault/notes')) return Promise.resolve(NOTEBOOK)
    if (url.startsWith('/vault/overview')) return Promise.resolve({ total: 42, rewrite_rate: 0.4 })
    if (url.startsWith('/vault/orphans')) return Promise.resolve({ cards: [], hint: '' })
    if (url.startsWith('/vault?')) return Promise.resolve({ total: 0, cards: [] })
    if (url.startsWith('/cards/')) return Promise.resolve(NOTE_FULL)
    return Promise.resolve({})
  })
})
afterEach(cleanup)

describe('笔记主界面', () => {
  it('默认就是笔记，按课程分组，并显示这门课几节有笔记', async () => {
    view()
    await waitFor(() => expect(screen.getByText('Transformer 入门')).toBeTruthy())
    expect(screen.getByText('2 / 12 节有笔记')).toBeTruthy()
    expect(screen.getByText('1.2 QKV 的来历')).toBeTruthy()
    expect(screen.getByText(/除以 √d/)).toBeTruthy()
  })

  it('草稿与已改写都标出来 —— 未收进笔记的最需要被找回', async () => {
    view()
    await waitFor(() => expect(screen.getByText('1.3 多头注意力')).toBeTruthy())
    expect(screen.getByText('草稿')).toBeTruthy()
    expect(screen.getByText('已改写')).toBeTruthy()
    expect(screen.getByText('3 张卡')).toBeTruthy()
  })

  it('点开能读到笔记正文，而不是一片空白', async () => {
    view()
    await waitFor(() => expect(screen.getByText('1.2 QKV 的来历')).toBeTruthy())
    fireEvent.click(screen.getByText('1.2 QKV 的来历'))
    await waitFor(() =>
      expect(screen.getAllByText(/我自己改写过的版本/).length).toBeGreaterThan(0),
    )
    // 原稿仍然翻得出来，去这一节改也有入口
    expect(screen.getByText('看看 AI 原来写的')).toBeTruthy()
    expect(screen.getByText('去这一节修改')).toBeTruthy()
  })

  it('未消化的疑问要显眼，并且能一键跳过去看', async () => {
    view()
    await waitFor(() => expect(screen.getByText('未消化的疑问')).toBeTruthy())
    expect(screen.getByText(/你有/)).toBeTruthy()
    fireEvent.click(screen.getByText('看看是哪些'))
    await waitFor(() => {
      const urls = get.mock.calls.map((c) => String(c[0]))
      // 疑问栏只查划词卡，不能把笔记混回来
      expect(urls.some((u) => u.includes('kind=card'))).toBe(true)
    })
  })

  it('疑问栏明说自己是素材层，值得回头读的是笔记', async () => {
    view()
    await waitFor(() => expect(screen.getByText('Transformer 入门')).toBeTruthy())
    fireEvent.click(tabButton('疑问'))
    await waitFor(() => expect(screen.getByText(/它们是笔记的素材/)).toBeTruthy())
  })

  it('一张笔记都没有时，引导去学一节课而不是去建卡片', async () => {
    get.mockImplementation((url: string) => {
      if (url.startsWith('/vault/notes')) return Promise.resolve({ groups: [], undigested: 0 })
      if (url.startsWith('/vault/overview')) return Promise.resolve({ total: 0 })
      return Promise.resolve({ total: 0, cards: [] })
    })
    view()
    await waitFor(() => expect(screen.getByText('还没有笔记')).toBeTruthy())
    expect(screen.getByText(/生成本节笔记/)).toBeTruthy()
  })
})
