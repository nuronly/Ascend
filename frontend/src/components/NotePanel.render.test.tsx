import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import NotePanel from './NotePanel'

/**
 * 本节笔记卡。
 *
 * 这一块的价值全在两件事上，所以测试也只钉这两件：
 *
 *   1. **汇流要看得见、正文要边生成边出现**。用户点了「生成」之后如果只有
 *      一个转圈，这个功能就没意义了。
 *   2. **保存是两步**：先写用户终稿（PATCH note），再把草稿推进仓库（vault）。
 *      漏掉第二步，笔记就永远进不了图谱、检索和复习。
 */

const { get, post, patch, sse } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
  sse: vi.fn(),
}))

vi.mock('@/lib/api', () => ({
  api: { get, post, patch, del: vi.fn() },
  sse: (...args: any[]) => sse(...args),
}))

type Handlers = { onEvent?: (ev: string, d: any) => void; onDone?: () => void }
let h: Handlers = {}

const emit = (ev: string, data: any) => act(() => h.onEvent?.(ev, data))
const finish = () => act(() => h.onDone?.())

function view(completed = true) {
  return render(<NotePanel courseId="co1" sectionId="s1" completed={completed} />)
}

beforeEach(() => {
  get.mockReset()
  post.mockReset()
  patch.mockReset()
  h = {}
  sse.mockReset()
  sse.mockImplementation((_u: string, opts: Handlers) => {
    h = opts
    return Promise.resolve()
  })
})
afterEach(cleanup)

describe('NotePanel', () => {
  it('没有笔记时给出入口，并说清素材是什么', async () => {
    get.mockResolvedValueOnce({ exists: false, card_sources: 3 })
    view()
    await waitFor(() => expect(screen.getByText('把这一节收成一张笔记卡')).toBeTruthy())
    expect(screen.getByText(/你提的 3 个问题/)).toBeTruthy()
    expect(screen.getByText('生成本节笔记')).toBeTruthy()
  })

  it('没学完时入口不抢戏，并提示先读完', async () => {
    get.mockResolvedValueOnce({ exists: false, card_sources: 0 })
    view(false)
    await waitFor(() => expect(screen.getByText(/建议读完这一节再生成/)).toBeTruthy())
  })

  it('汇流的粒子就是真实卡片，正文边生成边出现', async () => {
    get.mockResolvedValueOnce({ exists: false, card_sources: 2 })
    view()
    await waitFor(() => expect(screen.getByText('生成本节笔记')).toBeTruthy())
    fireEvent.click(screen.getByText('生成本节笔记'))

    emit('start', {
      sources: [
        { id: 'c1', label: 'softmax' },
        { id: 'c2', label: '位置编码' },
      ],
    })
    await waitFor(() => expect(screen.getByText('2 张卡片 + 本节原文正在汇入')).toBeTruthy())
    // 每张卡都露脸，用户能数出「我的卡进去了」
    expect(screen.getByText('softmax')).toBeTruthy()
    expect(screen.getByText('位置编码')).toBeTruthy()

    emit('delta', { text: '## 这一节解决了什么问题\n' })
    emit('delta', { text: '点积为什么要缩放。' })
    await waitFor(() => expect(screen.getByText(/点积为什么要缩放/)).toBeTruthy())
  })

  it('还没出正文时先摊开思考，不留空白', async () => {
    get.mockResolvedValueOnce({ exists: false })
    view()
    await waitFor(() => expect(screen.getByText('生成本节笔记')).toBeTruthy())
    fireEvent.click(screen.getByText('生成本节笔记'))
    emit('thinking', { chars: 20, text: '先看他问过哪些问题' })
    await waitFor(() => expect(screen.getByText('先看他问过哪些问题')).toBeTruthy())
  })

  it('已有草稿：显示未保存状态，并能一键保存进仓库', async () => {
    get.mockResolvedValue({
      exists: true,
      card_id: 'n1',
      content: '## 核心机制\n缩放点积。',
      ai_draft: '## 核心机制\n缩放点积。',
      state: 'draft',
      edited: false,
    })
    patch.mockResolvedValueOnce({ ok: true })
    post.mockResolvedValueOnce({ id: 'n1' })
    view()
    await waitFor(() => expect(screen.getByText('草稿 · 未保存进仓库')).toBeTruthy())

    fireEvent.click(screen.getByText('保存进笔记'))
    // ★ 两步：写终稿 + 推进仓库
    await waitFor(() => expect(patch).toHaveBeenCalledWith('/cards/n1/note', {
      user_note: '## 核心机制\n缩放点积。',
    }))
    await waitFor(() => expect(post).toHaveBeenCalledWith('/cards/n1/vault', {}))
  })

  it('改写后仍能翻出 AI 原稿 —— 知道原版还在才敢大改', async () => {
    get.mockResolvedValue({
      exists: true,
      card_id: 'n1',
      content: '我自己重写的版本',
      ai_draft: 'AI 原来写的版本',
      state: 'vault',
      edited: true,
    })
    view()
    await waitFor(() => expect(screen.getByText('已保存')).toBeTruthy())
    expect(screen.getByText('已改写')).toBeTruthy()
    fireEvent.click(screen.getByText('看看 AI 原来写的'))
    await waitFor(() => expect(screen.getByText('AI 原来写的版本')).toBeTruthy())
  })

  it('编辑器里带留白提示，并且重新生成明说不覆盖', async () => {
    get.mockResolvedValue({
      exists: true,
      card_id: 'n1',
      content: '## 我的理解\n',
      ai_draft: '## 我的理解\n',
      state: 'vault',
      edited: false,
    })
    view()
    await waitFor(() => expect(screen.getByText(/不会覆盖现在这张/)).toBeTruthy())
    fireEvent.click(screen.getByText('修改'))
    await waitFor(() => expect(screen.getByText(/最值钱的地方/)).toBeTruthy())
  })

  it('已有笔记时走 cached，直接进读态', async () => {
    get.mockResolvedValueOnce({ exists: false })
    view()
    await waitFor(() => expect(screen.getByText('生成本节笔记')).toBeTruthy())
    get.mockResolvedValue({
      exists: true,
      card_id: 'n1',
      content: '缓存的笔记正文',
      ai_draft: '缓存的笔记正文',
      state: 'vault',
      edited: false,
    })
    fireEvent.click(screen.getByText('生成本节笔记'))
    emit('cached', {
      card_id: 'n1',
      content: '缓存的笔记正文',
      ai_draft: '缓存的笔记正文',
      state: 'vault',
    })
    finish()
    await waitFor(() => expect(screen.getByText('缓存的笔记正文')).toBeTruthy())
  })
})
