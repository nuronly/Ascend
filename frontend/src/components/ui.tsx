import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

/* ── Button ───────────────────────────────────────────────── */
type Variant = 'primary' | 'ghost' | 'outline' | 'subtle' | 'danger'
type Size = 'xs' | 'sm' | 'md'

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-[var(--accent)] text-[var(--accent-text)] hover:bg-[var(--accent-hover)]',
  outline: 'border border-[var(--border-strong)] hover:bg-[var(--bg-hover)]',
  ghost: 'hover:bg-[var(--bg-hover)] text-[var(--text-muted)] hover:text-[var(--text)]',
  subtle: 'bg-[var(--bg-sunken)] hover:bg-[var(--bg-hover)]',
  danger: 'text-[var(--sem-danger)] hover:bg-[color-mix(in_oklch,var(--sem-danger)_12%,transparent)]',
}

const SIZES: Record<Size, string> = {
  xs: 'h-6 px-2 text-[11.5px] gap-1 rounded-[var(--radius-sm)]',
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-[var(--radius)]',
  md: 'h-9 px-4 text-[13.5px] gap-2 rounded-[var(--radius)]',
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
  loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'outline', size = 'sm', loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center font-medium whitespace-nowrap',
        'transition-colors duration-100 select-none',
        'disabled:opacity-45 disabled:pointer-events-none',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...props}
    >
      {loading && <Spinner className="size-3.5" />}
      {children}
    </button>
  ),
)
Button.displayName = 'Button'

/* ── Spinner ──────────────────────────────────────────────── */
export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn('animate-spin size-4 shrink-0', className)} viewBox="0 0 24 24" fill="none">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.2" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/* ── Input / Textarea ─────────────────────────────────────── */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'w-full h-9 px-3 text-[13.5px] bg-[var(--bg-raised)]',
        'border border-[var(--border)] rounded-[var(--radius)]',
        'placeholder:text-[var(--text-subtle)]',
        'focus:outline-none focus:border-[var(--accent)]',
        'focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_18%,transparent)]',
        'transition-[border-color,box-shadow] duration-100',
        'disabled:opacity-50',
        className,
      )}
      {...props}
    />
  ),
)
Input.displayName = 'Input'

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'w-full px-3 py-2 text-[13.5px] leading-relaxed bg-[var(--bg-raised)] resize-none',
        'border border-[var(--border)] rounded-[var(--radius)]',
        'placeholder:text-[var(--text-subtle)]',
        'focus:outline-none focus:border-[var(--accent)]',
        'focus:ring-2 focus:ring-[color-mix(in_oklch,var(--accent)_18%,transparent)]',
        'transition-[border-color,box-shadow] duration-100',
        className,
      )}
      {...props}
    />
  ),
)
Textarea.displayName = 'Textarea'

