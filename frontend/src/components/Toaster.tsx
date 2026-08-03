import { useToast } from '@/lib/store'
import { cn } from '@/lib/utils'

export function Toaster() {
  const { toasts, remove } = useToast()
  if (!toasts.length) return null

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col-reverse gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => remove(t.id)}
          className={cn(
            'pointer-events-auto cursor-pointer animate-fade-up',
            'flex items-center gap-2 max-w-md px-3 py-2',
            'bg-[var(--bg-raised)] border rounded-[var(--radius)] shadow-[var(--shadow-pop)]',
            'text-[13px] leading-snug',
            t.kind === 'error'
              ? 'border-[color-mix(in_oklch,var(--sem-danger)_45%,transparent)]'
              : t.kind === 'ok'
                ? 'border-[color-mix(in_oklch,var(--sem-ok)_45%,transparent)]'
                : 'border-[var(--border-strong)]',
          )}
        >
          <span
            className={cn(
              'size-1.5 rounded-full shrink-0',
              t.kind === 'error'
                ? 'bg-[var(--sem-danger)]'
                : t.kind === 'ok'
                  ? 'bg-[var(--sem-ok)]'
                  : 'bg-[var(--text-subtle)]',
            )}
          />
          {t.message}
        </div>
      ))}
    </div>
  )
}
