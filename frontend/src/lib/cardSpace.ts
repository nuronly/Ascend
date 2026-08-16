import { create } from 'zustand'
import { api, sse } from './api'
import type { Card, CardLink, CardOrigin } from './types'
import { toast } from './store'
import { debounce } from './utils'

/**
 * 卡片空间状态。
 *
 * 这是整个产品最核心的交互状态。四条铁律（PLAN §3.2.0）中的
 * 「多张卡同时可见」意味着它必须是一个 **卡片集合** 而不是
 * 「当前卡片」—— 任何形如 currentCard 的设计都会把它退化回
 * 一维 chat。
 */

export interface DraftAnchor {
  selected_text: string
  context_text: string
  text_anchor: Record<string, unknown>
  parent_card_id?: string | null
  origin: CardOrigin
  origin_message_id?: string | null
  origin_offset?: { start?: number; end?: number }
  source_section_id?: string | null
  source_doc_block_id?: string | null
}

interface CardSpaceState {
  sectionId: string | null
  docId: string | null
  cards: Card[]
  links: CardLink[]
  /** 正在流式生成的回答：cardId → 已收到的文本 */
  streaming: Record<string, string>
  /** 正在生成中的卡片集合（用于禁用输入） */
  busy: Set<string>
  focusCardId: string | null
  hoverCardId: string | null
  depthHint: { cardId: string; message: string } | null
  abort: Record<string, AbortController>

  load: (sectionId: string) => Promise<void>
  loadDoc: (docId: string) => Promise<void>
  reset: () => void

  createAndAsk: (anchor: DraftAnchor, question: string) => Promise<string | null>
  ask: (cardId: string, question: string) => Promise<void>
  regenerate: (cardId: string) => Promise<void>
  stopStreaming: (cardId: string) => void

  saveNote: (cardId: string, note: string) => void
  toVault: (cardId: string) => Promise<void>
  bulkVault: (cardIds: string[]) => Promise<void>
  toggleCollapse: (cardId: string) => Promise<void>
  remove: (cardId: string) => Promise<void>
  moveCard: (cardId: string, x: number, y: number) => void

  linkCards: (from: string, to: string, relation?: string) => Promise<void>

  setFocus: (id: string | null) => void
  setHover: (id: string | null) => void
  clearDepthHint: () => void
}

const flushPositions = debounce((positions: Record<string, { canvas_x: number; canvas_y: number }>) => {
  if (Object.keys(positions).length) api.patch('/cards/positions', { positions }).catch(() => {})
}, 700)

let pendingPositions: Record<string, { canvas_x: number; canvas_y: number }> = {}

const flushNote = debounce((cardId: string, note: string) => {
  api.patch(`/cards/${cardId}/note`, { user_note: note }).catch(() => {})
}, 800)

