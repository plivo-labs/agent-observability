import { Fragment } from 'react'
import { ResponsiveContainer } from 'recharts'

interface TooltipRow {
  label: string
  value: string
  color?: string
}

export const ChartTooltipShell = ({
  active,
  label,
  rows,
}: {
  active?: boolean
  label?: string | number
  rows: TooltipRow[]
}) => {
  if (!active || !rows.length) return null
  return (
    <div className="rounded-md border border-border bg-popover p-3 text-s-400 shadow-md">
      <p className="font-medium mb-1">Turn {label}</p>
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        {rows.map((r) => (
          <Fragment key={r.label}>
            <span
              className="text-muted-foreground"
              style={r.color ? { color: r.color } : undefined}
            >
              {r.label}
            </span>
            <span>{r.value}</span>
          </Fragment>
        ))}
      </div>
    </div>
  )
}

export const ChartLegendItem = ({ color, label }: { color: string; label: string }) => {
  return (
    <span className="ao-legend-item">
      <span className="sw" style={{ background: color }} />
      {label}
    </span>
  )
}

interface LegendEntry {
  color: string
  label: string
}

/**
 * Framed chart surface in the shared "mission-control" telemetry language.
 * Keeps the original public API (title / subtitle / legend / chartHeight /
 * children) so every chart component renders unchanged, but renders through
 * the `ao-chart` frame: header with title + inline legend, and a plot body
 * whose recharts grid/axes/tooltip are auto-themed to tokens. The legend now
 * sits in the header (mission-control convention) instead of below the plot.
 */
export const ChartCard = ({
  title,
  subtitle,
  legend,
  chartHeight = 'h-64',
  children,
}: {
  title: string
  subtitle?: string
  legend: LegendEntry[]
  chartHeight?: string
  children: React.ReactNode
}) => {
  return (
    <div className="ao-chart">
      <div className="ao-chart-head">
        <div>
          <div className="ao-chart-title">{title}</div>
          {subtitle && <div className="ao-chart-sub">{subtitle}</div>}
        </div>
        {legend.length > 0 && (
          <div className="ao-chart-legend">
            {legend.map((l) => (
              <ChartLegendItem key={l.label} color={l.color} label={l.label} />
            ))}
          </div>
        )}
      </div>
      <div className={`ao-chart-body ${chartHeight}`}>
        <ResponsiveContainer width="100%" height="100%">
          {children as React.ReactElement}
        </ResponsiveContainer>
      </div>
    </div>
  )
}
