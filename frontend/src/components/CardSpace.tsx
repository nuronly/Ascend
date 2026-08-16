import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Edge,
  type Node,
  type NodeChange,
  type OnConnect,
} from '@xyflow/react'
import { CardNode, type CardNodeData } from './CardNode'
import { SelectionDemo } from './SelectionDemo'
import { ManualAskInline, ManualAskToolbarButton } from './ManualAsk'
import { useCardSpace } from '@/lib/cardSpace'
import { RELATION_COLORS, type Card, type CardLink } from '@/lib/types'
import { cn, widthForDepth } from '@/lib/utils'
import { Button } from './ui'

/**
 * ★ 卡片空间（PLAN §3.2.0 铁律 #2 #3）
 *
 * 铁律 #2：多张卡**同时可见**，不是一个面板换内容，也不是竖直消息流。
 *          换内容 = 又变回一维 chat，失去全部优势。
 * 铁律 #3：卡与卡之间有**可见连线**，线 = "我从哪个词追问下来的"。
 *
 * 所以这里必须是画布，不能是列表。
 */

const NODE_TYPES = { card: CardNode }

const GAP_X = 400
const GAP_Y = 24
const ROOT_GAP = 60

/**
 * 自动布局：父卡右下方错位排开。
 * 只摆没被用户拖过的卡（pinned=false）—— 拖过就意味着他有自己的安排。
 */
function layout(cards: Card[]): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>()
  const byParent = new Map<string | null, Card[]>()
  for (const c of cards) {
    const k = c.parent_card_id
    if (!byParent.has(k)) byParent.set(k, [])
    byParent.get(k)!.push(c)
  }
  for (const list of byParent.values()) {
    list.sort((a, b) => a.created_at.localeCompare(b.created_at))
  }

  // 估算高度，让兄弟卡不重叠
  const heightOf = (c: Card) => {
    if (c.collapsed) return 40
    const msgs = c.messages ?? []
    const chars = msgs.reduce((n, m) => n + m.content.length, 0)
    return Math.min(500, 130 + Math.round(chars / 2.6) + (c.user_note ? 60 : 0))
  }

  // 后序遍历算子树高度，再前序摆位 —— 保证子树整体不互相压
  const subtree = new Map<string, number>()
  const measure = (c: Card): number => {
    const kids = byParent.get(c.id) ?? []
    const own = heightOf(c)
    if (!kids.length) {
      subtree.set(c.id, own)
      return own
    }
    const kidsTotal = kids.reduce((n, k) => n + measure(k) + GAP_Y, -GAP_Y)
    const h = Math.max(own, kidsTotal)
    subtree.set(c.id, h)
    return h
  }

  const place = (c: Card, x: number, top: number) => {
    const h = subtree.get(c.id) ?? heightOf(c)
    pos.set(c.id, { x, y: top + (h - heightOf(c)) / 2 })
    let cursor = top
    for (const k of byParent.get(c.id) ?? []) {
      const kh = subtree.get(k.id) ?? heightOf(k)
      place(k, x + widthForDepth(c.depth) + (GAP_X - 360), cursor)
      cursor += kh + GAP_Y
    }
  }

  const roots = byParent.get(null) ?? []
  roots.forEach(measure)
  let y = 0
  for (const r of roots) {
    place(r, 0, y)
    y += (subtree.get(r.id) ?? 200) + ROOT_GAP
  }
  return pos
}

function buildEdges(cards: Card[], links: CardLink[]): Edge[] {
  const ids = new Set(cards.map((c) => c.id))
  const edges: Edge[] = []

  // 父子链：结构性连线，实线，颜色随深度略淡（浅层粗、深层细）
  for (const c of cards) {
    if (!c.parent_card_id || !ids.has(c.parent_card_id)) continue
    edges.push({
      id: `p-${c.parent_card_id}-${c.id}`,
      source: c.parent_card_id,
      target: c.id,
      type: 'smoothstep',
      animated: false,
      style: {
        stroke: 'var(--border-strong)',
        strokeWidth: Math.max(1, 2 - c.depth * 0.28),
      },
      markerEnd: { type: MarkerType.ArrowClosed, width: 12, height: 12, color: 'var(--border-strong)' },
    })
  }

  for (const l of links) {
    if (!ids.has(l.from_card_id) || !ids.has(l.to_card_id)) continue
    // 只画用户手建的 real link；历史数据里的 potential 建议不再渲染
    if (l.kind !== 'real') continue

    edges.push({
      id: `l-${l.id}`,
      source: l.from_card_id,
      target: l.to_card_id,
      type: 'straight',
      style: {
        // real link 用暖调琥珀（借 Folium），颜色随语义关系区分
        stroke: RELATION_COLORS[l.relation] ?? 'var(--sem-real)',
        strokeWidth: 1.8,
        opacity: 0.95,
      },
      data: { linkId: l.id, kind: l.kind },
    })
  }
  return edges
}

