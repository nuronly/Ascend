/**
 * 把一篇 Markdown 切成「块」，供点哪改哪的编辑器用。
 *
 * ★ 为什么不用富文本编辑器
 *
 *   笔记的真源是 Markdown（正文、导出、检索全都是），换成 ProseMirror 系的
 *   所见即所得编辑器要付三笔账：多一套渲染路径（预览与编辑样式必然漂移）、
 *   Markdown 往返被规范化（`-` 变 `*`、公式包裹被改写）、KaTeX 得自己接成节点。
 *
 *   而「一点修改就要面对整篇源码」的痛，根源不是"没有富文本"，是**一次面对
 *   太多源码**。所以把粒度降到块：读的时候整篇都是渲染好的，点中哪一段才把
 *   那一段变成几行的小编辑框 —— 用户一次最多看见三五行源码，公式也只在自己
 *   正在改的那块里露出原形。顺带还免费得到了块级操作（删这条、在这条下面
 *   加一条），那本来是要单独做的功能。
 *
 * 切分规则（顺序即优先级）：
 *   1. 围栏代码块 ``` … ``` 整块不切，里面的空行不算分隔
 *   2. 标题行（#…）自己独立成块 —— 这样点标题只改标题
 *   3. 连续的列表项（-、*、+、1.）算**一块**，因为它们是一个语义单元；
 *      分开会让用户为了调整一个列表点五次
 *   4. 其余按空行分段
 */

