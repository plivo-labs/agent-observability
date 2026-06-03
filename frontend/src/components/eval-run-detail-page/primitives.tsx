import type * as React from 'react'
import { useState } from 'react'
import { Check, Copy, ExternalLink, GitBranch } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDate, formatDuration } from '@/lib/observability-format'
import type { CaseStatus, EvalRunDetail } from '@/lib/observability-types'
import { type StatusFilter } from './model'

// The KPI tile that used to live here is now the shared `KpiTile`
// (`@/components/kpi`), extended with the value-tone / hint props this strip
// needs. See kpi-strip.tsx.

// ── Status dot ─────────────────────────────────────────────────────────────

const STATUS_DOT: Record<CaseStatus, { dot: string; text: string }> = {
  passed: {
    dot: 'bg-[hsl(var(--success-fg,var(--success)))]',
    text: 'text-[hsl(var(--success-fg,var(--success)))]',
  },
  failed: {
    dot: 'bg-[hsl(var(--destructive))]',
    text: 'text-[hsl(var(--destructive))]',
  },
  errored: {
    dot: 'bg-[hsl(var(--warning-fg,var(--warning)))]',
    text: 'text-[hsl(var(--warning-fg,var(--warning)))]',
  },
  skipped: { dot: 'bg-muted-foreground', text: 'text-muted-foreground' },
}

export function StatusDot({ status }: { status: CaseStatus }) {
  const { dot, text } = STATUS_DOT[status]
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[12px]', text)}>
      <span className={cn('h-1.5 w-1.5 rounded-full', dot)} />
      {status}
    </span>
  )
}

// ── Copy-to-clipboard button ───────────────────────────────────────────────

export function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard?.writeText(text)
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1100)
      }}
      className="inline-flex h-5 w-5 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted transition"
      aria-label="Copy run id"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

// ── Chart panel frame ──────────────────────────────────────────────────────

export function Panel({
  title,
  legend,
  children,
}: {
  title: string
  legend?: { color: string; label: string }[]
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border bg-card p-4 flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <span data-slot="panel-title" className="text-[13px] font-medium">{title}</span>
        {legend && (
          <div className="flex items-center gap-3">
            {legend.map((l) => (
              <span
                key={l.label}
                className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"
              >
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ background: l.color }}
                />
                {l.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="h-[180px] -mx-1">{children}</div>
    </div>
  )
}

// ── Status filter pill ─────────────────────────────────────────────────────

export function FilterPill({
  active,
  onChange,
}: {
  active: StatusFilter
  onChange: (s: StatusFilter) => void
}) {
  const items: StatusFilter[] = ['all', 'passed', 'failed', 'errored']
  return (
    <div className="inline-flex h-8 items-center rounded-md border bg-card p-0.5 text-[12px]">
      {items.map((it) => (
        <button
          key={it}
          type="button"
          onClick={() => onChange(it)}
          className={cn(
            'px-3 h-full rounded-none transition uppercase font-mono text-[11px] tracking-section',
            active === it
              ? 'bg-foreground text-background font-semibold'
              : 'text-tertiary hover:text-foreground',
          )}
        >
          {it}
        </button>
      ))}
    </div>
  )
}

// ── Run meta strip ─────────────────────────────────────────────────────────

export function RunMetaStrip({ run }: { run: EvalRunDetail }) {
  const branch = run.ci?.git_branch ? String(run.ci.git_branch) : null
  const sha = run.ci?.git_sha ? String(run.ci.git_sha).slice(0, 7) : null
  const runShort = `${run.run_id.slice(0, 8)}…${run.run_id.slice(-4)}`
  return (
    <div className="flex items-start justify-between gap-4 flex-wrap">
      <div className="flex items-center gap-2 min-w-0">
        {run.framework && (
          <span className="inline-flex shrink-0 items-center gap-1.5 px-2 h-6 rounded-full border bg-card text-[11px] text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full border border-current" />
            {run.framework}
            {run.framework_version && (
              <span className="font-mono">{run.framework_version}</span>
            )}
          </span>
        )}
      </div>
      <div className="flex items-center gap-4 text-[12px] text-muted-foreground tabular-nums">
        <span className="inline-flex items-center gap-1 font-mono">
          {runShort}
          <CopyButton text={run.run_id} />
        </span>
        {branch && (
          <span className="inline-flex items-center gap-1 font-mono">
            <GitBranch className="h-3 w-3" />
            {branch}
            {sha && <span className="text-muted-foreground/70">@{sha}</span>}
          </span>
        )}
        <span>
          <span className="text-muted-foreground/70">dur</span>{' '}
          <span className="text-foreground">{formatDuration(run.duration_ms)}</span>
        </span>
        <span className="text-muted-foreground/70">·</span>
        <span>{formatDate(run.started_at)}</span>
        {run.ci?.run_url && (
          <a
            href={String(run.ci.run_url)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-link hover:underline"
          >
            CI <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
    </div>
  )
}