function Canvas({ className }: { className?: string }) {
  const cards = useCardSpace((s) => s.cards)
  const links = useCardSpace((s) => s.links)
  const moveCard = useCardSpace((s) => s.moveCard)
  const linkCards = useCardSpace((s) => s.linkCards)
  const { fitView, setCenter } = useReactFlow()
  const prevCount = useRef(0)
  const didInitialFit = useRef(false)
  const dragging = useRef(false)

  /**
   * 自动布局的重算时机。
   *
   * 刻意**不**依赖整个 cards：流式回答时 cards 里的内容一直在变，
   * 若跟着重算，卡片会在生成过程中不停跳位置。
   * 只在「卡片增删 / 对话轮次变化 / 折叠状态变化」时重排一次。
   */
  const layoutSig = cards
    .map((c) => `${c.id}:${c.messages?.length ?? 0}:${c.collapsed ? 1 : 0}:${c.depth}`)
    .join('|')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const auto = useMemo(() => layout(cards), [layoutSig])

  const [nodes, setNodes] = useState<Node<CardNodeData>[]>([])

  /**
   * cards → nodes 同步。
   *
   * ★ 拖动流畅度的关键：nodes 必须是**本地 state**，由 applyNodeChanges
   *   逐帧更新。之前把 nodes 直接从 cards 用 useMemo 派生，
   *   等于每一帧都把 React Flow 内部算好的位置覆盖回旧值 ——
   *   卡片会黏滞、跟不上鼠标。
   *
   * ★ 另一半关键：**尽量复用旧的 node 对象引用**。
   *   只要 data.card 没变、位置没变，就返回原对象，
   *   这样 memo 化的 CardNode 完全不会重渲染。
   *   否则一张卡在流式输出时，同屏所有卡片都会跟着重绘。
   */
  useEffect(() => {
    setNodes((prev) => {
      const prevMap = new Map(prev.map((n) => [n.id, n]))
      return cards.map((c) => {
        const old = prevMap.get(c.id)
        const a = auto.get(c.id)
        const pos = c.pinned || !a ? { x: c.canvas_x, y: c.canvas_y } : a

        if (old) {
          const sameCard = old.data.card === c
          // 拖动过程中一律以画布上的实时位置为准，不要被数据流拽回去
          const samePos =
            dragging.current || (old.position.x === pos.x && old.position.y === pos.y)
          if (sameCard && samePos) return old
          return {
            ...old,
            position: dragging.current ? old.position : pos,
            data: sameCard ? old.data : { card: c },
          }
        }
        return {
          id: c.id,
          type: 'card',
          position: pos,
          data: { card: c },
          dragHandle: '.drag-handle',
        }
      })
    })
  }, [cards, auto])

  const edges = useMemo(() => buildEdges(cards, links), [cards, links])

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      // 逐帧应用，包括拖动过程中的 position 变化 —— 这是"跟手"的前提
      setNodes((nds) => applyNodeChanges(changes, nds) as Node<CardNodeData>[])

      for (const ch of changes) {
        if (ch.type !== 'position') continue
        if (ch.dragging) {
          dragging.current = true
        } else if (ch.dragging === false) {
          dragging.current = false
          // 松手才落库，拖动过程中不打网络请求
          if (ch.position) moveCard(ch.id, ch.position.x, ch.position.y)
        }
      }
    },
    [moveCard],
  )

  // 手动拉线建立 real link（用户明确的动作才算 real）
  const onConnect: OnConnect = useCallback(
    (conn) => {
      if (conn.source && conn.target && conn.source !== conn.target) {
        linkCards(conn.source, conn.target)
      }
    },
    [linkCards],
  )

  // 新卡出现时把视口移过去，不然用户不知道卡生成在哪
  useEffect(() => {
    if (cards.length > prevCount.current && prevCount.current > 0) {
      const newest = cards[cards.length - 1]
      const p = newest.pinned ? { x: newest.canvas_x, y: newest.canvas_y } : auto.get(newest.id)
      if (p) {
        setTimeout(
          () => setCenter(p.x + widthForDepth(newest.depth) / 2, p.y + 120, { zoom: 0.9, duration: 420 }),
          80,
        )
      }
    }
    if (!didInitialFit.current && cards.length) {
      didInitialFit.current = true
      setTimeout(() => fitView({ padding: 0.22, maxZoom: 1, duration: 300 }), 60)
    }
    prevCount.current = cards.length
  }, [cards, auto, setCenter, fitView])

  return (
    <div className={cn('relative h-full w-full', className)}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodesChange={onNodesChange}
        onConnect={onConnect}
        minZoom={0.25}
        maxZoom={1.6}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable
        elementsSelectable
        panOnScroll
        selectionOnDrag={false}
        panOnDrag={[0, 1, 2]}
        zoomOnDoubleClick={false}
        defaultEdgeOptions={{ type: 'smoothstep' }}
        // 卡片内是完整的 Markdown + 代码高亮，渲染成本不低。
        // 数量上来后只画视口内的（PLAN §7 风险 #11）。
        onlyRenderVisibleElements={cards.length > 20}
        // 拖动时不做实时对齐计算，省一层每帧开销
        snapToGrid={false}
        nodeDragThreshold={1}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1}
          color="var(--border)"
          style={{ opacity: 0.6 }}
        />
        <Controls
          showInteractive={false}
          position="bottom-right"
          className="!shadow-[var(--shadow-float)] !border !border-[var(--border)] !rounded-[var(--radius)] overflow-hidden"
        />
      </ReactFlow>

      <div className="absolute bottom-3 left-3 z-10 flex gap-1.5">
        <ManualAskToolbarButton />
        {cards.length > 1 && (
          <Button size="xs" variant="subtle" onClick={() => fitView({ padding: 0.2, duration: 300 })}>
            全览
          </Button>
        )}
      </div>
    </div>
  )
}

