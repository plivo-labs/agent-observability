/* selectable-card.tsx — the shared clickable + selectable "Recent runs" card
 * shell used by the Monitor (sessions) and Evals (runs) lists. They were ~85%
 * identical (outer button + keyboard/closest-guard, checkbox, title + mono meta
 * line, status pill, optional footer); only the title/meta/pill/body content
 * differs. Pass those in; the shell stays in one place. */
import type { ReactNode } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

export function SelectableCard({
  selected,
  onToggle,
  onOpen,
  selectAriaLabel,
  title,
  meta,
  pill,
  footer,
  children,
  loading,
}: {
  selected?: boolean
  onToggle?: (value: boolean) => void
  onOpen?: () => void
  selectAriaLabel?: string
  title?: ReactNode
  meta?: ReactNode
  pill?: ReactNode
  footer?: ReactNode
  children?: ReactNode
  /** Render the loading-skeleton shell instead of content. Keeps the card
   * chrome (border/radius/padding) in one place so skeletons can't drift from
   * the live card. */
  loading?: boolean
}) {
  if (loading) {
    return (
      <div
        className="border bg-card px-5 py-4 shadow-sm"
        style={{ borderRadius: 'var(--radius)' }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-3 w-64" />
          </div>
          <Skeleton className="h-5 w-16 rounded-full" />
        </div>
        <Skeleton className="mt-3 h-4 w-40" />
        <Skeleton className="mt-3 h-4 w-48" />
      </div>
    )
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={(e) => {
        const t = e.target as HTMLElement
        if (t.closest('button, a, input, select, [role="menuitem"]')) return
        onOpen?.()
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen?.()
        }
      }}
      data-state={selected ? 'selected' : undefined}
      className={cn(
        'group block cursor-pointer border bg-card px-5 py-4 shadow-sm transition-colors',
        'rounded-[var(--radius)] hover:border-[hsl(var(--muted-foreground)/0.4)] hover:bg-muted/30',
        selected && 'border-[hsl(var(--primary))] bg-muted/30',
      )}
      style={{ borderRadius: 'var(--radius)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <Checkbox
            aria-label={selectAriaLabel}
            checked={selected}
            onCheckedChange={(value) => onToggle?.(!!value)}
            onClick={(e) => e.stopPropagation()}
            className="mt-1 shrink-0"
          />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base text-foreground" style={{ fontFamily: 'var(--font-display)' }}>
              {title}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-2 text-[10px] uppercase tracking-[0.16em] text-muted-foreground" style={{ fontFamily: 'var(--mono)' }}>
              {meta}
            </div>
          </div>
        </div>
        {pill}
      </div>

      {children}

      {footer != null && (
        <div className="mt-3 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/80" style={{ fontFamily: 'var(--mono)' }}>
          {footer}
        </div>
      )}
    </div>
  )
}
