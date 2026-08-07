import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 划词选区信息。
 *
 * text_anchor 刻意用「引文 + 前后文」而不是字符偏移来定位：
 * 小节正文可以被用户重新生成（讲浅一点／换个例子），
 * 一旦重生成，任何基于偏移的锚点全部失效，卡片就跟原文断联了。
 * 而引文 + 上下文在重写后往往仍能匹配上，匹配不上也能优雅降级。
 * 这是 W3C Web Annotation 的 TextQuoteSelector 思路。
 */
export interface SelectionInfo {
  text: string
  /** 在容器 textContent 中的偏移，用于同一次渲染内的即时高亮 */
  start: number
  end: number
  prefix: string
  suffix: string
  /** 选区末端的视口坐标，用于摆放浮动按钮 */
  x: number
  y: number
  /** 选区所在的完整句子，作为卡片头部的「引：」 */
  sentence: string
}

const CTX = 40

/**
 * 把 Range 的某个边界换算成容器纯文本里的偏移。
 *
 * ⚠️ 必须用 Range 而不是 TreeWalker 逐个比对 text node：
 * 双击选词、三击选段、从段落边缘起拖时，`range.startContainer`
 * 往往是**元素节点**而非文本节点（此时 offset 是子节点索引）。
 * 用 TreeWalker 找不到它，会直接判定失败 —— 表现就是「选中了没反应」。
 */
function offsetIn(container: HTMLElement, node: Node, nodeOffset: number): number {
  try {
    const probe = document.createRange()
    probe.selectNodeContents(container)
    probe.setEnd(node, nodeOffset)
    return probe.toString().length
  } catch {
    return -1
  }
}

function sentenceAt(full: string, start: number, end: number): string {
  const seps = /[。！？.!?\n；;]/
  let a = start
  while (a > 0 && !seps.test(full[a - 1])) a--
  let b = end
  while (b < full.length && !seps.test(full[b])) b++
  let s = full.slice(a, Math.min(b + 1, full.length)).trim()
  if (s.length > 300) {
    const c = Math.floor((start + end) / 2) - a
    s = '…' + s.slice(Math.max(0, c - 140), c + 140).trim() + '…'
  }
  return s
}

/** 节点或其祖先是否落在容器内（文本节点没有 contains，需要用 parentNode 兜） */
function inside(container: HTMLElement, node: Node | null): boolean {
  if (!node) return false
  return container.contains(node.nodeType === Node.TEXT_NODE ? node.parentNode : node)
}

/** 焦点在输入控件里 —— 此时的键鼠操作属于「打字」，与划词无关 */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return false
  const tag = el.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA') return true
  // 不能只看 isContentEditable：事件 target 可能是可编辑区里的子元素
  // （<div contenteditable><b>字</b></div> 点在 b 上），
  // 且 jsdom 根本不实现这个属性。closest 两头都兜住。
  return (
    el.isContentEditable === true ||
    el.closest?.('[contenteditable=""], [contenteditable="true"]') !== null
  )
}

/** 会移动或扩展选区的按键。字母、数字、Enter 等一律与选词无关 */
const CARET_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

/**
 * 这次 keyup 是否真的是「用键盘在选词」。
 *
 * ★ 曾经这里只判断 e.shiftKey，结果把提问框里的打字全部误伤：
 *   在输入框按 Shift+字母（打大写）或 Shift+Enter（换行）时，
 *   松开字母那一刻 Shift 还按着 → shiftKey 仍为 true → 触发重算选区
 *   → 而此时焦点在 textarea 里、正文选区早已不存在
 *   → readSelection 返回 null → 提问框直接消失，已输入的内容全丢。
 *   现象很迷惑：松开 Shift 本身没事，松开另一个键才炸。
 */
