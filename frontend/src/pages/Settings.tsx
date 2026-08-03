import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { useAuth, useTheme, toast } from '@/lib/store'
import type { Usage } from '@/lib/types'
import { Button, Input, Progress, Segmented } from '@/components/ui'
import { cn } from '@/lib/utils'

export default function SettingsPage() {
  const { user, setUser } = useAuth()
  const { theme, setTheme } = useTheme()

  const [pomoMinutes, setPomoMinutes] = useState(
    String(user?.settings?.default_pomodoro_minutes ?? 25),
  )
  const [quota, setQuota] = useState(String(user?.settings?.daily_token_quota ?? ''))
  const [oldPw, setOldPw] = useState('')
  const [newPw, setNewPw] = useState('')
  const [saving, setSaving] = useState(false)

  const { data: usage, refetch } = useQuery({
    queryKey: ['usage'],
    queryFn: () => api.get<Usage>('/auth/usage'),
    refetchInterval: 30_000,
  })

  const savePrefs = async () => {
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        default_pomodoro_minutes: Math.max(5, Math.min(120, Number(pomoMinutes) || 25)),
      }
      if (quota.trim()) body.daily_token_quota = Math.max(0, Number(quota) || 0)
      const u = await api.patch<typeof user>('/auth/me/settings', body)
      if (u) setUser(u)
      toast.ok('已保存')
    } catch (e: any) {
      toast.error(e?.message ?? '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const changePw = async () => {
    if (newPw.length < 8) {
      toast.error('新密码至少 8 位')
      return
    }
    try {
      await api.post('/auth/me/password', { current_password: oldPw, new_password: newPw })
      setOldPw('')
      setNewPw('')
      toast.ok('密码已修改，其它设备的登录已全部失效')
    } catch (e: any) {
      toast.error(e?.message ?? '修改失败')
    }
  }

  const pct = usage?.quota ? usage.total_tokens / usage.quota : 0

  return (
    <div className="max-w-[640px] w-full mx-auto px-8 py-10 pb-24">
      <h1 className="text-[22px] font-semibold tracking-[-0.018em]">设置</h1>

      {/* 账号 */}
      <Section title="账号">
        <Row label="邮箱">
          <span className="text-[13px] text-[var(--text-muted)]">{user?.email}</span>
        </Row>
        <Row label="称呼">
          <span className="text-[13px]">{user?.name}</span>
        </Row>
      </Section>

      {/* 外观 */}
      <Section title="外观">
        <Row label="主题" hint="学习场景夜间使用占比高，深色模式用的是 zinc-950 而非纯黑">
          <Segmented
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'light', label: '浅色' },
              { value: 'dark', label: '深色' },
              { value: 'system', label: '跟随系统' },
            ]}
          />
        </Row>
      </Section>

      {/* 学习 */}
      <Section title="学习">
        <Row label="默认番茄时长" hint="进入小节时会优先使用该节的预计时长">
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={5}
              max={120}
              value={pomoMinutes}
              onChange={(e) => setPomoMinutes(e.target.value)}
              className="w-20 h-7 text-[12.5px]"
            />
            <span className="text-[12px] text-[var(--text-muted)]">分钟</span>
          </div>
        </Row>
        <Row label="每日 token 上限" hint="0 表示不限。超出后 AI 功能会暂停，防止意外烧钱">
          <Input
            type="number"
            min={0}
            value={quota}
            onChange={(e) => setQuota(e.target.value)}
            placeholder={String(usage?.quota ?? 2000000)}
            className="w-36 h-7 text-[12.5px]"
          />
        </Row>
        <div className="pt-1">
          <Button variant="primary" size="sm" onClick={savePrefs} loading={saving}>
            保存
          </Button>
        </div>
      </Section>

      {/* 用量 */}
      <Section title="AI 用量" hint="过去 24 小时。每一次调用都记了账，包括走的哪个模型、花了多少。">
        {usage && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {[
                { label: '调用次数', v: usage.calls.toLocaleString() },
                { label: 'Tokens', v: usage.total_tokens.toLocaleString() },
                { label: '估算成本', v: `$${usage.cost_usd.toFixed(4)}` },
                { label: '缓存命中', v: usage.cache_hits.toLocaleString() },
              ].map((s) => (
                <div key={s.label}>
                  <div className="text-[11px] text-[var(--text-subtle)]">{s.label}</div>
                  <div className="text-[17px] font-semibold tabular-nums tracking-[-0.015em] mt-0.5">
                    {s.v}
                  </div>
                </div>
              ))}
            </div>
            {!!usage.quota && (
              <div className="mt-4">
                <div className="flex justify-between text-[11.5px] text-[var(--text-muted)] mb-1.5 tabular-nums">
                  <span>今日额度</span>
                  <span>
                    {usage.total_tokens.toLocaleString()} / {usage.quota.toLocaleString()}
                  </span>
                </div>
                <Progress value={pct} />
                {pct > 0.85 && (
                  <div className="text-[11.5px] text-[var(--sem-due)] mt-1.5">
                    快到上限了。超出后 AI 功能会暂停，明天自动恢复。
                  </div>
                )}
              </div>
            )}
            <Button size="xs" variant="ghost" className="mt-3" onClick={() => refetch()}>
              刷新
            </Button>
          </>
        )}
      </Section>

      {/* 数据 */}
      <Section
        title="数据"
        hint="你的卡片网络是核心资产。我们用数据库做本体，但必须提供无损导出 —— 不做数据绑架。"
      >
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => window.open('/api/export/markdown')}>
            导出 Markdown（zip）
          </Button>
          <Button size="sm" onClick={() => window.open('/api/export/json')}>
            导出 JSON
          </Button>
        </div>
        <p className="text-[11.5px] text-[var(--text-subtle)] mt-2.5 leading-relaxed">
          Markdown 包里卡片按 Luhmann 编号命名，双链写成 <code>[[编号]]</code>，
          可以直接扔进 Obsidian。
        </p>
      </Section>

      {/* 安全 */}
      <Section title="修改密码" hint="改完会吊销其它所有设备的登录">
        <div className="space-y-2 max-w-xs">
          <Input
            type="password"
            value={oldPw}
            onChange={(e) => setOldPw(e.target.value)}
            placeholder="当前密码"
            autoComplete="current-password"
          />
          <Input
            type="password"
            value={newPw}
            onChange={(e) => setNewPw(e.target.value)}
            placeholder="新密码（至少 8 位）"
            autoComplete="new-password"
          />
          <Button size="sm" onClick={changePw} disabled={!oldPw || !newPw}>
            修改密码
          </Button>
        </div>
      </Section>
    </div>
  )
}

function Section({
  title,
  hint,
  children,
}: {
  title: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <section className="mt-9 pt-6 border-t border-[var(--border)] first:border-t-0">
      <h2 className="text-[13.5px] font-semibold">{title}</h2>
      {hint && (
        <p className="text-[12px] text-[var(--text-muted)] mt-1 leading-relaxed max-w-[60ch]">
          {hint}
        </p>
      )}
      <div className={cn('mt-4 space-y-3')}>{children}</div>
    </section>
  )
}

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <div className="min-w-0">
        <div className="text-[13px]">{label}</div>
        {hint && (
          <div className="text-[11.5px] text-[var(--text-subtle)] mt-0.5 leading-relaxed">
            {hint}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}
