import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import VaultPage from './Vault'

/**
 * 笔记主界面（原「灵感仓库」）。
 *
 * ★ 这一页的立意：卡片整理进仓库其实没人回来看 —— 粒度太碎、网格不是阅读单元、
 *   「归档」本身就是心理上的完结、而且它是过程产物不是成果。
 *
 *   所以这一页**只有笔记**：卡片不再独立存在，它绑定在小节与笔记上，
 *   入口只有小节页的卡片空间。己见率也撤了 —— 整理这件事现在发生在笔记里。
 *
 * 钉四件事：
 *   1. 按「课程 → 小节」分组（不是时间流）
 *   2. 点开能读到笔记正文（笔记卡没有问答轮次，走错分支会是一片空白）
 *   3. 能跳回原文小节；「修改笔记」要直接停在笔记面板上
 *   4. 页面里不该再出现卡片/疑问那一套
 */

const { get, navSpy } = vi.hoisted(() => ({ get: vi.fn(), navSpy: vi.fn() }))

vi.mock('@/lib/api', () => ({
  api: { get, post: vi.fn(), patch: vi.fn(), del: vi.fn() },
}))

// MemoryRouter 不碰真实 URL，所以跳转意图只能从 navigate 的调用参数验证
vi.mock('react-router-dom', async (orig) => {
  const actual = await orig<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navSpy }
})

const NOTEBOOK = {
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

/** 按钮文案查找（页面标题是 h1，不会被误当成按钮） */
const tabButton = (label: string) =>
  screen.getAllByRole('button').find((b) => b.textContent?.trim() === label)

beforeEach(() => {
  get.mockReset()
  navSpy.mockReset()
  get.mockImplementation((url: string) => {
    if (url.startsWith('/vault/notes')) return Promise.resolve(NOTEBOOK)
    if (url.startsWith('/vault/overview'))
      return Promise.resolve({ total: 42, notes: 2, notes_done: 1, rewrite_rate: 0.4 })
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

  it('草稿与已改写都标出来，并说清这份笔记吃进了几张卡', async () => {
    view()
    await waitFor(() => expect(screen.getByText('1.3 多头注意力')).toBeTruthy())
    expect(screen.getByText('草稿')).toBeTruthy()
    expect(screen.getByText('已改写')).toBeTruthy()
    expect(screen.getByText('吃进 3 张卡')).toBeTruthy()
  })

  it('点开能读到笔记正文，而不是一片空白', async () => {
    view()
    await waitFor(() => expect(screen.getByText('1.2 QKV 的来历')).toBeTruthy())
    fireEvent.click(screen.getByText('1.2 QKV 的来历'))
    await waitFor(() =>
      expect(screen.getAllByText(/我自己改写过的版本/).length).toBeGreaterThan(0),
    )
    expect(screen.getByText('看看 AI 原来写的')).toBeTruthy()
  })

  it('看笔记时能跳回原文小节；改笔记直接停在笔记面板上', async () => {
    view()
    await waitFor(() => expect(screen.getByText('1.2 QKV 的来历')).toBeTruthy())
    // 列表上每条都有「看原文」，不必先打开弹窗
    expect(screen.getAllByText('看原文 →').length).toBe(2)

    fireEvent.click(screen.getByText('1.2 QKV 的来历'))
    await waitFor(() => expect(screen.getByText('看原文小节')).toBeTruthy())

    fireEvent.click(screen.getByText('看原文小节'))
    expect(navSpy).toHaveBeenCalledWith('/courses/co1/sections/s1')

    fireEvent.click(screen.getByText('修改笔记'))
    // panel=note 让右栏直接停在笔记上，不用再点一次
    expect(navSpy).toHaveBeenCalledWith('/courses/co1/sections/s1?panel=note')
  })

  it('页面里不再有卡片那一套：没有疑问栏、没有己见率', async () => {
    view()
    await waitFor(() => expect(screen.getByText('Transformer 入门')).toBeTruthy())
    expect(tabButton('疑问')).toBeUndefined()
    expect(screen.queryByText('己见率')).toBeNull()
    expect(screen.queryByText('未消化的疑问')).toBeNull()
    expect(screen.queryByText('孤岛卡')).toBeNull()
  })

  it('一张笔记都没有时，引导去学一节课而不是去建卡片', async () => {
    get.mockImplementation((url: string) => {
      if (url.startsWith('/vault/notes')) return Promise.resolve({ groups: [] })
      if (url.startsWith('/vault/overview')) return Promise.resolve({ total: 0, notes: 0 })
      return Promise.resolve({ total: 0, cards: [] })
    })
    view()
    await waitFor(() => expect(screen.getByText('还没有笔记')).toBeTruthy())
    expect(screen.getByText(/生成本节笔记/)).toBeTruthy()
  })
})
