import { describe, expect, it } from 'vitest'
import {
  byConcept,
  isRight,
  nextUnanswered,
  streaks,
  tally,
  verdict,
  type QuizItem,
} from './quiz'

/**
 * 刷题的纯逻辑。这几件事都会**静默出错**：
 *
 *   · 判对错错了不会报错，只会让所有人答错，而且还会把假的「记住了」
 *     喂给间隔重复算法 —— 排程被污染，等发现时已经忘了一片
 *   · 连击断错了体感立刻不对，但没有任何报错
 *   · 知识点聚合错了，总结页会一本正经地胡说「你在 X 上薄弱」
 */

const item = (over: Partial<QuizItem> = {}): QuizItem => ({
  index: 0,
  kind: 'choice',
  q: '题干',
  options: ['甲', '乙'],
  concept: '缩放点积',
  why: '',
  ...over,
})

describe('选择题判对错', () => {
  it('下标相等才算对', () => {
    expect(isRight(item({ answer: 1 }), 1)).toBe(true)
    expect(isRight(item({ answer: 1 }), 0)).toBe(false)
  })

  it('★ 没有答案时一律算错，不能算对', () => {
    // 简答题、或者后端没下发答案。当成对的话会给 FSRS 喂一串假的「记住了」
    expect(isRight(item({ answer: undefined }), 0)).toBe(false)
    expect(isRight(item({ kind: 'short', answer: undefined }), 0)).toBe(false)
  })

  it('下标 0 是合法答案，不能被当成假值', () => {
    // `item.answer && ...` 这种写法会让第一个选项永远判错
    expect(isRight(item({ answer: 0 }), 0)).toBe(true)
  })
})

describe('计数', () => {
  it('只数已答的题', () => {
    const items = [
      item({ correct: true }),
      item({ correct: false }),
      item({}), // 还没答
      item({ correct: null }),
    ]
    expect(tally(items)).toEqual({ answered: 2, right: 1 })
  })

  it('一道没答就是全零', () => {
    expect(tally([item(), item()])).toEqual({ answered: 0, right: 0 })
  })
})

describe('连击', () => {
  it('连对累加，答错清零', () => {
    const items = [
      item({ correct: true }),
      item({ correct: true }),
      item({ correct: false }),
      item({ correct: true }),
    ]
    expect(streaks(items)).toEqual({ current: 1, best: 2 })
  })

  it('★ 中间没答的题不该把连击清零', () => {
    // 支持「跳过某题、最后回来补」，跳过不是答错
    const items = [item({ correct: true }), item({}), item({ correct: true })]
    expect(streaks(items)).toEqual({ current: 2, best: 2 })
  })

  it('全对时 current 等于 best', () => {
    const items = [item({ correct: true }), item({ correct: true })]
    expect(streaks(items)).toEqual({ current: 2, best: 2 })
  })

  it('最后一题答错时 current 归零但 best 留着', () => {
    const items = [item({ correct: true }), item({ correct: true }), item({ correct: false })]
    expect(streaks(items)).toEqual({ current: 0, best: 2 })
  })
})

describe('按知识点聚合', () => {
  it('★ 正确率低的排前面 —— 那才是该回去补的', () => {
    const items = [
      item({ concept: '多头', correct: true }),
      item({ concept: '多头', correct: true }),
      item({ concept: '缩放点积', correct: false }),
      item({ concept: '缩放点积', correct: true }),
      item({ concept: '位置编码', correct: false }),
    ]
    expect(byConcept(items).map((c) => c.concept)).toEqual(['位置编码', '缩放点积', '多头'])
  })

  it('同正确率时题多的排前面', () => {
    const items = [
      item({ concept: '甲', correct: false }),
      item({ concept: '乙', correct: false }),
      item({ concept: '乙', correct: false }),
    ]
    expect(byConcept(items)[0].concept).toBe('乙')
  })

  it('没有知识点的归到「其它」而不是空串', () => {
    expect(byConcept([item({ concept: '', correct: true })])[0].concept).toBe('其它')
    expect(byConcept([item({ concept: '   ', correct: true })])[0].concept).toBe('其它')
  })

  it('没答的题不进统计', () => {
    expect(byConcept([item({ concept: '甲' })])).toEqual([])
  })
})

describe('一句话评价', () => {
  it('全对与零分都有话说', () => {
    expect(verdict(5, 5)).toContain('全对')
    expect(verdict(0, 5)).toContain('还没沉下来')
  })

  it('没有题时不做除零', () => {
    expect(verdict(0, 0)).toBe('还没开始')
  })
})

describe('跳到下一道未答', () => {
  it('往后找', () => {
    const items = [item({ correct: true }), item({}), item({})]
    expect(nextUnanswered(items, 0)).toBe(1)
  })

  it('★ 后面答完了就绕回前面 —— 支持跳过某题最后回来补', () => {
    const items = [item({}), item({ correct: true }), item({ correct: true })]
    expect(nextUnanswered(items, 1)).toBe(0)
  })

  it('全答完返回 -1', () => {
    const items = [item({ correct: true }), item({ correct: false })]
    expect(nextUnanswered(items, 0)).toBe(-1)
  })
})
