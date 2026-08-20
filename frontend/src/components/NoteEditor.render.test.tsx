import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import NoteEditor from './NoteEditor'

/**
 * 笔记编辑器：点哪改哪。
 *
 * 它要解决的痛是「一点修改，整篇变成 ## 和 $O(n^2)$ 的源码」。所以这里断言的
 * 全是这件事的实现方式：读态是渲染好的、只有点中的那一段变成编辑框、
 * 改完立刻渲染回去、而且**别的块一个字都不能动**。
 */

const DOC = '## 核心机制\n\n缩放点积注意力。\n\n## 我的理解'

afterEach(cleanup)

function view(value = DOC) {
  const onChange = vi.fn()
  const r = render(<NoteEditor value={value} onChange={onChange} />)
  return { ...r, onChange }
}

describe('NoteEditor', () => {
  it('读态没有任何编辑框 —— 看笔记就该像看正文', () => {
    view()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.getByText('缩放点积注意力。')).toBeTruthy()
  })

  it('点中一段才变成编辑框，且只有那一段', () => {
    view()
    fireEvent.click(screen.getByText('缩放点积注意力。'))
    const boxes = screen.getAllByRole('textbox')
    expect(boxes).toHaveLength(1)
    expect((boxes[0] as HTMLTextAreaElement).value).toBe('缩放点积注意力。')
    // 别的段落仍是渲染态
    expect(screen.getByText('核心机制')).toBeTruthy()
  })

  it('改完 Esc 退出，只有那一块被替换，别的块原样', () => {
    const { onChange } = view()
    fireEvent.click(screen.getByText('缩放点积注意力。'))
    const ta = screen.getByRole('textbox')
    fireEvent.change(ta, { target: { value: '我改成自己的说法。' } })
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(onChange).toHaveBeenCalledWith('## 核心机制\n\n我改成自己的说法。\n\n## 我的理解')
  })

  it('工具条加粗作用在选区上，不必记 Markdown 语法', () => {
    view()
    fireEvent.click(screen.getByText('缩放点积注意力。'))
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    ta.setSelectionRange(0, 2)
    fireEvent.click(screen.getByTitle(/加粗/))
    expect(ta.value).toBe('**缩放**点积注意力。')
  })

  it('⌘B 快捷键等价于工具条', () => {
    view()
    fireEvent.click(screen.getByText('缩放点积注意力。'))
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    ta.setSelectionRange(0, 2)
    fireEvent.keyDown(ta, { key: 'b', metaKey: true })
    expect(ta.value).toBe('**缩放**点积注意力。')
  })

  it('回车自动接着写列表', () => {
    view('- 第一条')
    fireEvent.click(screen.getByText('第一条'))
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement
    ta.setSelectionRange(ta.value.length, ta.value.length)
    fireEvent.keyDown(ta, { key: 'Enter' })
    expect(ta.value).toBe('- 第一条\n- ')
  })

  it('清空一段就是删掉它', () => {
    const { onChange } = view()
    fireEvent.click(screen.getByText('缩放点积注意力。'))
    const ta = screen.getByRole('textbox')
    fireEvent.change(ta, { target: { value: '   ' } })
    fireEvent.keyDown(ta, { key: 'Escape' })
    expect(onChange).toHaveBeenCalledWith('## 核心机制\n\n## 我的理解')
  })

  it('末尾能继续写，追加成新的一段', () => {
    const { onChange } = view()
    fireEvent.click(screen.getByText('＋ 在这里继续写…'))
    const ta = screen.getByRole('textbox')
    fireEvent.change(ta, { target: { value: '补一句想法。' } })
    fireEvent.blur(ta)
    expect(onChange).toHaveBeenCalledWith(`${DOC}\n\n补一句想法。`)
  })

  it('留空的那一节明确邀请动手 —— 那是最值钱的位置', () => {
    view()
    expect(screen.getByText('点这里写下你自己的说法…')).toBeTruthy()
  })

  it('没改动就不回写，避免每次点开都把全文重排一遍', () => {
    const { onChange } = view()
    fireEvent.click(screen.getByText('缩放点积注意力。'))
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
    expect(onChange).not.toHaveBeenCalled()
  })
})
