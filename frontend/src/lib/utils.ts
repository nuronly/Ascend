import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const diff = (Date.now() - d.getTime()) / 1000
  if (diff < 60) return '刚刚'
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400 / 7)} 周前`
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric' })
}

export function futureTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const diff = (new Date(iso).getTime() - Date.now()) / 1000
  if (diff <= 0) return '现在'
  if (diff < 3600) return `${Math.ceil(diff / 60)} 分钟后`
  if (diff < 86400) return `${Math.ceil(diff / 3600)} 小时后`
  return `${Math.ceil(diff / 86400)} 天后`
}

export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined
  const wrapped = (...args: Parameters<T>) => {
    if (t) clearTimeout(t)
    t = setTimeout(() => fn(...args), ms)
  }
  wrapped.cancel = () => t && clearTimeout(t)
  return wrapped as T & { cancel: () => void }
}

/** 取选区所在的完整句子，作为卡片头部的「引：」上下文。 */
export function sentenceAround(text: string, start: number, end: number): string {
  const seps = /[。！？.!?\n]/
  let a = start
  while (a > 0 && !seps.test(text[a - 1])) a--
  let b = end
  while (b < text.length && !seps.test(text[b])) b++
  const s = text.slice(a, Math.min(b + 1, text.length)).trim()
  // 句子过长时以选中词为中心截断，别把整段塞进卡片
  if (s.length > 320) {
    const c = Math.floor((start + end) / 2 - a)
    return '…' + s.slice(Math.max(0, c - 150), c + 150).trim() + '…'
  }
  return s
}

/** 深度 → 卡片宽度：每深一层 ×0.92，设最小宽度（PLAN §4.3.3 卡片层级的视觉表达）。 */
export function widthForDepth(depth: number): number {
  return Math.max(272, Math.round(360 * Math.pow(0.92, Math.min(depth, 6))))
}

export function initials(name: string): string {
  return (name || '?').trim().slice(0, 1).toUpperCase()
}

export function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}
