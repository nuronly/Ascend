import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import ReactMarkdown from 'react-markdown'
import { Markdown } from './Markdown'
import { stabilizeStreamingMarkdown } from '@/lib/streamingMarkdown'

/**
 * Markdown 渲染是本产品最脆弱的一环：
 * 内容全部由 LLM 生成，而且**流式到达因而永远是半截的**。
 *
 * 这组测试的由来是一个真实故障：曾经写了
 *   `p: onCitation ? Comp : undefined`
 * react-markdown 底层用 hasOwnProperty 查组件，key 存在就取值，
 * 于是每个 <p> 都变成 createElement(undefined)，整页白屏。
 * 后端 82 项测试全绿，却完全没覆盖到 —— 所以有了这个文件。
 */

/** 渲染并断言「没有炸成 ErrorBoundary 的兜底界面」。 */
function renderOk(md: string, props: Record<string, unknown> = {}) {
  const { container } = render(<Markdown {...props}>{md}</Markdown>)
  expect(screen.queryByText('这段内容渲染失败')).toBeNull()
  return container
}

describe('Markdown 渲染', () => {
  it('段落 —— 就是当初白屏的那个 case', () => {
    const c = renderOk('这是一段普通的正文。')
    expect(c.querySelector('p')?.textContent).toBe('这是一段普通的正文。')
  })

  it('标题 / 粗体 / 列表', () => {
    const c = renderOk('## 小标题\n\n**加粗**的概念\n\n- 甲\n- 乙')
    expect(c.querySelector('h2')?.textContent).toBe('小标题')
    expect(c.querySelector('strong')?.textContent).toBe('加粗')
    expect(c.querySelectorAll('li')).toHaveLength(2)
  })

  it('表格与引用', () => {
    const c = renderOk('> 引用\n\n| a | b |\n|---|---|\n| 1 | 2 |')
    expect(c.querySelector('blockquote')).toBeTruthy()
    expect(c.querySelectorAll('td')).toHaveLength(2)
  })

  it('完整公式', () => {
    const c = renderOk('行内 $E = mc^2$ 与独立公式：\n\n$$\\sum_{i=1}^{n} x_i$$')
    expect(c.querySelector('.katex')).toBeTruthy()
  })

  it('非法公式不崩（katex throwOnError 必须为 false）', () => {
    renderOk('$\\frac{1}{$ 和 $\\begin{aligned} x$')
  })

  it('代码块', () => {
    const c = renderOk('```python\nprint("hi")\n```')
    expect(c.querySelector('pre, .shiki-wrap')).toBeTruthy()
  })

  it('onCitation 模式下段落仍能渲染', () => {
    const c = renderOk('见 [^abc123] 这条。', { onCitation: () => {} })
    expect(c.querySelector('p')).toBeTruthy()
    expect(c.querySelector('button[title="跳到来源卡片"]')).toBeTruthy()
  })

  it('未开启 onCitation 时不渲染角标按钮', () => {
    const c = renderOk('见 [^abc123] 这条。')
    expect(c.querySelector('button[title="跳到来源卡片"]')).toBeNull()
  })

  it('★ XSS：script 与事件属性必须被剥掉', () => {
    const c = renderOk(
      '<script>window.__pwned = 1</script>\n\n<img src=x onerror="window.__pwned=1">\n\n' +
        '[点我](javascript:alert(1))',
    )
    expect(c.querySelector('script')).toBeNull()
    expect(c.innerHTML).not.toContain('onerror')
    expect(c.querySelector('a')?.getAttribute('href') ?? '').not.toContain('javascript:')
    expect((window as any).__pwned).toBeUndefined()
  })
})

describe('流式半截内容不崩', () => {
  // 逐字符喂入，模拟真实的 SSE 分片 —— 任何一帧都不能炸
  const full = [
    '## 缩放点积注意力',
    '',
    '设查询 $Q = xW_Q$，键 $K = xW_K$，则',
    '',
    '$$',
    '\\text{Attention}(Q,K,V) = \\operatorname{softmax}\\left(\\frac{QK^\\top}{\\sqrt{d_k}}\\right)V',
    '$$',
    '',
    '```python',
    'scores = Q @ K.T / math.sqrt(d_k)',
    '```',
    '',
    '其中 $d_k$ 是**键向量**的维度。',
  ].join('\n')

  const cuts = [1, 5, 12, 30, 48, 66, 90, 120, 160, 200, 240, full.length]
  for (const n of cuts) {
    it(`前 ${n} 个字符`, () => {
      renderOk(full.slice(0, n), { streaming: true })
    })
  }
})

describe('回归：白屏事故的成因', () => {
  it('react-markdown 用 hasOwnProperty 查组件，undefined 的 key 会炸整棵树', () => {
    // 这条不是在测我们的代码，而是把踩过的坑钉在这里：
    // 写 `p: cond ? Comp : undefined` 会让每个 <p> 变成 createElement(undefined)。
    // 正确写法是「不需要就不放这个 key」，见 Markdown.tsx 的 useMemo。
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(() =>
        render(<ReactMarkdown components={{ p: undefined }}>一段正文</ReactMarkdown>),
      ).toThrow(/Element type is invalid/)
    } finally {
      spy.mockRestore()
    }
  })

  it('我们的 Markdown 组件在两种模式下都不触发该问题', () => {
    renderOk('一段正文')
    renderOk('一段正文', { onCitation: () => {} })
  })
})

describe('stabilizeStreamingMarkdown', () => {
  it('补全未闭合的代码围栏', () => {
    expect(stabilizeStreamingMarkdown('```py\nx = 1')).toBe('```py\nx = 1\n```')
  })

  it('围栏成对时不动', () => {
    const s = '```py\nx = 1\n```'
    expect(stabilizeStreamingMarkdown(s)).toBe(s)
  })

  it('砍掉未闭合的块级公式', () => {
    expect(stabilizeStreamingMarkdown('前文\n\n$$\n\\frac{a}{b')).toBe('前文\n\n')
  })

  it('砍掉未闭合的行内公式', () => {
    expect(stabilizeStreamingMarkdown('设 $Q = xW')).toBe('设 ')
  })

  it('成对的行内公式保留', () => {
    expect(stabilizeStreamingMarkdown('设 $Q$ 为查询')).toBe('设 $Q$ 为查询')
  })

  it('代码块内的 $ 不参与配对', () => {
    const s = '```bash\necho $HOME\n```\n\n正文'
    expect(stabilizeStreamingMarkdown(s)).toBe(s)
  })

  it('转义的 \\$ 不参与配对', () => {
    const s = '价格是 \\$100 整'
    expect(stabilizeStreamingMarkdown(s)).toBe(s)
  })

  it('空串安全', () => {
    expect(stabilizeStreamingMarkdown('')).toBe('')
  })
})
