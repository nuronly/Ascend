import { useQuery } from '@tanstack/react-query'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { useAuth, useTheme } from '@/lib/store'
import { cn, initials } from '@/lib/utils'
import { PomodoroPill, PomodoroReview } from './Pomodoro'
import { Tip } from './ui'

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
    to: '/vault',
    label: '仓库',
    icon: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2.5" />
        <path d="M3 9.5h18M9 9.5V20" />
      </>
    ),
  },
  {
    to: '/graph',
    label: '图谱',
    icon: (
      <>
        <circle cx="6" cy="7" r="2.6" />
        <circle cx="18" cy="6" r="2.4" />
        <circle cx="17" cy="18" r="2.6" />
        <circle cx="7" cy="17" r="2.2" />
        <path d="m8.4 8.2 7.3-1.4M17.4 8.3l-.3 7.2M15 18.3l-5.8-.9M6.6 14.9 6.2 9.6" />
      </>
    ),
  },
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
        {children}
      </main>

      {/* 番茄钟浮标：非沉浸页面时挂右上角（沉浸页面自己在工具栏里放） */}
      {!immersive && (
        <div className="fixed top-3 right-4 z-40">
          <PomodoroPill />
        </div>
      )}

      <PomodoroReview />
    </div>
  )
}
