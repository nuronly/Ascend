import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from './ui'

/**
 * 错误边界。
 *
 * React 的默认行为是：任何渲染错误 → 卸载整棵树 → 白屏。
 * 本产品要渲染大量 **LLM 生成的、且流式到达因而永远半截的** Markdown，
 * 触发渲染异常的概率远高于普通应用，所以必须兜底：
 * 宁可局部显示一块错误提示，也绝不整页白屏。
 */
interface Props {
  children: ReactNode
  /** 局部兜底（如单张卡片内）用 inline，整页用 page */
  variant?: 'page' | 'inline'
  /** 这个 key 变化时自动重置 —— 比如切换小节后应该重新尝试渲染 */
  resetKey?: unknown
  label?: string
}

interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', this.props.label ?? '', error, info.componentStack)
  }

  componentDidUpdate(prev: Props) {
    if (this.state.error && prev.resetKey !== this.props.resetKey) {
      this.setState({ error: null })
    }
  }

  private reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    if (this.props.variant === 'inline') {
      return (
        <div className="my-2 px-3 py-2 text-[12.5px] leading-relaxed rounded-[var(--radius)] border border-[color-mix(in_oklch,var(--sem-danger)_35%,transparent)] bg-[color-mix(in_oklch,var(--sem-danger)_6%,transparent)]">
          <div className="text-[var(--sem-danger)] font-medium">这段内容渲染失败</div>
          <div className="text-[var(--text-muted)] mt-1 break-words">{error.message}</div>
          <button
            onClick={this.reset}
            className="mt-1.5 text-[12px] text-[var(--accent)] hover:underline"
          >
            重试
          </button>
        </div>
      )
    }

    return (
      <div className="h-full flex items-center justify-center p-8">
        <div className="max-w-md text-center">
          <div className="text-[15px] font-semibold">页面出错了</div>
          <p className="text-[13px] text-[var(--text-muted)] mt-2 leading-relaxed break-words">
            {error.message}
          </p>
          <div className="flex gap-2 justify-center mt-5">
            <Button variant="primary" size="sm" onClick={this.reset}>
              重试
            </Button>
            <Button size="sm" onClick={() => window.location.reload()}>
              刷新页面
            </Button>
          </div>
          <p className="text-[11px] text-[var(--text-subtle)] mt-4">
            你的数据都在服务端，刷新不会丢失任何内容。
          </p>
        </div>
      </div>
    )
  }
}
