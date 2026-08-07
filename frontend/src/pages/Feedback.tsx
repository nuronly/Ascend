import { useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '@/lib/api'
import { Button } from '@/components/ui'
import { cn } from '@/lib/utils'

/**
 * 意见反馈。
 *
 * 风格沿用使用说明页：窄栏、大留白、灰阶为主，不用营销腔。
 * 提交后不弹 toast 就完事 —— 用户花时间写了东西，
 * 值得一个明确的、停留得住的致谢页面。
 */
export default function FeedbackPage() {
  const nav = useNavigate()
  const location = useLocation() as { state?: { from?: string } }

  const [content, setContent] = useState('')
  const [contact, setContact] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const text = content.trim()
    if (!text || busy) return
    setBusy(true)
    setError('')
    try {
      await api.post('/feedback', {
        content: text,
        contact: contact.trim(),
        // 带上来源页面，定位问题时有用
        page: location.state?.from ?? document.referrer ?? '',
      })
      setDone(true)
    } catch (err: any) {
      setError(err?.message ?? '提交失败，请稍后再试')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="max-w-[560px] mx-auto px-6 py-24 text-center">
          <div className="size-11 mx-auto grid place-items-center rounded-full bg-[color-mix(in_oklch,var(--sem-rewritten)_14%,transparent)]">
            <svg
              viewBox="0 0 24 24"
              className="size-5 text-[var(--sem-rewritten)]"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4.5 12.5l5 5 10-11" />
            </svg>
          </div>

          <h1 className="text-[20px] font-semibold tracking-[-0.015em] mt-5">
            收到了，谢谢你
          </h1>
          <p className="text-[13.5px] text-[var(--text-muted)] leading-[1.75] mt-3">
            每一条反馈我都会看。这个产品还很年轻，你花时间写下的这些，
            正是它下一步该往哪走的依据。
          </p>

          <div className="flex items-center justify-center gap-2 mt-8">
            <Button variant="primary" size="sm" onClick={() => nav('/')}>
              回到学习
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setContent('')
                setContact('')
                setDone(false)
              }}
            >
              再写一条
            </Button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto">
      <form onSubmit={submit} className="max-w-[560px] mx-auto px-6 py-12">
        <h1 className="text-[22px] font-semibold tracking-[-0.018em]">意见反馈</h1>
        <p className="text-[13.5px] text-[var(--text-muted)] leading-[1.75] mt-2.5">
          用着别扭的地方、想要但没有的功能、哪里看不懂 —— 都可以直接写。
          说得越具体越好，比如「在哪一页、做了什么、期望是什么」。
        </p>

        <div className="mt-7">
          <label className="block text-[12px] font-medium text-[var(--text-muted)] mb-1.5">
            你的意见
          </label>
          <textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            rows={9}
            autoFocus
            maxLength={4000}
            placeholder="想说什么都行……"
            className={cn(
              'w-full px-3.5 py-3 text-[13.5px] leading-[1.75] rounded-[var(--radius)]',
              'bg-[var(--bg-raised)] border border-[var(--border)] resize-y',
              'placeholder:text-[var(--text-subtle)]',
              'focus:outline-none focus:border-[var(--accent)] transition-colors',
            )}
          />
          <div className="mt-1 text-right text-[11px] text-[var(--text-subtle)] tabular-nums">
            {content.length} / 4000
          </div>
        </div>

        <div className="mt-4">
          <label className="block text-[12px] font-medium text-[var(--text-muted)] mb-1.5">
            联系方式 <span className="text-[var(--text-subtle)] font-normal">（选填）</span>
          </label>
          <input
            value={contact}
            onChange={(e) => setContact(e.target.value)}
            maxLength={200}
            placeholder="邮箱或微信，方便的话留一个，可能会找你聊聊"
            className={cn(
              'w-full h-9 px-3.5 text-[13px] rounded-[var(--radius)]',
              'bg-[var(--bg-raised)] border border-[var(--border)]',
              'placeholder:text-[var(--text-subtle)]',
              'focus:outline-none focus:border-[var(--accent)] transition-colors',
            )}
          />
        </div>

        {error && (
          <div
            className={cn(
              'mt-4 px-3 py-2 text-[12.5px] leading-relaxed rounded-[var(--radius)]',
              'bg-[color-mix(in_oklch,var(--sem-danger)_10%,transparent)] text-[var(--sem-danger)]',
            )}
          >
            {error}
          </div>
        )}

        <div className="flex items-center gap-2 mt-6">
          <Button type="submit" variant="primary" size="md" loading={busy} disabled={!content.trim()}>
            提交
          </Button>
          <Button type="button" variant="ghost" size="md" onClick={() => nav(-1)}>
            返回
          </Button>
        </div>

        <p className="mt-8 text-[11.5px] text-[var(--text-subtle)] leading-relaxed">
          提交的内容会连同你的账号邮箱一起发给开发者，用于改进产品。
        </p>
      </form>
    </div>
  )
}
