import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { formatCost, formatDuration, formatMs, formatTokens } from '@/lib/observability-format'
import { StatusDot } from './primitives'
import type { EnrichedCase, MetricsView } from './model'

// Columns drive the header AND the empty-state colspan, so adding a
// column is a one-line change — not three sites that have to agree.
function caseColumns(view: MetricsView): { k: string; label: string; cls?: string }[] {
  return [
    { k: 'sel', label: '' },
    { k: 'name', label: 'Name', cls: 'text-left' },
    { k: 'status', label: 'Status' },
    { k: 'duration', label: 'Duration' },
    { k: 'ttft', label: 'TTFT' },
    ...(view === 'voice' ? [{ k: 'ttfb', label: 'TTFB' }] : []),
    { k: 'tokens', label: 'Tokens' },
    { k: 'cache', label: 'Cache %' },
    { k: 'cost', label: 'Cost' },
    { k: 'tools', label: 'Tools' },
    { k: 'asr', label: 'ASR conf.' },
    { k: 'events', label: 'Events' },
    { k: 'chev', label: '' },
  ]
}

export function CasesTable({
  cases,
  view,
  selectedSet,
  allVisibleSelected,
  onToggleAllVisible,
  onToggleCase,
  onRowClick,
  emptyStateText,
}: {
  cases: EnrichedCase[]
  view: MetricsView
  selectedSet: Set<string>
  allVisibleSelected: boolean
  onToggleAllVisible: (checked: boolean) => void
  onToggleCase: (caseId: string, checked: boolean) => void
  onRowClick: (caseId: string) => void
  emptyStateText: string
}) {
  const cols = caseColumns(view)
  return (
    <div className="rounded-lg border bg-card overflow-hidden">
      <table className="w-full text-[12px] border-collapse">
        <thead>
          <tr className="text-muted-foreground">
            {cols.map((h) => (
              <th
                key={h.k}
                className={cn(
                  'h-9 px-3.5 text-[10px] font-semibold tracking-[0.12em] uppercase border-b border-border bg-card whitespace-nowrap',
                  h.cls ?? 'text-left',
                )}
              >
                {h.k === 'sel' ? (
                  <Checkbox
                    checked={allVisibleSelected}
                    onCheckedChange={(checked) => onToggleAllVisible(checked === true)}
                    aria-label="Select all visible cases"
                  />
                ) : (
                  h.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => (
            <CaseRow
              key={c.case_id}
              c={c}
              view={view}
              selected={selectedSet.has(c.case_id)}
              onToggle={(checked) => onToggleCase(c.case_id, checked)}
              onClick={() => onRowClick(c.case_id)}
            />
          ))}
          {cases.length === 0 && (
            <tr>
              <td colSpan={cols.length} className="px-4 py-10 text-center text-muted-foreground">
                {emptyStateText}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function CaseRow({
  c,
  view,
  selected,
  onToggle,
  onClick,
}: {
  c: EnrichedCase
  view: MetricsView
  selected: boolean
  onToggle: (checked: boolean) => void
  onClick: () => void
}) {
  const { ttftBad, ttfbBad, asrBad, asrWarn, hasInterrupt } = c
  return (
    <tr onClick={onClick} className="cursor-pointer transition-colors hover:bg-muted/40">
      <td className="h-10 px-3.5 border-b border-border" onClick={(e) => e.stopPropagation()}>
        <Checkbox
          checked={selected}
          onCheckedChange={(checked) => onToggle(checked === true)}
          aria-label={`Select case ${c.name}`}
        />
      </td>
      <td className="h-10 px-3.5 border-b border-border font-mono text-[12px] truncate max-w-[420px]">
        {c.name}
      </td>
      <td className="h-10 px-3.5 border-b border-border">
        <StatusDot status={c.status} />
      </td>
      <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-muted-foreground">
        {formatDuration(c.duration_ms)}
      </td>
      <td
        className={cn(
          'h-10 px-3.5 border-b border-border font-mono tabular-nums',
          ttftBad ? 'text-destructive' : 'text-foreground/85',
        )}
      >
        {c.ttft_avg_ms != null ? formatMs(c.ttft_avg_ms) : '—'}
      </td>
      {view === 'voice' && (
        <td
          className={cn(
            'h-10 px-3.5 border-b border-border font-mono tabular-nums',
            ttfbBad ? 'text-destructive' : 'text-foreground/85',
          )}
        >
          {c.ttfb_avg_ms != null ? formatMs(c.ttfb_avg_ms) : '—'}
        </td>
      )}
      <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-foreground/85">
        {formatTokens(c.total_tokens)}
      </td>
      <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-foreground/85">
        {c.prompt_tokens > 0
          ? `${Math.round((c.cached_prompt_tokens / c.prompt_tokens) * 100)}%`
          : '—'}
      </td>
      <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-foreground/85">
        {formatCost(c.estimated_cost_usd)}
      </td>
      <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-muted-foreground">
        {c.tool_call_count != null && c.tool_call_count > 0 ? c.tool_call_count : '—'}
      </td>
      <td className="h-10 px-3.5 border-b border-border">
        {c.asr == null ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            <span
              className={cn(
                'font-mono tabular-nums',
                asrBad
                  ? 'text-destructive'
                  : asrWarn
                    ? 'text-warning-fg'
                    : 'text-success-fg',
              )}
            >
              {(c.asr * 100).toFixed(1)}%
            </span>
            {hasInterrupt && (
              <span className="inline-flex items-center px-1.5 h-[18px] rounded bg-warning-bg text-warning-fg border border-warning-border text-[10px] font-medium tracking-wide">
                intr
              </span>
            )}
          </span>
        )}
      </td>
      <td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-muted-foreground">
        {c.events.length}
      </td>
      <td className="h-10 px-3.5 border-b border-border text-muted-foreground/60">›</td>
    </tr>
  )
}
