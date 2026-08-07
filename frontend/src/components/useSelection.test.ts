import { describe, expect, it, beforeEach } from 'vitest'
import { findAnchor, isEditable, isKeyboardSelecting, readSelection } from './useSelection'

/**
 * 划词是本产品唯一的核心动作，却曾经完全失效 —— 用户反馈「选中好像没效果」。
 *
 * 两个原因，都是想当然导致的：
 *   1. offsetIn 用 TreeWalker 逐个比对 text node，遇到**元素节点**边界
 *      就返回 -1。而双击选词、三击选段、从段落边缘起拖时，
 *      range.startContainer 恰恰常常是元素节点。
 *   2. mouseup 绑在容器上。拖选时鼠标常常滑出容器才松开，事件根本收不到。
 *
 * 这组测试直接构造各种真实的 Range 形态，确保它们都能被正确读出。
 */

function mount(html: string): HTMLElement {
  document.body.innerHTML = ''
  const el = document.createElement('div')
  el.innerHTML = html
  document.body.appendChild(el)
  return el
}

/** 在容器里按纯文本偏移建立选区，模拟用户拖选 */
function selectRange(container: HTMLElement, from: number, to: number) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
  let acc = 0
  let s: { n: Node; o: number } | null = null
  let e: { n: Node; o: number } | null = null
  let cur: Node | null
  while ((cur = walker.nextNode())) {
    const len = cur.textContent?.length ?? 0
    if (!s && acc + len > from) s = { n: cur, o: from - acc }
    if (s && acc + len >= to) {
      e = { n: cur, o: to - acc }
      break
    }
    acc += len
  }
  const r = document.createRange()
  r.setStart(s!.n, s!.o)
  r.setEnd(e!.n, e!.o)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(r)
  return r
}

/** 用元素节点作为边界建立选区 —— 双击/三击时浏览器就是这么给的 */
function selectByElement(el: Element) {
  const r = document.createRange()
  r.selectNodeContents(el)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(r)
  return r
}

describe('readSelection', () => {
  beforeEach(() => {
    window.getSelection()?.removeAllRanges()
  })

  it('拖选普通文字', () => {
    const el = mount('<p>通过 softmax 归一化后得到权重分布。</p>')
    selectRange(el, 3, 10)
    const s = readSelection(el)
    expect(s?.text).toBe('softmax')
    expect(s?.start).toBe(3)
    expect(s?.end).toBe(10)
  })

  it('★ 元素节点边界（双击选词）—— 曾经在这里直接返回 null', () => {
    const el = mount('<p>通过 <strong>softmax</strong> 归一化。</p>')
    selectByElement(el.querySelector('strong')!)
    const s = readSelection(el)
    expect(s).not.toBeNull()
    expect(s!.text).toBe('softmax')
  })

  it('★ 三击选整段（startContainer 是 <p>）', () => {
    const el = mount('<p>第一段。</p><p>第二段内容。</p>')
    selectByElement(el.querySelectorAll('p')[1])
    const s = readSelection(el)
    expect(s?.text).toBe('第二段内容。')
    expect(s?.start).toBe(4)
  })

  it('跨行内元素拖选', () => {
    //         0把 1␣ 2查 3询 4␣ 5和 6␣ 7键 8␣ 9相 10乘
    const el = mount('<p>把 <em>查询</em> 和 <strong>键</strong> 相乘</p>')
    selectRange(el, 2, 8)
    const s = readSelection(el)
    expect(s?.text).toBe('查询 和 键')
    expect(s?.start).toBe(2)
  })

  it('带首尾空白时偏移要对齐到实际文字', () => {
    const el = mount('<p>通过 softmax 归一化</p>')
    selectRange(el, 2, 11) // " softmax " 前后各带一个空格
    const s = readSelection(el)
    expect(s?.text).toBe('softmax')
    expect(s?.start).toBe(3)
  })

  it('提取所在句子作为「引：」上下文', () => {
    const el = mount('<p>前一句话。通过 softmax 归一化后得到权重分布。后一句话。</p>')
    selectRange(el, 8, 15)
    const s = readSelection(el)
    expect(s?.text).toBe('softmax')
    expect(s?.sentence).toBe('通过 softmax 归一化后得到权重分布。')
  })

  it('记录前后文，供正文重新生成后重新定位', () => {
    const el = mount('<p>通过 softmax 归一化后得到权重分布。</p>')
    selectRange(el, 3, 10)
    const s = readSelection(el)
    expect(s?.prefix).toBe('通过 ')
    expect(s?.suffix).toContain('归一化')
  })

  it('未选中任何内容时返回 null', () => {
    const el = mount('<p>正文</p>')
    expect(readSelection(el)).toBeNull()
  })

  it('选区在别的容器里时返回 null（多个卡片同时监听 document）', () => {
    const a = mount('<p>容器 A 的文字</p>')
    const b = document.createElement('div')
    b.innerHTML = '<p>容器 B 的文字</p>'
    document.body.appendChild(b)
    selectRange(b, 0, 5)
    expect(readSelection(a)).toBeNull()
    expect(readSelection(b)).not.toBeNull()
  })

  it('纯空白选区不产生卡片', () => {
    const el = mount('<p>甲   乙</p>')
    selectRange(el, 1, 4)
    expect(readSelection(el)).toBeNull()
  })

  it('容器为 null 时安全', () => {
    expect(readSelection(null)).toBeNull()
  })
})

