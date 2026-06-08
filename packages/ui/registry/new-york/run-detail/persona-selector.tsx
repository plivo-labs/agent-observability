/* persona-selector.tsx — the ONE shared persona/case selector used by both the
 * Simulate report and the Evals run-detail, so the UI is identical in both
 * places. Each page maps its data into `SelectorItem[]`. Selecting an item
 * drives the per-persona views below it (leveled judge, transcript, etc.). */
import { cn } from '@/lib/utils'

export interface SelectorItem {
  id: string
  name: string
  status: 'pass' | 'fail' | 'other'
  avatar?: string // background color for the initials box (else status-tinted)
  score?: number // optional 0–100 metric shown on the right
}

const scoreText = (s: number) => (s >= 80 ? 'text-success' : s >= 65 ? 'text-warning' : 'text-destructive')
const initials = (name: string) => name.split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase()
const STATUS_DOT = { pass: 'bg-success', fail: 'bg-destructive', other: 'bg-muted-foreground/50' } as const
const STATUS_LABEL = { pass: 'Pass', fail: 'Fail', other: 'Pending' } as const
const STATUS_BG = { pass: 'hsl(var(--success))', fail: 'hsl(var(--destructive))', other: 'hsl(var(--muted-foreground))' } as const

export function PersonaSelector({ label = 'Persona', items, selectedId, onSelect }: {
  label?: string
  items: SelectorItem[]
  selectedId: string
  onSelect: (id: string) => void
}) {
  if (items.length === 0) return null
  return (
    <div className="mb-5">
      <div className="mb-2 flex items-center justify-between">
        <span className="ao-hero-eyebrow">{label}</span>
        <span className="text-xs text-muted-foreground">{items.length} {label.toLowerCase()}{items.length === 1 ? '' : 's'}</span>
      </div>
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {items.map((it) => (
          <button type="button"
            key={it.id}
            onClick={() => onSelect(it.id)}
            title={`${it.name} · ${STATUS_LABEL[it.status]}`}
            className={cn(
              'flex items-center gap-2.5 rounded-lg border bg-card p-2.5 text-left transition-colors',
              it.id === selectedId ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'border-border hover:bg-muted/40',
            )}
          >
            <span
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-[11px] font-semibold text-white"
              style={{ background: it.avatar || STATUS_BG[it.status] }}
            >
              {initials(it.name)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">{it.name}</div>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span className={cn('size-1.5 shrink-0 rounded-full', STATUS_DOT[it.status])} />
                {STATUS_LABEL[it.status]}
              </div>
            </div>
            {it.score != null && (
              <span className={cn('shrink-0 text-sm font-semibold tabular-nums', scoreText(it.score))}>{it.score}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}
