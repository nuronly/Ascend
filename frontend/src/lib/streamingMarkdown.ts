/**
 * 流式 Markdown 的「稳定化」。
 *
 * 流式输出时，任意一帧拿到的都是半截 Markdown。直接渲染会有两个问题：
 *
 *   1. 未闭合的 ``` 会让后面所有内容被当成代码块，屏幕突然全变灰
 *   2. 未闭合的 $$ / $ 会让 KaTeX 拿到残缺公式 —— 配了 throwOnError:false
 *      虽然不再崩，但会闪一片红色报错，比不显示更难看
 *
 * 处理办法：把还没闭合的那一小截**暂时藏起来**，等它闭合了自然出现。
 * 流式很快，用户几乎察觉不到，但画面稳定得多。
 */

/** 找出不在代码块内的区段 [start, end)，供公式统计使用。 */
function outsideCodeRanges(md: string): [number, number][] {
  const ranges: [number, number][] = []
  const fence = /^(?:```|~~~)/gm
  let cursor = 0
  let inside = false
  let m: RegExpExecArray | null

  while ((m = fence.exec(md))) {
    if (!inside) {
      ranges.push([cursor, m.index])
      inside = true
    } else {
      // 跳过围栏所在的整行
      const lineEnd = md.indexOf('\n', m.index)
      cursor = lineEnd === -1 ? md.length : lineEnd + 1
      inside = false
    }
  }
  if (!inside) ranges.push([cursor, md.length])
  return ranges
}

export function stabilizeStreamingMarkdown(md: string): string {
  if (!md) return md

  // ── 1. 未闭合的代码围栏：补一个收尾，让它正常显示为代码块 ──
  const fences = md.match(/^(?:```|~~~)/gm)
  let out = md
  if (fences && fences.length % 2 === 1) {
    out = out + (out.endsWith('\n') ? '' : '\n') + '```'
  }

  // ── 2. 未闭合的块级公式 $$：砍掉从它开始的残缺部分 ──
  const zones = outsideCodeRanges(out)
  const dollarBlocks: number[] = []
  for (const [a, b] of zones) {
    const seg = out.slice(a, b)
    const re = /\$\$/g
    let mm: RegExpExecArray | null
    while ((mm = re.exec(seg))) dollarBlocks.push(a + mm.index)
  }
  if (dollarBlocks.length % 2 === 1) {
    return out.slice(0, dollarBlocks[dollarBlocks.length - 1])
  }

  // ── 3. 未闭合的行内公式 $：同样砍掉 ──
  const zones2 = outsideCodeRanges(out)
  const singles: number[] = []
  for (const [a, b] of zones2) {
    const seg = out.slice(a, b)
    for (let i = 0; i < seg.length; i++) {
      if (seg[i] !== '$') continue
      if (seg[i - 1] === '\\') continue // 转义的 \$ 是普通美元符号
      if (seg[i + 1] === '$' || seg[i - 1] === '$') {
        // 属于 $$，上一步已确认成对，跳过这两个字符
        if (seg[i + 1] === '$') i++
        continue
      }
      singles.push(a + i)
    }
  }
  if (singles.length % 2 === 1) {
    return out.slice(0, singles[singles.length - 1])
  }

  return out
}