describe('findAnchor 回跳', () => {
  it('用前文 + 引文精确定位', () => {
    const el = mount('<p>先说 softmax，再说 softmax 的梯度。</p>')
    const r = findAnchor(el, { exact: 'softmax', prefix: '，再说 ' })
    expect(r).not.toBeNull()
    expect(r!.toString()).toBe('softmax')
    // 命中的应该是第二处，不是第一处
    expect(r!.startOffset).toBeGreaterThan(10)
  })

  it('前文失配时退化为首次出现', () => {
    const el = mount('<p>通过 softmax 归一化</p>')
    const r = findAnchor(el, { exact: 'softmax', prefix: '完全对不上的前文' })
    expect(r?.toString()).toBe('softmax')
  })

  it('跨元素的引文也能定位', () => {
    const el = mount('<p>把 <strong>查询向量</strong> 乘以键</p>')
    const r = findAnchor(el, { exact: '查询向量 乘以' })
    expect(r?.toString()).toBe('查询向量 乘以')
  })

  it('正文重写后引文消失 → 返回 null 而不是报错', () => {
    const el = mount('<p>完全不同的新正文</p>')
    expect(findAnchor(el, { exact: 'softmax', prefix: '通过 ' })).toBeNull()
  })
})

/**
 * 提问框里打字被误判成「键盘选词」，导致输入框凭空消失。
 *
 * 用户反馈：「按住 shift 同时按其他键，松开其他键会使输入框直接消失」。
 * 原因是 keyup 处理只判断了 e.shiftKey —— 在 textarea 里按 Shift+字母
 * 打大写、Shift+Enter 换行时，松开字母那一刻 Shift 仍按着，
 * 于是被当作选词动作去重算选区；而焦点在输入框里、正文选区早已不在，
 * readSelection 返回 null，提问框连同已输入的内容一起没了。
 */
describe('isKeyboardSelecting：哪些按键才算在选词', () => {
  const key = (init: Partial<KeyboardEventInit> & { key: string }, target?: HTMLElement) => {
    const e = new KeyboardEvent('keyup', { bubbles: true, ...init })
    Object.defineProperty(e, 'target', { value: target ?? document.body })
    return e
  }

  const editable = (tag: 'textarea' | 'input') => {
    document.body.innerHTML = ''
    const box = document.createElement('div')
    box.setAttribute('data-selection-ui', '')
    const el = document.createElement(tag)
    box.appendChild(el)
    document.body.appendChild(box)
    return el
  }

  it('★ 回归：在提问框里按 Shift+字母，不能被当成选词', () => {
    const ta = editable('textarea')
    // 松开 A 时 Shift 仍按着 —— 正是用户遇到的那一刻
    expect(isKeyboardSelecting(key({ key: 'A', shiftKey: true }, ta))).toBe(false)
  })

  it('★ 回归：在提问框里按 Shift+Enter 换行，不能被当成选词', () => {
    const ta = editable('textarea')
    expect(isKeyboardSelecting(key({ key: 'Enter', shiftKey: true }, ta))).toBe(false)
  })

  it('在输入框里按 Shift+方向键（选自己打的字）也不该触发', () => {
    const input = editable('input')
    expect(isKeyboardSelecting(key({ key: 'ArrowLeft', shiftKey: true }, input))).toBe(false)
  })

  it('正文里 Shift+方向键 —— 这才是键盘选词，必须保留', () => {
    document.body.innerHTML = '<p>正文</p>'
    const p = document.querySelector('p')!
    expect(isKeyboardSelecting(key({ key: 'ArrowRight', shiftKey: true }, p as HTMLElement))).toBe(true)
    expect(isKeyboardSelecting(key({ key: 'End', shiftKey: true }, p as HTMLElement))).toBe(true)
  })

  it('正文里 Ctrl/Cmd+A 全选也算', () => {
    document.body.innerHTML = '<p>正文</p>'
    const p = document.querySelector('p') as HTMLElement
    expect(isKeyboardSelecting(key({ key: 'a', metaKey: true }, p))).toBe(true)
  })

  it('正文里单按字母或单独松开 Shift，都不算选词', () => {
    document.body.innerHTML = '<p>正文</p>'
    const p = document.querySelector('p') as HTMLElement
    expect(isKeyboardSelecting(key({ key: 'A', shiftKey: true }, p))).toBe(false)
    expect(isKeyboardSelecting(key({ key: 'Shift', shiftKey: false }, p))).toBe(false)
  })
})

describe('isEditable', () => {
  it('认得出输入控件与 contenteditable', () => {
    document.body.innerHTML =
      '<textarea></textarea><input /><div contenteditable="true"></div><p>正文</p>'
    expect(isEditable(document.querySelector('textarea'))).toBe(true)
    expect(isEditable(document.querySelector('input'))).toBe(true)
    expect(isEditable(document.querySelector('[contenteditable]'))).toBe(true)
    expect(isEditable(document.querySelector('p'))).toBe(false)
    expect(isEditable(null)).toBe(false)
  })
})
