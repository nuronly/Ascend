import { describe, expect, it } from 'vitest'
import { DARK, LIGHT, makeStylesheet, type GraphPalette } from './graphTheme'
import { DARK_PALETTE, LIGHT_PALETTE } from './neural'

/**
 * 配色的可见性约束。
 *
 * 这里两条断言各自对应一次真实事故：
 *   1. node 的 background-color 写成 var(--graph-node) —— cytoscape 走 Canvas，
 *      解析不了 CSS 变量，节点被画成默认色，在深底上几乎隐形
 *   2. 空白节点用半透明深色填充，叠加后与背景只差 5% 亮度，
 *      一门新课（覆盖率 0%）整张图集体消失，看起来像加载失败
 *
 * 颜色好不好看是主观的，但"看不看得见"是可以算的。
 */

/** WCAG 相对亮度。只处理 #rrggbb，其余返回 null 由调用方跳过 */
function luminance(color: string): number | null {
  const m = /^#([0-9a-f]{6})$/i.exec(color.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  const chan = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * chan[0] + 0.7152 * chan[1] + 0.0722 * chan[2]
}

function contrast(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  if (la === null || lb === null) return Number.POSITIVE_INFINITY // 半透明色跳过
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

describe('图谱配色', () => {
  it.each([
    ['浅色', LIGHT],
    ['深色', DARK],
  ])('%s 主题里不能出现 CSS 变量（cytoscape 是 Canvas，解析不了 var()）', (_n, pal) => {
    expect(JSON.stringify(makeStylesheet(pal as GraphPalette))).not.toMatch(/var\(--/)
  })

  it.each([
    ['浅色', LIGHT],
    ['深色', DARK],
  ])('%s 主题：空白节点必须靠描边看得见', (_n, p) => {
    const pal = p as GraphPalette
    // 空白节点是空心的，填充接近背景是刻意的 —— 所以可见性全靠描边
    expect(contrast(pal.blank.stroke, pal.bg)).toBeGreaterThan(1.5)
  })

  it.each([
    ['浅色', LIGHT],
    ['深色', DARK],
  ])('%s 主题：三档学习状态两两可分', (_n, p) => {
    const pal = p as GraphPalette
    // 提过问题 / 有己见 是两种不同状态，颜色必须拉开
    expect(pal.covered.fill).not.toBe(pal.owned.fill)
    expect(contrast(pal.covered.fill, pal.bg)).toBeGreaterThan(1.15)
    expect(contrast(pal.owned.fill, pal.bg)).toBeGreaterThan(1.15)
  })

  it.each([
    ['浅色', LIGHT],
    ['深色', DARK],
  ])('%s 主题：文字在画布上读得清', (_n, p) => {
    const pal = p as GraphPalette
    expect(contrast(pal.text, pal.bg)).toBeGreaterThan(4.5) // WCAG AA
    // 空白节点的标签也是正文级信息，不能因为"这块还没学"就淡到读不出概念名
    expect(contrast(pal.blank.text ?? pal.text, pal.bg)).toBeGreaterThan(4.5)
  })
})

describe('记忆网络配色', () => {
  it('浅底不能发光：白底上 shadowBlur 只会糊成一团灰', () => {
    expect(LIGHT_PALETTE.glow).toBe(0)
    expect(DARK_PALETTE.glow).toBeGreaterThan(0)
  })

  it('激活色的方向必须跟着底色反过来', () => {
    // 深底靠提亮，浅底靠压深。搞反了，节点一激活就消失在背景里
    expect(luminance(DARK_PALETTE.actVector)!).toBeGreaterThan(luminance(DARK_PALETTE.node)!)
    expect(luminance(LIGHT_PALETTE.actVector)!).toBeLessThan(luminance(LIGHT_PALETTE.node)!)
  })

  it('孤岛卡要淡到接近背景，但不能真的消失', () => {
    for (const p of [LIGHT_PALETTE, DARK_PALETTE]) {
      const c = contrast(p.nodeIsolated, p.bg)
      expect(c).toBeGreaterThan(1.05) // 还看得见
      expect(c).toBeLessThan(3) // 但明显比正常节点弱 —— 看得见的遗忘
    }
  })

  it('己见 / 待复习 / 原生三类神经元颜色互不相同', () => {
    for (const p of [LIGHT_PALETTE, DARK_PALETTE]) {
      const set = new Set([p.node, p.nodeRewritten, p.nodeDue])
      expect(set.size).toBe(3)
    }
  })
})
