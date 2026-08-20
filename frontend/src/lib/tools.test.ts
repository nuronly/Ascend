import { describe, expect, it } from 'vitest'
import { TOOL_ACTION, settleStep, toolStep, type ToolStep } from './tools'

/**
 * 工具调用的呈现层。
 *
 * 这一层看着不起眼，但它承担的是**可解释性**：用户凭这几行判断「这次讲解是
 * 基于我自己的记录，还是又一份通用教程」。三种坏法都不会报错，只会静默变废：
 *
 *   1. 显示成函数名（`read_note`）—— 等于没说
 *   2. 动作名写死（曾经写死成「联网检索」，把「读我的笔记」也标成联网）
 *   3. 把 id 当查询词摆出来 —— 一串 uuid 对用户毫无意义
 */

describe('工具标签', () => {
  it('说人话，不显示函数名', () => {
    expect(toolStep('read_note', 'abc123').label).toBe('读我那一节的笔记全文')
    expect(toolStep('my_boundary').label).toBe('看我的已知边界')
  })

  it('四件记忆工具与联网都有人话名字', () => {
    for (const name of [
      'web_search',
      'search_memory',
      'read_note',
      'read_outline',
      'my_boundary',
    ]) {
      expect(TOOL_ACTION[name], name).toBeTruthy()
    }
  })

  it('没见过的工具退回工具名而不是空白', () => {
    expect(toolStep('brand_new_tool').label).toBe('brand_new_tool')
  })

  it('检索词摆出来 —— 那是用户唯一能核对的东西', () => {
    expect(toolStep('search_memory', '缩放点积').query).toBe('缩放点积')
    expect(toolStep('web_search', 'GPT-4 参数量').query).toBe('GPT-4 参数量')
  })

  it('id 类参数不摆出来', () => {
    // 后端 _call_detail 拿不到 query 时会退回工具名，直接显示就成了
    // 「读我那一节的笔记全文 · read_note」
    expect(toolStep('read_note', 'read_note').query).toBe('')
    expect(toolStep('read_note', '8f3a91c0e2').query).toBe('')
    expect(toolStep('read_outline', 'co_123').query).toBe('')
  })

  it('起手一定是 running', () => {
    expect(toolStep('search_memory', 'x').state).toBe('running')
  })
})

describe('结果回填', () => {
  const running = (name: string): ToolStep => toolStep(name, 'q')

  it('回填到最后一条 —— 工具是串行执行的，不会错位', () => {
    const steps = [running('web_search'), running('read_note')]
    const out = settleStep(steps, true, { detail: '读了《1.2 缩放点积》' })
    expect(out[0].state).toBe('running')
    expect(out[1].state).toBe('done')
    expect(out[1].detail).toBe('读了《1.2 缩放点积》')
  })

  it('失败标成 error，不是静默变 done', () => {
    const out = settleStep([running('read_note')], false, { detail: '这一节还没有笔记' })
    expect(out[0].state).toBe('error')
    // 失败原因要留着：工具失败不该假装成功
    expect(out[0].detail).toBe('这一节还没有笔记')
  })

  it('空列表不炸', () => {
    expect(settleStep([], true, { detail: 'x' })).toEqual([])
  })

  it('不改动原数组（React state 必须换新引用才会重渲染）', () => {
    const steps = [running('read_note')]
    const out = settleStep(steps, true)
    expect(steps[0].state).toBe('running')
    expect(out).not.toBe(steps)
  })

  it('记忆工具没有 items 时给空数组，不是 undefined', () => {
    // RunTimeline 里 `!!t.items?.length` 两种都活，但 undefined 会让
    // 「上一次的资料列表」在类型上看起来还可能残留
    expect(settleStep([running('read_note')], true, { detail: 'ok' })[0].items).toEqual([])
  })
})