/* ── Badge ────────────────────────────────────────────────── */
export function Badge({
  children,
  className,
  tone = 'neutral',
}: {
  children: ReactNode
  className?: string
  tone?: 'neutral' | 'accent' | 'real' | 'due' | 'rewritten' | 'muted'
}) {
  const tones = {
    neutral: 'bg-[var(--bg-sunken)] text-[var(--text-muted)] border-[var(--border)]',
    accent: 'bg-[var(--accent-soft)] text-[var(--accent)] border-transparent',
    real: 'bg-[color-mix(in_oklch,var(--sem-real)_14%,transparent)] text-[var(--sem-real)] border-transparent',
    due: 'bg-[color-mix(in_oklch,var(--sem-due)_14%,transparent)] text-[var(--sem-due)] border-transparent',
    rewritten:
      'bg-[color-mix(in_oklch,var(--sem-rewritten)_14%,transparent)] text-[var(--sem-rewritten)] border-transparent',
    muted: 'text-[var(--text-subtle)] border-transparent',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-1.5 h-5 rounded-[var(--radius-sm)]',
        'text-[11px] font-medium border tabular-nums leading-none',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}

/* ── Modal ────────────────────────────────────────────────── */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'max-w-lg',
  closeOnBackdrop = true,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  subtitle?: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: string
  closeOnBackdrop?: boolean
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/35 dark:bg-black/55 animate-fade-in"
        onClick={closeOnBackdrop ? onClose : undefined}
      />
      <div
        className={cn(
          'relative w-full bg-[var(--bg-raised)] border border-[var(--border)]',
          'rounded-[var(--radius-lg)] shadow-[var(--shadow-pop)] animate-pop-in',
          'max-h-[85vh] flex flex-col',
          width,
        )}
      >
        {title && (
          <div className="px-5 pt-4 pb-3 border-b border-[var(--border)] shrink-0">
            <div className="text-[15px] font-semibold tracking-[-0.01em]">{title}</div>
            {subtitle && (
              <div className="text-[12.5px] text-[var(--text-muted)] mt-1 leading-relaxed">
                {subtitle}
              </div>
            )}
          </div>
        )}
        <div className="px-5 py-4 overflow-y-auto grow">{children}</div>
        {footer && (
          <div className="px-5 py-3 border-t border-[var(--border)] flex justify-end gap-2 shrink-0">
            {footer}
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Empty ────────────────────────────────────────────────── */
export function Empty({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode
  title: string
  hint?: ReactNode
  action?: ReactNode
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
      {icon && <div className="text-[var(--text-subtle)] mb-3 opacity-60">{icon}</div>}
      <div className="text-[14px] font-medium">{title}</div>
      {hint && (
        <div className="text-[13px] text-[var(--text-muted)] mt-1.5 max-w-md leading-relaxed">
          {hint}
        </div>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  )
}

/* ── Tooltip（纯 CSS，无依赖）─────────────────────────────── */
export function Tip({
  label,
  children,
  side = 'bottom',
}: {
  label: string
  children: ReactNode
  side?: 'top' | 'bottom'
}) {
  return (
    <span className="relative inline-flex group/tip">
      {children}
      <span
        className={cn(
          'pointer-events-none absolute left-1/2 -translate-x-1/2 z-50',
          'px-1.5 py-1 rounded-[var(--radius-sm)] whitespace-nowrap',
          'bg-[var(--g-900)] dark:bg-[var(--g-200)] text-[var(--g-50)] dark:text-[var(--g-900)]',
          'text-[11px] font-medium opacity-0 group-hover/tip:opacity-100',
          'transition-opacity duration-150 delay-300',
          side === 'bottom' ? 'top-[calc(100%+5px)]' : 'bottom-[calc(100%+5px)]',
        )}
      >
        {label}
      </span>
    </span>
  )
}

/* ── Segmented ────────────────────────────────────────────── */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  size = 'sm',
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: ReactNode; title?: string }[]
  size?: 'xs' | 'sm'
}) {
  return (
    <div
      className={cn(
        'inline-flex items-center gap-0.5 p-0.5',
        'bg-[var(--bg-sunken)] border border-[var(--border)] rounded-[var(--radius)]',
      )}
    >
      {options.map((o) => (
        <button
          key={o.value}
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cn(
            'font-medium transition-colors rounded-[var(--radius-sm)]',
            size === 'xs' ? 'h-5 px-2 text-[11px]' : 'h-6 px-2.5 text-[12px]',
            value === o.value
              ? 'bg-[var(--bg-raised)] text-[var(--text)] shadow-[var(--shadow-float)]'
              : 'text-[var(--text-muted)] hover:text-[var(--text)]',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ── Progress ─────────────────────────────────────────────── */
export function Progress({ value, className }: { value: number; className?: string }) {
  return (
    <div className={cn('h-1 bg-[var(--bg-sunken)] rounded-full overflow-hidden', className)}>
      <div
        className="h-full bg-[var(--accent)] rounded-full transition-[width] duration-500 ease-out"
        style={{ width: `${Math.min(100, Math.max(0, value * 100))}%` }}
      />
    </div>
  )
}