export function isKeyboardSelecting(e: KeyboardEvent): boolean {
  if (isEditable(e.target)) return false
  if ((e.target as HTMLElement | null)?.closest?.('[data-selection-ui]')) return false
  if (e.shiftKey && CARET_KEYS.has(e.key)) return true
  // 全选也会产生选区
  return (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a'
}

export function readSelection(container: HTMLElement | null): SelectionInfo | null {
  if (!container) return null
  const sel = window.getSelection()
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null

  const range = sel.getRangeAt(0)

  // 起点必须在本容器内。刻意不要求终点也在 —— 用户经常会一路拖到
  // 容器外面才松手，那种情况下截取容器内的部分即可，不该整个作废。
  if (!inside(container, range.startContainer)) return null

  const raw = sel.toString()
  const text = raw.trim()
  if (text.length < 1 || text.length > 500) return null

  const full = container.textContent ?? ''
  let start = offsetIn(container, range.startContainer, range.startOffset)
  if (start < 0) return null

  // 选中内容常带首尾空白，trim 后要把偏移对齐回实际文字
  const lead = raw.length - raw.trimStart().length
  start += lead
  const end = start + text.length

  // 坐标只用于摆放浮动按钮。算不出来时退化到屏幕中央，
  // 也绝不能因此让整个划词功能失效 —— 位置差一点总好过完全没反应。
  let x = 0
  let y = 0
  try {
    const rects = range.getClientRects?.()
    const last =
      rects && rects.length ? rects[rects.length - 1] : range.getBoundingClientRect?.()
    if (last) {
      x = last.right
      y = last.bottom
    }
  } catch {
    /* 极端情况下拿不到布局信息，用兜底坐标 */
  }
  if (!x && !y) {
    x = window.innerWidth / 2
    y = window.innerHeight / 2
  }

  return {
    text,
    start,
    end,
    prefix: full.slice(Math.max(0, start - CTX), start),
    suffix: full.slice(end, end + CTX),
    x,
    y,
    sentence: sentenceAt(full, start, end),
  }
}

/**
 * 在容器里挂上划词能力。
 *
 * 三处都用同一个 hook（PLAN §3.2.0 的三种产生方式）：
 *   · 正文     → 根卡
 *   · AI 回答  → 子卡  ← 铁律 #1，不支持这个就退化成普通多轮对话
 *   · 己见     → 子卡
 */
export function useSelection(enabled = true) {
  const ref = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<SelectionInfo | null>(null)

  const clear = useCallback(() => {
    setSelection(null)
    window.getSelection()?.removeAllRanges()
  }, [])

  useEffect(() => {
    if (!enabled) return

    const read = () => {
      const el = ref.current
      if (!el) return
      setSelection(readSelection(el))
    }

    /**
     * ⚠️ 必须监听 **document** 而不是容器自身。
     * 拖选时鼠标经常滑出容器边界才松开（尤其是选一行的最后一个词，
     * 手会习惯性往右下带），此时容器根本收不到 mouseup，
     * 表现就是「明明选中了却毫无反应」。
     *
     * 页面上会有多个实例（正文 + 每张卡的回答/己见）同时监听，
     * 但 readSelection 会按容器过滤，只有命中的那个产出选区。
     */
    const onPointerUp = (e: Event) => {
      const t = e.target as HTMLElement | null
      // 点在浮动按钮上时不要重算，否则按钮一按下就自己消失了
      if (t?.closest?.('[data-selection-ui]')) return
      // 在输入框里拖选自己打的字，也不该被当成划词
      if (isEditable(e.target)) return
      // 等浏览器把选区最终确定下来（双击/三击尤其需要这一帧）
      setTimeout(read, 0)
    }

    const onKeyUp = (e: KeyboardEvent) => {
      if (isKeyboardSelecting(e)) setTimeout(read, 0)
    }

    document.addEventListener('mouseup', onPointerUp)
    document.addEventListener('touchend', onPointerUp)
    document.addEventListener('keyup', onKeyUp)

    return () => {
      document.removeEventListener('mouseup', onPointerUp)
      document.removeEventListener('touchend', onPointerUp)
      document.removeEventListener('keyup', onKeyUp)
    }
  }, [enabled])

  // 点击别处收起
  useEffect(() => {
    if (!selection) return
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null
      if (t?.closest?.('[data-selection-ui]')) return
      setSelection(null)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && clear()
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [selection, clear])

  return { ref, selection, clear }
}

/**
 * 回跳：在容器里找到锚点对应的位置。
 * 先用「前文 + 引文」精确匹配；失配则退化为只匹配引文的首次出现。
 */
export function findAnchor(
  container: HTMLElement,
  anchor: { exact?: string; prefix?: string },
): Range | null {
  const exact = anchor.exact
  if (!exact) return null
  const full = container.textContent ?? ''

  let at = -1
  if (anchor.prefix) {
    const combined = anchor.prefix + exact
    const i = full.indexOf(combined)
    if (i >= 0) at = i + anchor.prefix.length
  }
  if (at < 0) at = full.indexOf(exact)
  if (at < 0) return null

  // 把偏移换算回 DOM Range
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let acc = 0
  let startNode: Node | null = null
  let startOff = 0
  let endNode: Node | null = null
  let endOff = 0
  let cur: Node | null
  const target = at + exact.length

  while ((cur = walker.nextNode())) {
    const len = cur.textContent?.length ?? 0
    if (!startNode && acc + len > at) {
      startNode = cur
      startOff = at - acc
    }
    if (startNode && acc + len >= target) {
      endNode = cur
      endOff = target - acc
      break
    }
    acc += len
  }
  if (!startNode || !endNode) return null

  const range = document.createRange()
  try {
    range.setStart(startNode, startOff)
    range.setEnd(endNode, endOff)
    return range
  } catch {
    return null
  }
}