export const useCardSpace = create<CardSpaceState>((set, get) => ({
  sectionId: null,
  docId: null,
  cards: [],
  links: [],
  streaming: {},
  busy: new Set(),
  focusCardId: null,
  hoverCardId: null,
  depthHint: null,
  abort: {},

  load: async (sectionId) => {
    const data = await api.get<{ cards: Card[]; links: CardLink[] }>(
      `/cards?section_id=${sectionId}`,
    )
    set({
      sectionId,
      docId: null,
      cards: data.cards,
      links: data.links,
      streaming: {},
      busy: new Set(),
    })
  },

  /** 文档模式：整篇文档下的卡片（PLAN §3.5，复用同一套卡片空间） */
  loadDoc: async (docId) => {
    const data = await api.get<{ cards: Card[]; links: CardLink[] }>(`/cards?doc_id=${docId}`)
    set({
      docId,
      sectionId: null,
      cards: data.cards,
      links: data.links,
      streaming: {},
      busy: new Set(),
    })
  },

  reset: () => {
    Object.values(get().abort).forEach((a) => a.abort())
    set({
      sectionId: null,
      docId: null,
      cards: [],
      links: [],
      streaming: {},
      busy: new Set(),
      focusCardId: null,
      hoverCardId: null,
      depthHint: null,
      abort: {},
    })
  },

  /** 划词 → 建卡 → 立刻开始流式回答，一气呵成。 */
  createAndAsk: async (anchor, question) => {
    try {
      const docId = get().docId
      const card = await api.post<Card>('/cards', {
        selected_text: anchor.selected_text,
        context_text: anchor.context_text,
        question,
        source_type: anchor.source_doc_block_id || docId ? 'doc' : 'course',
        source_section_id: anchor.source_section_id ?? get().sectionId,
        source_doc_block_id: anchor.source_doc_block_id ?? null,
        text_anchor: anchor.text_anchor,
        parent_card_id: anchor.parent_card_id ?? null,
        origin: anchor.origin,
        origin_message_id: anchor.origin_message_id ?? null,
        origin_offset: anchor.origin_offset ?? {},
      })
      set((s) => ({
        cards: [...s.cards, { ...card, messages: card.messages ?? [] }],
        focusCardId: card.id,
        depthHint: card.depth_hint ? { cardId: card.id, message: card.depth_hint.message } : s.depthHint,
      }))
      await get().ask(card.id, question)
      return card.id
    } catch (e: any) {
      toast.error(e?.message ?? '建卡失败')
      return null
    }
  },

  ask: async (cardId, question) => {
    const ctrl = new AbortController()
    set((s) => ({
      busy: new Set(s.busy).add(cardId),
      streaming: { ...s.streaming, [cardId]: '' },
      abort: { ...s.abort, [cardId]: ctrl },
    }))

    // 乐观插入用户这一问，别让他等 SSE 回来才看到自己说了什么
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === cardId
          ? {
              ...c,
              question: c.question || question,
              messages: [
                ...(c.messages ?? []),
                {
                  id: `tmp-${Date.now()}`,
                  seq: (c.messages?.length ?? 0) * 2,
                  role: 'user' as const,
                  content: question,
                  status: 'done' as const,
                  created_at: new Date().toISOString(),
                },
              ],
            }
          : c,
      ),
    }))

    let text = ''
    await sse(`/cards/${cardId}/ask`, {
      method: 'POST',
      body: { question },
      signal: ctrl.signal,
      onDelta: (chunk) => {
        text += chunk
        set((s) => ({ streaming: { ...s.streaming, [cardId]: text } }))
      },
      onDone: (data) => {
        const content = data?.content ?? text
        set((s) => ({
          cards: s.cards.map((c) =>
            c.id === cardId
              ? {
                  ...c,
                  ai_answer: content,
                  messages: [
                    ...(c.messages ?? []),
                    {
                      id: data?.message_id ?? `a-${Date.now()}`,
                      seq: (c.messages?.length ?? 0) * 2 + 1,
                      role: 'assistant' as const,
                      content,
                      status: 'done' as const,
                      created_at: new Date().toISOString(),
                    },
                  ],
                }
              : c,
          ),
        }))
      },
      onError: (m) => toast.error(m),
    }).catch(() => {})

    set((s) => {
      const busy = new Set(s.busy)
      busy.delete(cardId)
      const streaming = { ...s.streaming }
      delete streaming[cardId]
      const abort = { ...s.abort }
      delete abort[cardId]
      return { busy, streaming, abort }
    })
  },

  regenerate: async (cardId) => {
    const card = get().cards.find((c) => c.id === cardId)
    if (!card) return
    const msgs = card.messages ?? []
    // 去掉末尾的一问一答，界面立刻反映"正在重答"
    let removedUser = false
    let removedAssistant = false
    const kept = [...msgs].reverse().filter((m) => {
      if (!removedAssistant && m.role === 'assistant') {
        removedAssistant = true
        return false
      }
      if (removedAssistant && !removedUser && m.role === 'user') {
        removedUser = true
        return false
      }
      return true
    })
    kept.reverse()
    set((s) => ({ cards: s.cards.map((c) => (c.id === cardId ? { ...c, messages: kept } : c)) }))

    const ctrl = new AbortController()
    set((s) => ({
      busy: new Set(s.busy).add(cardId),
      streaming: { ...s.streaming, [cardId]: '' },
      abort: { ...s.abort, [cardId]: ctrl },
    }))

    let text = ''
    await sse(`/cards/${cardId}/regenerate`, {
      method: 'POST',
      signal: ctrl.signal,
      onDelta: (chunk) => {
        text += chunk
        set((s) => ({ streaming: { ...s.streaming, [cardId]: text } }))
      },
      onError: (m) => toast.error(m),
    }).catch(() => {})

    // 重答涉及消息增删，直接跟服务端对齐最稳
    const fresh = await api.get<Card>(`/cards/${cardId}`).catch(() => null)
    set((s) => {
      const busy = new Set(s.busy)
      busy.delete(cardId)
      const streaming = { ...s.streaming }
      delete streaming[cardId]
      return {
        busy,
        streaming,
        cards: fresh ? s.cards.map((c) => (c.id === cardId ? { ...c, ...fresh } : c)) : s.cards,
      }
    })
  },

  stopStreaming: (cardId) => {
    get().abort[cardId]?.abort()
  },

  saveNote: (cardId, note) => {
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === cardId ? { ...c, user_note: note, is_rewritten: !!note.trim() } : c,
      ),
    }))
    flushNote(cardId, note)
  },

  toVault: async (cardId) => {
    try {
      const updated = await api.post<Card>(`/cards/${cardId}/vault`)
      set((s) => ({
        cards: s.cards.map((c) => (c.id === cardId ? { ...c, ...updated } : c)),
      }))
      toast.ok('已收进仓库')
    } catch (e: any) {
      toast.error(e?.message ?? '收进仓库失败')
    }
  },

  bulkVault: async (cardIds) => {
    if (!cardIds.length) return
    await api.post('/cards/bulk-state', { card_ids: cardIds, state: 'vault' })
    const sid = get().sectionId
    if (sid) await get().load(sid)
  },

  toggleCollapse: async (cardId) => {
    const card = get().cards.find((c) => c.id === cardId)
    if (!card) return
    const collapsed = !card.collapsed
    set((s) => ({ cards: s.cards.map((c) => (c.id === cardId ? { ...c, collapsed } : c)) }))
    api.patch(`/cards/${cardId}/collapse`, { collapsed }).catch(() => {})
  },

  remove: async (cardId) => {
    // 子卡在服务端级联删除，前端同步移除整棵子树
    const all = get().cards
    const doomed = new Set([cardId])
    let grew = true
    while (grew) {
      grew = false
      for (const c of all) {
        if (c.parent_card_id && doomed.has(c.parent_card_id) && !doomed.has(c.id)) {
          doomed.add(c.id)
          grew = true
        }
      }
    }
    set((s) => ({
      cards: s.cards.filter((c) => !doomed.has(c.id)),
      links: s.links.filter((l) => !doomed.has(l.from_card_id) && !doomed.has(l.to_card_id)),
      focusCardId: s.focusCardId && doomed.has(s.focusCardId) ? null : s.focusCardId,
    }))
    await api.del(`/cards/${cardId}`).catch(() => {})
  },

  moveCard: (cardId, x, y) => {
    set((s) => ({
      cards: s.cards.map((c) =>
        c.id === cardId ? { ...c, canvas_x: x, canvas_y: y, pinned: true } : c,
      ),
    }))
    pendingPositions[cardId] = { canvas_x: x, canvas_y: y }
    flushPositions(pendingPositions)
    // debounce 触发后再清，避免丢掉批次里的其它卡
    setTimeout(() => {
      pendingPositions = {}
    }, 800)
  },

  linkCards: async (from, to, relation = 'continuation') => {
    try {
      const link = await api.post<CardLink>(`/cards/${from}/links`, {
        to_card_id: to,
        relation,
      })
      set((s) => ({ links: [...s.links.filter((l) => l.id !== link.id), link] }))
      toast.ok('已建立关联')
    } catch (e: any) {
      toast.error(e?.message ?? '建立关联失败')
    }
  },

  setFocus: (focusCardId) => set({ focusCardId }),
  setHover: (hoverCardId) => set({ hoverCardId }),
  clearDepthHint: () => set({ depthHint: null }),
}))
