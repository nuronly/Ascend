import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import { highlight } from '@/lib/highlighter'
import { stabilizeStreamingMarkdown } from '@/lib/streamingMarkdown'
import { ErrorBoundary } from './ErrorBoundary'
import { cn } from '@/lib/utils'
import { useTheme } from '@/lib/store'

/**
 * ★ XSS 防护（PLAN §7 风险 #14）
 *
 * 本产品渲染的几乎全是 LLM 生成的 Markdown，攻击面比普通应用大得多：
 * 提示注入 → 模型吐出恶意 HTML → 直接执行。
 *
 * 插件顺序是关键：
 *   remark-math（把 $...$ 解析成 math 节点，此时还只是纯文本）
 *     → rehype-sanitize（清理 LLM 产生的一切 HTML，白名单制）
 *       → rehype-katex（渲染公式，产出的复杂 span 不再被裁掉）
 *
 * 反过来放（先 katex 后 sanitize）会把公式渲染成一堆裸文本。
 */
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    // 允许 className：代码块的 language-xxx 和 math 节点标记都靠它
    '*': [...(defaultSchema.attributes?.['*'] || []), 'className'],
    code: [...(defaultSchema.attributes?.code || []), 'className'],
    span: [...(defaultSchema.attributes?.span || []), 'className'],
    div: [...(defaultSchema.attributes?.div || []), 'className'],
  },
  tagNames: [...(defaultSchema.tagNames || []), 'span', 'del', 'mark'],
  // 明确剥掉：script / iframe / style / 事件属性由白名单机制自动挡住
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto'],
    src: ['http', 'https'],
  },
}

const REMARK = [remarkGfm, remarkMath]
const REHYPE = [
  [rehypeSanitize, schema],
  [
    rehypeKatex,
    {
      // ★ 必须显式关掉。katex 的默认值是 throwOnError: true，
      //   而流式渲染时 Markdown 永远是半截的 —— 模型刚吐出
      //   `$$\text{Attention}(Q,K,V)=\operatorname{softmax}` 还没闭合，
      //   KaTeX 就会抛 ParseError，一路冒泡到 react-markdown，
      //   整棵 React 树卸载，页面直接白屏。
      throwOnError: false,
      errorColor: 'var(--sem-danger)',
      strict: false,
    },
  ],
] as any

/* ── 代码高亮 ──────────────────────────────────────────────── */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null)
  const theme = useTheme((s) => s.theme)
  const isDark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)

  useEffect(() => {
    let alive = true
    // 语法包按需下载；高亮好之前先显示纯文本，不阻塞阅读
    highlight(code, lang, isDark)
      .then((h) => alive && setHtml(h))
      .catch(() => alive && setHtml(null))
    return () => {
      alive = false
    }
  }, [code, lang, isDark])

  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    })
  }

  return (
    <div className="relative group/code my-4">
      {lang && (
        <div className="absolute top-2 left-3 text-[10.5px] font-mono text-[var(--text-subtle)] uppercase tracking-wide select-none">
          {lang}
        </div>
      )}
      <button
        onClick={copy}
        className={cn(
          'absolute top-1.5 right-1.5 z-10 h-6 px-2 rounded-[var(--radius-sm)]',
          'text-[11px] font-medium bg-[var(--bg-raised)] border border-[var(--border)]',
          'opacity-0 group-hover/code:opacity-100 transition-opacity',
          'hover:bg-[var(--bg-hover)]',
        )}
      >
        {copied ? '已复制' : '复制'}
      </button>
      {html ? (
        <div
          className={cn(
            'shiki-wrap text-[13px] leading-[1.65] rounded-[var(--radius-lg)] overflow-hidden',
            'border border-[var(--border)]',
            '[&_pre]:p-4 [&_pre]:pt-6 [&_pre]:overflow-x-auto [&_pre]:m-0',
            '[&_code]:font-mono',
          )}
          // Shiki 的输出是我们自己生成的高亮 HTML，不含用户内容的原始标签
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="text-[13px] leading-[1.65] p-4 pt-6 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg-sunken)] overflow-x-auto">
          <code className="font-mono">{code}</code>
        </pre>
      )}
    </div>
  )
}

