import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth } from '@/lib/store'
import type { User } from '@/lib/types'
import { Button, Input } from '@/components/ui'
import { cn } from '@/lib/utils'

export default function LoginPage() {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
  const [invite, setInvite] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // 站点是否开放注册 / 要不要邀请码（上线后通常会关掉自由注册）
  const { data: cfg } = useQuery({
    queryKey: ['auth-config'],
    queryFn: () =>
      api.get<{ allow_registration: boolean; invite_required: boolean; guest_enabled?: boolean }>(
        '/auth/config',
      ),
    staleTime: Infinity,
    retry: false,
  })
  const canRegister = cfg?.allow_registration !== false

  const { user, setUser } = useAuth()
  const nav = useNavigate()
  const location = useLocation() as { state?: { from?: string } }

  useEffect(() => {
    if (user) nav(location.state?.from ?? '/', { replace: true })
  }, [user, nav, location.state])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const body =
        mode === 'login'
          ? { email, password }
          : {
              email,
              name: name.trim() || email.split('@')[0],
              password,
              invite_code: invite.trim(),
            }
      const u = await api.post<User>(`/auth/${mode}`, body)
      setUser(u)
      nav(location.state?.from ?? '/', { replace: true })
    } catch (err: any) {
      setError(err?.message ?? '出错了，请重试')
    } finally {
      setBusy(false)
    }
  }

  const enterAsGuest = async () => {
    setError('')
    setBusy(true)
    try {
      const u = await api.post<User>('/auth/guest')
      setUser(u)
      nav(location.state?.from ?? '/', { replace: true })
    } catch (err: any) {
      setError(err?.message ?? '游客入口暂不可用')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="h-full grid lg:grid-cols-[1.15fr_1fr]">
      {/* 左：产品主张。极简学术风，大量留白 */}
      <div className="hidden lg:flex flex-col justify-center px-16 xl:px-24 bg-[var(--bg-sunken)] border-r border-[var(--border)]">
        <div className="max-w-lg">
          <div className="flex items-center gap-2.5 mb-10">
            <svg viewBox="0 0 24 24" className="size-6" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
              <path d="M4 19h5v-5" />
              <path d="M9.5 14h5V9" />
              <path d="M15 9h5V4.5" />
            </svg>
            <span className="text-[15px] font-semibold tracking-[-0.01em]">阶梯</span>
          </div>

          <h1 className="text-[30px] leading-[1.28] font-semibold tracking-[-0.022em]">
            一个以<span className="text-[var(--accent)]">疑问</span>
            <br />
            为原子单位的学习工作台
          </h1>

          <p className="mt-5 text-[14.5px] leading-[1.75] text-[var(--text-muted)]">
            课程与文档只是两种投喂内容的入口。真正的核心是卡片 ——
            你在阅读中划下的每一个不懂的词，都会变成一张卡；
            在 AI 的回答里继续划词，就能一层层追问下去。
          </p>

          <div className="mt-10 space-y-5">
            {[
              ['二维，而非一维', '传统 chat 是时间线，深挖一个概念会把上文顶走。这里每张卡各自占位置，追问的过程本身就在画图。'],
              ['你的图永远是你的', '卡片之间的连线只能由你亲手建立。AI 不能往你的认知地图里乱画线。'],
              ['拒绝收藏夹坟场', '每张卡都有到期日，会主动回来找你 —— 而且不是弹原文，是出一道题。'],
            ].map(([t, d]) => (
              <div key={t} className="flex gap-3">
                <span className="mt-[7px] size-1 rounded-full bg-[var(--accent)] shrink-0" />
                <div>
                  <div className="text-[13.5px] font-medium">{t}</div>
                  <div className="text-[13px] text-[var(--text-muted)] leading-relaxed mt-0.5">{d}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 右：表单 */}
      <div className="flex items-center justify-center px-6 py-10">
        <form onSubmit={submit} className="w-full max-w-[340px]">
          <div className="lg:hidden flex items-center gap-2 mb-8">
            <svg viewBox="0 0 24 24" className="size-5" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
              <path d="M4 19h5v-5" /><path d="M9.5 14h5V9" /><path d="M15 9h5V4.5" />
            </svg>
            <span className="text-[15px] font-semibold">阶梯</span>
          </div>

          <h2 className="text-[19px] font-semibold tracking-[-0.015em]">
            {mode === 'login' ? '欢迎回来' : '创建账号'}
          </h2>
          <p className="text-[13px] text-[var(--text-muted)] mt-1.5">
            {mode === 'login' ? '继续你的学习' : '开始搭建自己的认知地图'}
          </p>

          <div className="mt-7 space-y-3">
            {mode === 'register' && (
              <div>
                <label className="block text-[12px] font-medium text-[var(--text-muted)] mb-1.5">
                  称呼
                </label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="怎么称呼你"
                  autoComplete="name"
                />
              </div>
            )}
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-muted)] mb-1.5">
                邮箱
              </label>
              <Input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                autoComplete="email"
              />
            </div>
            <div>
              <label className="block text-[12px] font-medium text-[var(--text-muted)] mb-1.5">
                密码
              </label>
              <Input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'register' ? '至少 8 位' : '••••••••'}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              />
            </div>
            {mode === 'register' && cfg?.invite_required && (
              <div>
                <label className="block text-[12px] font-medium text-[var(--text-muted)] mb-1.5">
                  邀请码
                </label>
                <Input
                  required
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                  placeholder="本站需要邀请码"
                />
              </div>
            )}
          </div>

          {error && (
            <div
              className={cn(
                'mt-3 px-3 py-2 text-[12.5px] leading-relaxed rounded-[var(--radius)]',
                'bg-[color-mix(in_oklch,var(--sem-danger)_10%,transparent)]',
                'text-[var(--sem-danger)]',
              )}
            >
              {error}
            </div>
          )}

          <Button
            type="submit"
            variant="primary"
            size="md"
            loading={busy}
            disabled={mode === 'register' && !canRegister}
            className="w-full mt-5"
          >
            {mode === 'login' ? '登录' : '注册'}
          </Button>

          {canRegister ? (
            <button
              type="button"
              onClick={() => {
                setMode(mode === 'login' ? 'register' : 'login')
                setError('')
              }}
              className="w-full mt-4 text-[12.5px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
            >
              {mode === 'login' ? '还没有账号？注册一个' : '已经有账号了？去登录'}
            </button>
          ) : (
            <p className="w-full mt-4 text-[12.5px] text-[var(--text-subtle)] text-center">
              本站暂未开放注册
            </p>
          )}

          {cfg?.guest_enabled && (
            <>
              <div className="flex items-center gap-3 mt-6">
                <span className="grow h-px bg-[var(--border)]" />
                <span className="text-[11px] text-[var(--text-subtle)]">或</span>
                <span className="grow h-px bg-[var(--border)]" />
              </div>
              <Button
                type="button"
                variant="outline"
                size="md"
                loading={busy}
                onClick={enterAsGuest}
                className="w-full mt-3"
              >
                游客模式进入
              </Button>
              <p className="mt-2.5 text-[11px] leading-relaxed text-[var(--text-subtle)] text-center">
                免注册直接体验。学习数据与其他游客共享。
              </p>
            </>
          )}

          <div className="mt-8 text-center">
            <Link
              to="/guide"
              className="inline-flex items-center gap-1.5 text-[12.5px] text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
            >
              <svg viewBox="0 0 24 24" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="9.5" />
                <path d="M9.2 9.1a3 3 0 1 1 4.2 2.8c-.8.4-1.3 1.1-1.3 2v.3M12 17.4h.01" />
              </svg>
              先看看怎么用
            </Link>
            <p className="mt-4 text-[11px] leading-relaxed text-[var(--text-subtle)]">
              登录态存放在 httpOnly cookie 中，JavaScript 读取不到。
            </p>
          </div>
        </form>
      </div>
    </div>
  )
}
