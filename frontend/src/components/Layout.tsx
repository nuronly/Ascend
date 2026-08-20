import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { queryClient } from '@/lib/queryClient'
import { useAuth, useTheme } from '@/lib/store'
import { cn, initials } from '@/lib/utils'
import { GuideTour } from './GuideTour'
import { PomodoroPill, PomodoroReview } from './Pomodoro'
import { Tip } from './ui'
import type { GuideProgress } from '@/lib/guide'

const NAV = [
  {
    to: '/',
    label: '学习',
    icon: (
      <>
        <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h5A2.5 2.5 0 0 1 13 6.5v11a2 2 0 0 0-2-2H5.5A1.5 1.5 0 0 1 4 14V5.5Z" />
        <path d="M22 5.5A1.5 1.5 0 0 0 20.5 4h-5A2.5 2.5 0 0 0 13 6.5v11a2 2 0 0 1 2-2h5.5a1.5 1.5 0 0 0 1.5-1.5V5.5Z" />
      </>
    ),
  },
  {
    to: '/documents',
    label: '文档',
    icon: (
      <>
        <path d="M6 3h9l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
        <path d="M15 3v5h5" />
        <path d="M9 13h7M9 17h4" strokeLinecap="round" />
      </>
    ),
  },
  {
    // 「仓库」改成「笔记」：卡片整理进仓库没人回来看 —— 那是过程产物。
    // 主界面换成真正能读的笔记，卡片降级为它的素材层（见 pages/Vault.tsx）
    to: '/notes',
    label: '笔记',
    icon: (
      <>
        <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H15l4 4v12.5A1.5 1.5 0 0 1 17.5 21h-11A1.5 1.5 0 0 1 5 19.5v-15Z" />
        <path d="M14.5 3v4.5H19M8.5 12h7M8.5 16h4.5" strokeLinecap="round" />
      </>
    ),
  },
  // 「图谱」已撤：卡片不再是一张需要俯瞰的网，它绑定在小节与笔记上
  {
    to: '/brain',
    label: '第二大脑',
    icon: (
      <>
        <path d="M12 4.5a3.5 3.5 0 0 0-3.5 3.5v.2A3.3 3.3 0 0 0 6 11.4c0 1 .4 1.9 1.1 2.5A3.3 3.3 0 0 0 10 19.5h.5a2 2 0 0 0 1.5-.7V4.5Z" />
        <path d="M12 4.5A3.5 3.5 0 0 1 15.5 8v.2a3.3 3.3 0 0 1 2.5 3.2c0 1-.4 1.9-1.1 2.5A3.3 3.3 0 0 1 14 19.5h-.5a2 2 0 0 1-1.5-.7V4.5Z" />
      </>
    ),
  },
  {
    to: '/review',
    label: '复习',
    icon: (
      <>
        <path d="M20 12a8 8 0 1 1-2.6-5.9" />
        <path d="M20.5 4.5V9h-4.5" strokeLinecap="round" strokeLinejoin="round" />
      </>
    ),
    badgeKey: 'due' as const,
  },
  {
    to: '/badges',
    label: '勋章',
    icon: (
      <>
        <circle cx="12" cy="9" r="5.5" />
        <path d="m8.5 13.5-1.8 7 5.3-2.6 5.3 2.6-1.8-7" strokeLinejoin="round" />
      </>
    ),
  },
]

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="size-[18px] shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

