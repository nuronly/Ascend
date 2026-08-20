import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { queryClient } from '@/lib/queryClient'
import type { GuideProgress, GuideStepKey } from '@/lib/guide'
import { cn } from '@/lib/utils'

/**
 * 新手引导面板（比赛演示用，计划之后下线）。
 *
 * 任务清单即产品主路径：每一步对应一个高光交互。
 * 完成判定见后端 app/api/guide.py —— 浏览类前端打点，建卡类数据判定。
 */

interface StepDef {
  key: GuideStepKey
  title: string
  desc: string
  /** 跳转目标；section 表示去第一个有正文的小节 */
  to?: string | 'section'
}

const STEPS: StepDef[] = [
  {
    key: 'read_section',
    title: '读一节课的正文',
    desc: '正文是逐节懒生成的，进去等它流出来',
    to: 'section',
  },
  {
    key: 'create_card',
    title: '划词，建第一张卡',
    desc: '在正文里选中任何不懂的词，松开手',
    to: 'section',
  },
  {
    key: 'nest_card',
    title: '在 AI 回答里再划一次',
    desc: '卡片的回答也能划 —— 这是套娃，是本产品的灵魂',
    to: 'section',
  },
  {
    key: 'make_note',
    title: '把这一节收成笔记',
    desc: '学完在右栏点一下，卡片和原文会汇成一张笔记，然后改成你自己的话',
    to: 'section',
  },
  {
    key: 'ask_brain',
    title: '问第二大脑一个问题',
    desc: '它只回答你学过的东西，还会把检索过程演给你看',
    to: '/brain',
  },
]

export function GuideTour({ onClose }: { onClose: () => void }) {
  const nav = useNavigate()

  const { data } = useQuery({
    queryKey: ['guide-progress'],
    queryFn: () => api.get<GuideProgress>('/guide/progress'),
  })

  const dismiss = useMutation({
    mutationFn: () => api.post('/guide/dismiss'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['guide-progress'] })
      onClose()
    },
  })

  const start = useMutation({
    mutationFn: () => api.post('/guide/start'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['guide-progress'] }),
  })

  if (!data) return null

  const doneCount = data.steps.filter((s) => s.done).length
  const allDone = doneCount === data.steps.length

  const go = (step: StepDef) => {
    if (step.to === 'section') {
      if (data.first_section) {
        nav(`/courses/${data.first_section.course_id}/sections/${data.first_section.section_id}`)
      } else {
        nav('/')
      }
    } else if (step.to) {
      nav(step.to)
    }
  }

  return (
    <div
      className={cn(
        'fixed top-14 right-4 z-50 w-[320px]',
        'bg-[var(--bg-raised)] border border-[var(--border)] rounded-[var(--radius-lg)]',
        'animate-fade-in',
      )}
      style={{ boxShadow: 'var(--shadow-pop)' }}
      role="dialog"
      aria-label="新手引导"
    >
      <div className="px-4 pt-3.5 pb-3 border-b border-[var(--border)]">
        <div className="flex items-center justify-between">
          <div className="text-[13.5px] font-semibold tracking-[-0.01em]">新手引导</div>
          <button
            onClick={() => dismiss.mutate()}
            className="size-5.5 grid place-items-center rounded-full text-[var(--text-subtle)] hover:text-[var(--text)] hover:bg-[var(--bg-hover)] transition-colors"
            aria-label="关闭引导"
          >
            <svg viewBox="0 0 24 24" className="size-3" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <path d="M6 6l12 12M18 6 6 18" />
            </svg>
          </button>
        </div>
        <p className="text-[11.5px] text-[var(--text-muted)] mt-1 leading-relaxed">
          五步走完产品主路径，每步都是亲手操作。
        </p>
        {/* 进度条 */}
        <div className="mt-2.5 h-1 rounded-full bg-[var(--bg-sunken)] overflow-hidden">
          <div
            className="h-full rounded-full bg-[var(--sem-rewritten)] transition-[width] duration-500"
            style={{ width: `${(doneCount / data.steps.length) * 100}%` }}
          />
        </div>
      </div>

      <ol className="px-2 py-2">
        {data.steps.map((s, i) => {
          const def = STEPS.find((d) => d.key === s.key)!
          return (
            <li key={s.key}>
              <button
                onClick={() => go(def)}
                className={cn(
                  'w-full flex items-start gap-2.5 px-2.5 py-2 rounded-[var(--radius)] text-left',
                  'hover:bg-[var(--bg-hover)] transition-colors',
                )}
              >
                <span
                  className={cn(
                    'mt-px size-[18px] shrink-0 grid place-items-center rounded-full text-[10px] font-semibold',
                    s.done
                      ? 'bg-[var(--sem-rewritten)] text-white'
                      : 'border border-[var(--border-strong)] text-[var(--text-subtle)]',
                  )}
                >
                  {s.done ? (
                    <svg viewBox="0 0 24 24" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4.5 12.5l5 5 10-11" />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </span>
                <span className="min-w-0">
                  <span
                    className={cn(
                      'block text-[12.5px] font-medium leading-snug',
                      s.done && 'text-[var(--text-subtle)] line-through decoration-[var(--border-strong)]',
                    )}
                  >
                    {def.title}
                  </span>
                  {!s.done && (
                    <span className="block text-[11.5px] text-[var(--text-muted)] leading-relaxed mt-0.5">
                      {def.desc}
                    </span>
                  )}
                </span>
              </button>
            </li>
          )
        })}
      </ol>

      <div className="px-4 py-2.5 border-t border-[var(--border)] flex items-center justify-between">
        {allDone ? (
          <span className="text-[12px] text-[var(--sem-rewritten)] font-medium">
            主路径已走完，剩下的自己探索吧
          </span>
        ) : (
          <span className="text-[11.5px] text-[var(--text-subtle)] tabular-nums">
            {doneCount} / {data.steps.length}
          </span>
        )}
        {!data.started && (
          <button
            onClick={() => start.mutate()}
            className="text-[12px] text-[var(--accent)] hover:underline underline-offset-2"
          >
            重新开始计步
          </button>
        )}
      </div>
    </div>
  )
}