/* ── 主组件 ────────────────────────────────────────────────── */
export interface MarkdownProps {
  children: string
  variant?: 'read' | 'card'
  className?: string
  /** 渲染引用角标 [^id] 为可点击按钮（第二大脑用） */
  onCitation?: (id: string) => void
  /** 正在流式接收中 —— 会把尚未闭合的公式/代码块暂时藏起来 */
  streaming?: boolean
}

const CITATION = /\[\^([A-Za-z0-9_-]+)\]/g

function withCitations(node: ReactNode, onCitation: (id: string) => void): ReactNode {
  if (typeof node === 'string') {
    const parts: ReactNode[] = []
    let last = 0
    let m: RegExpExecArray | null
    CITATION.lastIndex = 0
    while ((m = CITATION.exec(node))) {
      if (m.index > last) parts.push(node.slice(last, m.index))
      const id = m[1]
      parts.push(
        <button
          key={`${id}-${m.index}`}
          onClick={() => onCitation(id)}
          className="inline-flex items-center justify-center align-super mx-0.5 px-1 h-4 min-w-4 rounded-[3px] bg-[var(--accent-soft)] text-[var(--accent)] text-[10px] font-semibold hover:bg-[var(--accent)] hover:text-[var(--accent-text)] transition-colors"
          title="跳到来源卡片"
        >
          ⧉
        </button>,
      )
      last = m.index + m[0].length
    }
    if (last < node.length) parts.push(node.slice(last))
    return parts.length ? parts : node
  }
  if (Array.isArray(node)) return node.map((n, i) => <span key={i}>{withCitations(n, onCitation)}</span>)
  return node
}

/** 与 onCitation 无关的固定组件覆写，提到模块级避免每次渲染重建。 */
const BASE_COMPONENTS: Components = {
  code({ className: cls, children: kids, ...props }: any) {
    const text = String(kids).replace(/\n$/, '')
    const match = /language-(\w+)/.exec(cls || '')
    // 有语言标记或多行 → 代码块；否则是行内 code
    if (match || text.includes('\n')) {
      return <CodeBlock code={text} lang={match?.[1] ?? ''} />
    }
    return (
      <code className={cls} {...props}>
        {kids}
      </code>
    )
  },
  pre: ({ children: kids }: any) => <>{kids}</>,
  a: ({ href, children: kids }: any) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow">
      {kids}
    </a>
  ),
}

export const Markdown = memo(function Markdown({
  children,
  variant = 'read',
  className,
  onCitation,
  streaming,
}: MarkdownProps) {
  // 流式时把尚未闭合的公式/代码围栏藏起来，避免半截 LaTeX 闪红
  const source = useMemo(
    () => (streaming ? stabilizeStreamingMarkdown(children) : children),
    [children, streaming],
  )

  /**
   * ⚠️ 绝不能写成 `p: cond ? Comp : undefined`。
   *
   * react-markdown 底层的 hast-util-to-jsx-runtime 是用 hasOwnProperty
   * 查组件的：`if (own.call(components, name)) Component = components[name]`
   * —— **key 存在就取值，哪怕值是 undefined**。
   * 于是每个 <p> 都变成 createElement(undefined)，整棵树直接炸。
   * 所以这里必须是「不需要就不放这个 key」。
   */
  const components = useMemo<Components>(() => {
    if (!onCitation) return BASE_COMPONENTS
    return {
      ...BASE_COMPONENTS,
      p: ({ children: kids }: any) => <p>{withCitations(kids, onCitation)}</p>,
      li: ({ children: kids }: any) => <li>{withCitations(kids, onCitation)}</li>,
    }
  }, [onCitation])

  return (
    <div className={cn(variant === 'read' ? 'prose-read' : 'prose-card', className)}>
      {/* 兜底：LLM 什么都可能吐出来，绝不允许一段畸形内容白掉整页 */}
      <ErrorBoundary variant="inline" resetKey={source} label="Markdown">
        <ReactMarkdown remarkPlugins={REMARK} rehypePlugins={REHYPE} components={components}>
          {source}
        </ReactMarkdown>
      </ErrorBoundary>
    </div>
  )
})