export function Layout({ children }: { children: React.ReactNode }) {
  const { user, logout } = useAuth()
  const { theme, setTheme } = useTheme()
  const nav = useNavigate()
  const location = useLocation()
  const [guideOpen, setGuideOpen] = useState(false)

  // 引导进度（比赛演示功能，之后下线）
  const { data: guide } = useQuery({
    queryKey: ['guide-progress'],
    queryFn: () => api.get<GuideProgress>('/guide/progress'),
    staleTime: 15_000,
  })

  // 新注册账号首次登录时自动弹出（注册 30 分钟内）。
  // 游客不自动弹 —— 共享账号的状态会互相干扰，评委走右上角按钮手动开。
  useEffect(() => {
    if (!user || !guide || user.is_guest) return
    if (guide.started || guide.dismissed) return
    const fresh =
      user.created_at && Date.now() - new Date(user.created_at).getTime() < 30 * 60_000
    if (!fresh) return
    api
      .post('/guide/start')
      .then(() => queryClient.invalidateQueries({ queryKey: ['guide-progress'] }))
      .catch(() => {})
    setGuideOpen(true)
  }, [user, guide])

  // 复习到期数：每分钟刷一次就够，别打扰
  const { data: reviewStats } = useQuery({
    queryKey: ['review-stats'],
    queryFn: () => api.get<{ due: number }>('/review/stats'),
    refetchInterval: 60_000,
  })

  // 讲解页是「阅读区 + 卡片空间」双栏，必须撑满全宽，不能被侧栏挤
  const immersive = /\/sections\/[^/]+$/.test(location.pathname)

  return (
    <div className="h-full flex bg-[var(--bg)]">
      {/* ── 侧边栏：Notion 风，信息密度适中，hover 才出操作 ── */}
      <aside className="w-[52px] shrink-0 flex flex-col items-center py-3 gap-1 border-r border-[var(--border)] bg-[var(--bg-sunken)]">
        <button
          onClick={() => nav('/')}
          title="阶梯"
          className="size-8 mb-2 flex items-center justify-center rounded-[var(--radius)] hover:bg-[var(--bg-hover)] transition-colors"
        >
          {/* 阶梯：三级递进 */}
          <svg viewBox="0 0 24 24" className="size-[19px]" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
            <path d="M4 19h5v-5" />
            <path d="M9.5 14h5V9" />
            <path d="M15 9h5V4.5" />
          </svg>
        </button>

        {NAV.map((item) => {
          const badge = item.badgeKey === 'due' ? (reviewStats?.due ?? 0) : 0
          return (
            <Tip key={item.to} label={item.label}>
              <NavLink
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  cn(
                    'relative size-9 flex items-center justify-center rounded-[var(--radius)]',
                    'transition-colors',
                    isActive
                      ? 'bg-[var(--bg-active)] text-[var(--text)]'
                      : 'text-[var(--text-subtle)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)]',
                  )
                }
              >
                <Icon>{item.icon}</Icon>
                {badge > 0 && (
                  <span className="absolute top-1 right-1 min-w-[15px] h-[15px] px-1 flex items-center justify-center rounded-full bg-[var(--sem-due)] text-white text-[9.5px] font-semibold tabular-nums">
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
              </NavLink>
            </Tip>
          )
        })}

        <div className="grow" />

        <Tip label={theme === 'dark' ? '深色' : theme === 'light' ? '浅色' : '跟随系统'} side="top">
          <button
            onClick={() => setTheme(theme === 'dark' ? 'light' : theme === 'light' ? 'system' : 'dark')}
            className="size-9 flex items-center justify-center rounded-[var(--radius)] text-[var(--text-subtle)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] transition-colors"
          >
            <Icon>
              {theme === 'dark' ? (
                <path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
              ) : theme === 'light' ? (
                <>
                  <circle cx="12" cy="12" r="4" />
                  <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
                </>
              ) : (
                <>
                  <rect x="3" y="5" width="18" height="12" rx="2" />
                  <path d="M8 21h8" />
                </>
              )}
            </Icon>
          </button>
        </Tip>

        <div className="relative group/user">
          <button
            onClick={() => nav('/settings')}
            className="size-8 flex items-center justify-center rounded-full bg-[var(--bg-active)] text-[12px] font-semibold hover:ring-2 hover:ring-[var(--border-strong)] transition-all"
            title={user?.name}
          >
            {initials(user?.name ?? '')}
          </button>
          <button
            onClick={() => {
              logout().then(() => nav('/login'))
            }}
            title="退出登录"
            className="absolute -top-1 -right-1 size-4 rounded-full bg-[var(--bg-raised)] border border-[var(--border)] items-center justify-center text-[var(--text-subtle)] hover:text-[var(--sem-danger)] hidden group-hover/user:flex"
          >
            <svg viewBox="0 0 24 24" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
      </aside>

      {/* ── 主区 ── */}
      <main className={cn('grow min-w-0 flex flex-col', immersive ? 'overflow-hidden' : 'overflow-y-auto')}>
        {/* 游客横幅：常驻、不碍事，但要把「数据共享」说在前头 */}
        {user?.is_guest && (
          <div className="shrink-0 flex items-center justify-center gap-2 px-4 py-1.5 text-[12px] bg-[color-mix(in_oklch,var(--accent)_7%,transparent)] text-[var(--text-muted)] border-b border-[var(--border)]">
            <span>
              您处于<b className="text-[var(--text)]">游客模式</b>
              ，学习数据与其他人共享
            </span>
            <span className="opacity-40">·</span>
            <button
              onClick={() => {
                logout().then(() => nav('/login'))
              }}
              className="text-[var(--accent)] hover:underline underline-offset-2"
            >
              去登录
            </button>
          </div>
        )}
        {children}
      </main>

      {/* 右上角：引导 + 使用说明 + 番茄钟。
          沉浸页面（讲解页/文档页）不挂，那里工具栏自己有位置。 */}
      {!immersive && (
        <div className="fixed top-3 right-4 z-40 flex items-center gap-2">
          <PomodoroPill />
          {/* 新手引导入口：所有人可见（含游客），比赛演示用，之后下线 */}
          <button
            onClick={() => setGuideOpen((v) => !v)}
            className={cn(
              'flex items-center gap-1.5 h-7 px-2.5 rounded-full',
              'border transition-colors',
              guideOpen
                ? 'border-[var(--accent)] text-[var(--accent)] bg-[var(--accent-soft)]'
                : 'border-[var(--border)] bg-[var(--bg-raised)]/85 backdrop-blur-sm text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--border-strong)]',
            )}
          >
            <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
              <path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" />
            </svg>
            <span className="text-[12px]">新手引导</span>
            {guide && !guide.dismissed && guide.steps.some((s) => !s.done) && (
              <span className="size-1.5 rounded-full bg-[var(--accent)]" />
            )}
          </button>
          <NavLink
            to="/guide"
            className={cn(
              'flex items-center gap-1.5 h-7 px-2.5 rounded-full',
              'border border-[var(--border)] bg-[var(--bg-raised)]/85 backdrop-blur-sm',
              'text-[12px] text-[var(--text-muted)]',
              'hover:text-[var(--text)] hover:border-[var(--border-strong)] transition-colors',
            )}
          >
            <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="9.5" />
              <path d="M9.2 9.1a3 3 0 1 1 4.2 2.8c-.8.4-1.3 1.1-1.3 2v.3M12 17.4h.01" />
            </svg>
            使用说明
          </NavLink>
          <NavLink
            to="/feedback"
            state={{ from: location.pathname }}
            className={cn(
              'flex items-center gap-1.5 h-7 px-2.5 rounded-full',
              'border border-[var(--border)] bg-[var(--bg-raised)]/85 backdrop-blur-sm',
              'text-[12px] text-[var(--text-muted)]',
              'hover:text-[var(--text)] hover:border-[var(--border-strong)] transition-colors',
            )}
          >
            <svg viewBox="0 0 24 24" className="size-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 14.5a2 2 0 0 1-2 2H8l-4 3.5V5.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z" />
              <path d="M8.5 8.5h7M8.5 12h4.5" />
            </svg>
            意见反馈
          </NavLink>
        </div>
      )}

      {guideOpen && <GuideTour onClose={() => setGuideOpen(false)} />}

      <PomodoroReview />
    </div>
  )
}
