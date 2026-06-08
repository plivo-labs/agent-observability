/* card.tsx — the shared run-detail Card primitive used by the Simulate and Live
 * pages. Both modules previously defined an identical local `Card`; this is the
 * single source of truth. Markup is intentionally kept byte-for-byte the same so
 * the rendered output is unchanged. */
import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('rounded-lg border border-border bg-card', className)}>{children}</div>
}

export function CardHead({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('flex items-center gap-2 border-b border-border px-4 py-3', className)}>{children}</div>
}

export function CardTitle({ children }: { children: ReactNode }) {
  return <span className="text-sm font-semibold text-foreground">{children}</span>
}

export function CardSub({ children }: { children: ReactNode }) {
  return <span className="text-xs text-muted-foreground">{children}</span>
}
