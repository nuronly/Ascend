import { cn } from '@/lib/utils'

/**
 * 划词交互的动画演示。
 *
 * 「划词」是本产品唯一的核心动作，但它是个**不可见的交互**——
 * 页面上没有任何按钮暗示"选中文字会发生什么"。
 * 用文字解释（"划中不懂的词"）对没用过的人几乎无效，
 * 所以这里用一段循环动画把整个过程演一遍：
 *
 *   鼠标拖过文字 → 文字被选中 → 浮出提问按钮 → 卡片出现在右侧
 *
 * 放在卡片空间的空白区，不打扰阅读，但一眼就懂。
 */
export function SelectionDemo({ className }: { className?: string }) {
  return (
    <div className={cn('select-none pointer-events-none', className)}>
      <style>{`
        @keyframes demo-sweep {
          0%, 8%     { width: 0; }
          22%, 100%  { width: 100%; }
        }
        @keyframes demo-cursor {
          0%, 8%    { left: 0; opacity: 1; }
          22%       { left: 100%; opacity: 1; }
          30%       { left: 100%; opacity: 0; }
          100%      { left: 100%; opacity: 0; }
        }
        @keyframes demo-btn {
          0%, 24%   { opacity: 0; transform: translateY(-3px) scale(0.94); }
          32%, 46%  { opacity: 1; transform: none; }
          54%, 100% { opacity: 0; transform: translateY(-3px) scale(0.94); }
        }
        @keyframes demo-press {
          0%, 44%   { transform: scale(1); }
          48%       { transform: scale(0.93); }
          52%, 100% { transform: scale(1); }
        }
        @keyframes demo-card {
          0%, 50%   { opacity: 0; transform: translateY(8px) scale(0.96); }
          62%, 92%  { opacity: 1; transform: none; }
          100%      { opacity: 0; transform: translateY(8px) scale(0.96); }
        }
        @keyframes demo-line {
          0%, 54%   { opacity: 0; stroke-dashoffset: 40; }
          66%, 92%  { opacity: 1; stroke-dashoffset: 0; }
          100%      { opacity: 0; stroke-dashoffset: 0; }
        }
        .demo-anim { animation-duration: 5.5s; animation-iteration-count: infinite; animation-timing-function: cubic-bezier(0.4,0,0.2,1); }
        @media (prefers-reduced-motion: reduce) { .demo-anim { animation: none !important; opacity: 1 !important; } }
      `}</style>

      <div className="relative w-[248px]">
        {/* 模拟的正文片段 */}
        <div className="px-3 py-2.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-raised)]">
          <div className="text-[12px] leading-[1.75] text-[var(--text-muted)]">
            …通过{' '}
            <span className="relative inline-block align-baseline">
              {/* 选区高亮从左向右扫过 */}
              <span
                className="demo-anim absolute inset-y-0 left-0 rounded-[2px] bg-[color-mix(in_oklch,var(--accent)_26%,transparent)]"
                style={{ animationName: 'demo-sweep' }}
              />
              <span className="relative text-[var(--text)] font-medium">softmax</span>
              {/* 鼠标光标 */}
              <span
                className="demo-anim absolute -bottom-0.5 w-[1.5px] h-[15px] bg-[var(--accent)]"
                style={{ animationName: 'demo-cursor' }}
              />
            </span>{' '}
            归一化后得到权重分布…
          </div>
        </div>

        {/* 浮出的提问按钮 */}
        <div
          className="demo-anim absolute left-[86px] top-[38px] z-10"
          style={{ animationName: 'demo-btn' }}
        >
          <div
            className="demo-anim flex items-center gap-1 h-[22px] px-2 rounded-[var(--radius-sm)] bg-[var(--accent)] text-[var(--accent-text)] text-[10.5px] font-medium shadow-[var(--shadow-float)]"
            style={{ animationName: 'demo-press' }}
          >
            <svg viewBox="0 0 24 24" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="2.6">
              <circle cx="12" cy="12" r="9.5" />
              <path d="M9.1 9a3 3 0 1 1 4.2 2.8c-.8.4-1.3 1.1-1.3 2v.4M12 17.5h.01" strokeLinecap="round" />
            </svg>
            就这里提问
          </div>
        </div>

        {/* 连到卡片的引导线 */}
        <svg className="absolute left-[104px] top-[62px] w-8 h-8 overflow-visible" fill="none">
          <path
            d="M0 0 C 0 14, 10 12, 16 22"
            stroke="var(--border-strong)"
            strokeWidth="1.2"
            strokeDasharray="40"
            className="demo-anim"
            style={{ animationName: 'demo-line' }}
          />
        </svg>

        {/* 生成的卡片 */}
        <div
          className="demo-anim mt-9 ml-8 w-[186px] rounded-[var(--radius)] border border-[var(--border-strong)] bg-[var(--bg-raised)] shadow-[var(--shadow-float)] overflow-hidden"
          style={{ animationName: 'demo-card' }}
        >
          <div className="flex items-center gap-1 px-2 h-[22px] border-b border-[var(--border)]">
            <span className="text-[10.5px] font-semibold text-[var(--accent)]">⟨softmax⟩</span>
            <div className="grow" />
            <span className="font-mono text-[8.5px] text-[var(--text-subtle)]">1</span>
          </div>
          <div className="px-2 py-1.5 space-y-1">
            <div className="h-[5px] w-full rounded-full bg-[var(--bg-sunken)]" />
            <div className="h-[5px] w-4/5 rounded-full bg-[var(--bg-sunken)]" />
            <div className="h-[5px] w-3/5 rounded-full bg-[var(--bg-sunken)]" />
          </div>
        </div>
      </div>
    </div>
  )
}
