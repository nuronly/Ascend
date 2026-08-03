import { create } from 'zustand'
import { api } from './api'
import type { Pomodoro, User } from './types'

/* ════════════════════════════════════════════════════════════
   鉴权
   ════════════════════════════════════════════════════════════ */
interface AuthState {
  user: User | null
  loading: boolean
  load: () => Promise<void>
  setUser: (u: User | null) => void
  logout: () => Promise<void>
}

export const useAuth = create<AuthState>((set) => ({
  user: null,
  loading: true,
  load: async () => {
    try {
      set({ user: await api.get<User>('/auth/me'), loading: false })
    } catch {
      set({ user: null, loading: false })
    }
  },
  setUser: (user) => set({ user, loading: false }),
  logout: async () => {
    await api.post('/auth/logout').catch(() => {})
    set({ user: null })
  },
}))

/* ════════════════════════════════════════════════════════════
   主题（PLAN §4.3.4：深色模式必做，且从第一天就用 CSS 变量）
   ════════════════════════════════════════════════════════════ */
type Theme = 'light' | 'dark' | 'system'

interface ThemeState {
  theme: Theme
  setTheme: (t: Theme) => void
}

function applyTheme(t: Theme) {
  const dark =
    t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}

export const useTheme = create<ThemeState>((set) => ({
  theme: (localStorage.getItem('ladder-theme') as Theme) || 'system',
  setTheme: (theme) => {
    localStorage.setItem('ladder-theme', theme)
    applyTheme(theme)
    set({ theme })
    api.patch('/auth/me/settings', { theme }).catch(() => {})
  },
}))

// 跟随系统主题变化
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  if (useTheme.getState().theme === 'system') applyTheme('system')
})

/* ════════════════════════════════════════════════════════════
   番茄钟（PLAN §3.3）

   ❗ 绝不累加 tick。浏览器后台标签页会把 setInterval 节流到
      1 次/分钟，累加式计时必然走不准。这里始终用
      「服务端 expected_end − 本地当前时间」算差值，
      并校正一次本地时钟与服务端的偏移。
   ════════════════════════════════════════════════════════════ */
interface PomodoroState {
  active: Pomodoro | null
  /** 本地时钟相对服务端的偏移（毫秒），用于跨设备一致 */
  clockSkew: number
  remaining: number
  finishedPrompt: boolean
  load: () => Promise<void>
  start: (sectionId?: string, minutes?: number) => Promise<void>
  finish: (abandoned?: boolean) => Promise<Pomodoro | null>
  extend: (minutes: number) => Promise<void>
  tick: () => void
  dismissPrompt: () => void
  clear: () => void
}

export const usePomodoro = create<PomodoroState>((set, get) => ({
  active: null,
  clockSkew: 0,
  remaining: 0,
  finishedPrompt: false,

  load: async () => {
    const p = await api.get<Pomodoro | null>('/pomodoros/active').catch(() => null)
    if (!p) {
      set({ active: null, remaining: 0 })
      return
    }
    const skew = new Date(p.server_now).getTime() - Date.now()
    set({
      active: p,
      clockSkew: skew,
      remaining: Math.max(0, (new Date(p.expected_end).getTime() - Date.now() - skew) / 1000),
      finishedPrompt: false,
    })
  },

  start: async (sectionId, minutes) => {
    const p = await api.post<Pomodoro>('/pomodoros', {
      section_id: sectionId ?? null,
      minutes: minutes ?? null,
    })
    const skew = new Date(p.server_now).getTime() - Date.now()
    set({
      active: p,
      clockSkew: skew,
      remaining: Math.max(0, (new Date(p.expected_end).getTime() - Date.now() - skew) / 1000),
      finishedPrompt: false,
    })
  },

  finish: async (abandoned = false) => {
    const a = get().active
    if (!a) return null
    const r = await api
      .post<{ pomodoro: Pomodoro; cards: any[] }>(
        `/pomodoros/${a.id}/finish?abandoned=${abandoned}`,
      )
      .catch(() => null)
    set({ active: null, remaining: 0, finishedPrompt: false })
    return r?.pomodoro ?? null
  },

  extend: async (minutes) => {
    const a = get().active
    if (!a) return
    const p = await api.post<Pomodoro>(`/pomodoros/${a.id}/extend?minutes=${minutes}`)
    const skew = new Date(p.server_now).getTime() - Date.now()
    set({
      active: p,
      clockSkew: skew,
      remaining: Math.max(0, (new Date(p.expected_end).getTime() - Date.now() - skew) / 1000),
      finishedPrompt: false,
    })
  },

  // 每帧只做「算差值」这一件事，绝不 remaining-- 累减
  tick: () => {
    const { active, clockSkew, finishedPrompt } = get()
    if (!active) return
    const left = Math.max(0, (new Date(active.expected_end).getTime() - Date.now() - clockSkew) / 1000)
    set({ remaining: left })
    if (left <= 0 && !finishedPrompt) set({ finishedPrompt: true })
  },

  dismissPrompt: () => set({ finishedPrompt: false }),
  clear: () => set({ active: null, remaining: 0, finishedPrompt: false }),
}))

/* ════════════════════════════════════════════════════════════
   轻量 toast
   ════════════════════════════════════════════════════════════ */
export interface Toast {
  id: number
  message: string
  kind: 'info' | 'ok' | 'error'
}

interface ToastState {
  toasts: Toast[]
  push: (message: string, kind?: Toast['kind']) => void
  remove: (id: number) => void
}

let toastId = 0

export const useToast = create<ToastState>((set) => ({
  toasts: [],
  push: (message, kind = 'info') => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), 4200)
  },
  remove: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}))

export const toast = {
  info: (m: string) => useToast.getState().push(m, 'info'),
  ok: (m: string) => useToast.getState().push(m, 'ok'),
  error: (m: string) => useToast.getState().push(m, 'error'),
}
