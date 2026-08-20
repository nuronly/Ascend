import { describe, expect, it } from 'vitest'
import {
  continueList,
  isHeading,
  joinBlocks,
  splitBlocks,
  togglePrefix,
  toggleWrap,
} from './mdBlocks'

/**
 * 笔记编辑器的分块。
 *
 * 它替代了「整篇 Markdown 丢进 textarea」那种反人类的编辑方式：读的时候整篇是
 * 渲染好的，点中哪一段才把那一段变成小编辑框。所以这里最要紧的是两条：
 *
 *   1. **切分不能破坏语义**：代码块里的空行、列表的成组、公式所在段落，
 *      切错一处用户改完就是坏 Markdown。
 *   2. **split → join 必须是幂等的**：用户只改了一块，其余块拼回去必须和原文
 *      一致，否则每编辑一次全文都会被悄悄改写一遍。
 */

const DOC = `## 核心机制

- 固定窗口单层只能让距离不超过 $k$ 的元素产生依赖
- 循环网络必须经过 $|t-s|$ 次状态转移

普通段落，带行内公式 $O(n^2)$。

\`\`\`python
def f():
    # 代码块里的空行不该切开

    return 1
\`\`\`

## 我的理解`

describe('splitBlocks', () => {
  it('标题、列表、段落、代码块各自成块', () => {
    const b = splitBlocks(DOC)
    expect(b[0]).toBe('## 核心机制')
    expect(b[1].split('\n')).toHaveLength(2) // 两个列表项算一块
    expect(b[2]).toContain('普通段落')
    expect(b[3].startsWith('```python')).toBe(true)
    expect(b[4]).toBe('## 我的理解')
    expect(b).toHaveLength(5)
  })

  it('代码块内部的空行不切开 —— 切了就是坏代码', () => {
    const code = splitBlocks(DOC).find((x) => x.startsWith('```'))!
    expect(code).toContain('return 1')
    expect(code.trimEnd().endsWith('```')).toBe(true)
  })

  it('连续列表项算一块：调整列表不该点五次', () => {
    const b = splitBlocks('- a\n- b\n- c')
    expect(b).toHaveLength(1)
  })

  it('松散列表（项之间有空行）仍是同一块', () => {
    const b = splitBlocks('- a\n\n- b')
    expect(b).toHaveLength(1)
    expect(b[0]).toContain('- b')
  })

  it('列表项的缩进续行跟着列表走', () => {
    const b = splitBlocks('- 第一项\n  续行内容\n- 第二项')
    expect(b).toHaveLength(1)
  })

  it('列表换成引用要断开', () => {
    const b = splitBlocks('- a\n> 引用')
    expect(b).toHaveLength(2)
  })

  it('表格整块不散', () => {
    const b = splitBlocks('| a | b |\n| --- | --- |\n| 1 | 2 |')
    expect(b).toHaveLength(1)
  })

  it('空输入与纯空白不产生空块', () => {
    expect(splitBlocks('')).toEqual([])
    expect(splitBlocks('\n\n   \n')).toEqual([])
  })

  it('只有标题的留白节仍然是一块 —— 那正是留给用户写的位置', () => {
    const b = splitBlocks('## 我的理解\n\n## 我还没搞懂的')
    expect(b).toEqual(['## 我的理解', '## 我还没搞懂的'])
    expect(isHeading(b[0])).toBe(true)
  })
})

describe('joinBlocks', () => {
  it('split → join 幂等：只改一块不该悄悄重写全文', () => {
    const once = joinBlocks(splitBlocks(DOC))
    expect(joinBlocks(splitBlocks(once))).toBe(once)
  })

  it('内容一字不丢', () => {
    const out = joinBlocks(splitBlocks(DOC))
    for (const key of ['核心机制', '$|t-s|$', '$O(n^2)$', 'def f():', '我的理解']) {
      expect(out).toContain(key)
    }
  })

  it('空块被丢掉，不留下连串空行', () => {
    expect(joinBlocks(['a', '', '   ', 'b'])).toBe('a\n\nb')
  })
})

describe('toggleWrap', () => {
  it('给选区加粗', () => {
    const r = toggleWrap('abc', 0, 3, '**')
    expect(r.text).toBe('**abc**')
    expect([r.start, r.end]).toEqual([2, 5]) // 选区仍框住原文
  })

  it('再点一次取消（选区含标记）', () => {
    expect(toggleWrap('**abc**', 0, 7, '**').text).toBe('abc')
  })

  it('光标在标记内部时也能取消', () => {
    expect(toggleWrap('**abc**', 2, 5, '**').text).toBe('abc')
  })

  it('空选区插入一对标记，光标落中间', () => {
    const r = toggleWrap('ab', 1, 1, '`')
    expect(r.text).toBe('a``b')
    expect(r.start).toBe(2)
  })
})

describe('togglePrefix', () => {
  it('把当前行变成二级标题', () => {
    expect(togglePrefix('文字', 1, '## ').text).toBe('## 文字')
  })

  it('同级再点一次去掉', () => {
    expect(togglePrefix('## 文字', 4, '## ').text).toBe('文字')
  })

  it('换级不叠加 —— 不能出现 #####', () => {
    expect(togglePrefix('## 文字', 4, '### ').text).toBe('### 文字')
  })

  it('段落变列表项', () => {
    expect(togglePrefix('文字', 0, '- ').text).toBe('- 文字')
  })

  it('多行时只动光标所在那一行', () => {
    const r = togglePrefix('第一行\n第二行', 5, '- ')
    expect(r.text).toBe('第一行\n- 第二行')
  })
})

/** 光标默认在行尾 —— 硬编码数字容易把中文字符数算错 */
const atEnd = (s: string) => continueList(s, s.length)

describe('continueList', () => {
  it('回车自动接着写列表', () => {
    const r = atEnd('- 第一项')!
    expect(r.text).toBe('- 第一项\n- ')
    expect(r.caret).toBe(r.text.length)
  })

  it('有序列表自动递号', () => {
    expect(atEnd('2. 第二项')!.text).toBe('2. 第二项\n3. ')
  })

  it('空的列表项上回车 = 退出列表', () => {
    const r = atEnd('- ')!
    expect(r.text).toBe('')
    expect(r.caret).toBe(0)
  })

  it('普通段落不插项目符号', () => {
    expect(atEnd('普通文字')).toBeNull()
  })

  it('缩进列表保持缩进', () => {
    expect(atEnd('  - 子项')!.text).toBe('  - 子项\n  - ')
  })

  it('光标在行中间时只把后半截带到下一项', () => {
    // 这是真实行为：在「第一」后面回车，剩下的「项」跟着新项走
    const r = continueList('- 第一项', 4)!
    expect(r.text).toBe('- 第一\n- 项')
  })
})