export function CardSpace({ className }: { className?: string }) {
  const count = useCardSpace((s) => s.cards.length)

  // 空状态不是"没内容"，而是**教学时机**。
  // 划词是个不可见的交互，光靠一句文案说不清楚，所以直接演一遍。
  if (!count) {
    return (
      <div
        className={cn(
          'h-full flex flex-col items-center justify-center gap-7 px-6 py-8 overflow-y-auto',
          className,
        )}
      >
        <div className="text-center">
          <div className="text-[14px] font-medium">这里是你的卡片空间</div>
          <p className="text-[12.5px] text-[var(--text-muted)] mt-1.5 leading-relaxed max-w-[280px]">
            读到不懂的地方，<b className="text-[var(--text)]">用鼠标选中那个词</b>
            ，就能就地提问。
          </p>
        </div>

        <SelectionDemo />

        <ManualAskInline />

        <ol className="space-y-2 text-[12px] text-[var(--text-muted)] max-w-[280px]">
          {[
            ['在左边正文里', '按住鼠标左键拖过一个词，松开'],
            ['点浮出的按钮', '「就这里提问」，也可以自己写问题'],
            ['在回答里继续选词', '会生成子卡，一层层追问下去'],
          ].map(([t, d], i) => (
            <li key={t} className="flex gap-2.5">
              <span className="shrink-0 mt-[1px] size-[17px] flex items-center justify-center rounded-full bg-[var(--bg-active)] text-[10.5px] font-semibold tabular-nums">
                {i + 1}
              </span>
              <span className="leading-relaxed">
                <b className="text-[var(--text)] font-medium">{t}</b>
                <span className="opacity-80"> —— {d}</span>
              </span>
            </li>
          ))}
        </ol>

        <p className="text-[11.5px] text-[var(--text-subtle)] text-center leading-relaxed max-w-[280px]">
          卡片会浮在这一侧，原文不会被挡住。
        </p>
      </div>
    )
  }

  return (
    <ReactFlowProvider>
      <Canvas className={className} />
    </ReactFlowProvider>
  )
}