const FENCE = /^\s*(```|~~~)/
const HEADING = /^\s{0,3}#{1,6}\s/
const LIST_ITEM = /^\s{0,3}([-*+]\s|\d+[.)]\s)/
/** 引用与表格行也各自成组，理由同列表 */
const QUOTE = /^\s{0,3}>/
const TABLE_ROW = /^\s{0,3}\|/

function kindOf(line: string): 'list' | 'quote' | 'table' | 'text' {
  if (LIST_ITEM.test(line)) return 'list'
  if (QUOTE.test(line)) return 'quote'
  if (TABLE_ROW.test(line)) return 'table'
  return 'text'
}

/** 把 Markdown 切成块。块内保留原始换行，块之间的空行不保留（join 时补回）。 */
export function splitBlocks(md: string): string[] {
  const lines = (md ?? '').replace(/\r\n?/g, '\n').split('\n')
  const blocks: string[] = []
  let buf: string[] = []
  /** 当前块的成组类型，null 表示普通段落 */
  let group: 'list' | 'quote' | 'table' | null = null

  const flush = () => {
    // 末尾空行不进块，但块内部的空行（如列表项之间）要留着
    while (buf.length && !buf[buf.length - 1].trim()) buf.pop()
    if (buf.length) blocks.push(buf.join('\n'))
    buf = []
    group = null
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    // ① 围栏代码块：从围栏到配对围栏整块吞下
    if (FENCE.test(line)) {
      flush()
      const fence = line.trim().slice(0, 3)
      const code = [line]
      i += 1
      while (i < lines.length) {
        code.push(lines[i])
        if (lines[i].trim().startsWith(fence)) {
          i += 1
          break
        }
        i += 1
      }
      blocks.push(code.join('\n'))
      continue
    }

    // ② 标题独立成块
    if (HEADING.test(line)) {
      flush()
      blocks.push(line)
      i += 1
      continue
    }

    // ③ 空行：结束当前块（列表内部的单个空行除外 —— 那还是同一个列表）
    if (!line.trim()) {
      const next = lines[i + 1] ?? ''
      if (group === 'list' && LIST_ITEM.test(next)) {
        buf.push(line) // 松散列表，空行属于列表内部
        i += 1
        continue
      }
      flush()
      i += 1
      continue
    }

    // ④ 成组行（列表/引用/表格）：同类连着走，换类就断开
    const k = kindOf(line)
    if (k !== 'text') {
      if (group && group !== k) flush()
      group = k
      buf.push(line)
      i += 1
      continue
    }

    // ⑤ 普通文本行。列表项的续行（缩进）仍属于列表
    if (group === 'list' && /^\s{2,}\S/.test(line)) {
      buf.push(line)
      i += 1
      continue
    }
    if (group) flush()
    buf.push(line)
    i += 1
  }
  flush()
  return blocks
}

/** 块拼回 Markdown。块之间统一空一行 —— 这是 Markdown 的规范形态。 */
export function joinBlocks(blocks: string[]): string {
  return blocks
    .map((b) => b.replace(/\s+$/, ''))
    .filter((b) => b.length > 0)
    .join('\n\n')
}

/** 这一块是不是「只有标题、下面还没写东西」—— 留白位置靠它高亮 */
export function isHeading(block: string): boolean {
  return HEADING.test(block.split('\n')[0] ?? '')
}

/**
 * 给一段选区套上 Markdown 标记（工具条与快捷键都走这里）。
 * 已经套过就取消，像 Cmd+B 那样来回切。
 */
export function toggleWrap(
  text: string,
  start: number,
  end: number,
  mark: string,
): { text: string; start: number; end: number } {
  const sel = text.slice(start, end)
  const before = text.slice(0, start)
  const after = text.slice(end)

  if (sel.startsWith(mark) && sel.endsWith(mark) && sel.length >= mark.length * 2) {
    const inner = sel.slice(mark.length, -mark.length)
    return { text: before + inner + after, start, end: start + inner.length }
  }
  // 选区外侧已经有标记（光标在标记内部时的常见情形）
  if (before.endsWith(mark) && after.startsWith(mark)) {
    return {
      text: before.slice(0, -mark.length) + sel + after.slice(mark.length),
      start: start - mark.length,
      end: end - mark.length,
    }
  }
  return {
    text: `${before}${mark}${sel}${mark}${after}`,
    start: start + mark.length,
    end: end + mark.length,
  }
}

/** 行首前缀（标题级别、列表、引用）。同前缀再点一次就去掉。 */
export function togglePrefix(
  text: string,
  caret: number,
  prefix: string,
): { text: string; caret: number } {
  const lineStart = text.lastIndexOf('\n', Math.max(0, caret - 1)) + 1
  const lineEnd = text.indexOf('\n', caret)
  const end = lineEnd === -1 ? text.length : lineEnd
  const line = text.slice(lineStart, end)

  // 先剥掉已有的同族前缀，避免 ### 叠成 ######
  const stripped = line.replace(/^\s{0,3}(#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s?)/, '')
  const next = line.startsWith(prefix) ? stripped : prefix + stripped
  return {
    text: text.slice(0, lineStart) + next + text.slice(end),
    caret: Math.max(lineStart, caret + (next.length - line.length)),
  }
}

/**
 * 回车时自动接着列表写。
 * 空的列表项上回车 = 退出列表（和所有编辑器的习惯一致）。
 */
export function continueList(
  text: string,
  caret: number,
): { text: string; caret: number } | null {
  const lineStart = text.lastIndexOf('\n', Math.max(0, caret - 1)) + 1
  const line = text.slice(lineStart, caret)
  const m = line.match(/^(\s{0,3})([-*+]|\d+[.)])\s+(.*)$/)
  if (!m) return null

  const [, indent, bullet, rest] = m
  if (!rest.trim()) {
    // 空项：把这一行清掉，退出列表
    const cleaned = text.slice(0, lineStart) + text.slice(caret)
    return { text: cleaned, caret: lineStart }
  }
  const nextBullet = /^\d/.test(bullet)
    ? `${parseInt(bullet, 10) + 1}${bullet.slice(-1)}`
    : bullet
  const insert = `\n${indent}${nextBullet} `
  return {
    text: text.slice(0, caret) + insert + text.slice(caret),
    caret: caret + insert.length,
  }
}
