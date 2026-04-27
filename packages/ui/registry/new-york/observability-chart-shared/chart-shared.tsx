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
    <div className="rounded-lg border bg-background p-3 text-s-400 shadow-md">
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
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  )
}

interface LegendEntry {
  color: string
  label: string
}

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
    <div className="rounded-lg border bg-card p-5">
      <span className="text-p-400 font-medium">{title}</span>
      {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      <div className={`mt-3 ${chartHeight}`}>
        <ResponsiveContainer width="100%" height="100%">
          {children as React.ReactElement}
        </ResponsiveContainer>
      </div>
      {legend.length > 0 && (
        <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
          {legend.map((l) => (
            <ChartLegendItem key={l.label} color={l.color} label={l.label} />
          ))}
        </div>
      )}
    </div>
  )
}
