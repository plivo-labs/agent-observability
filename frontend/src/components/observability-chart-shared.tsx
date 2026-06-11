import { Fragment, useId } from 'react'
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

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
    <div className="rounded-none border border-foreground bg-card p-3 text-[12px] font-mono shadow-none">
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

// ── Time-series card ────────────────────────────────────────────────────────
//
// The standard bucketed-stats chart used by the agent Overview tab and the
// fleet /analytics page: one metric over `bucket_start` time buckets with
// the dashboard's shared grid/axis/tooltip styling. Keeping it here means
// new stats pages don't re-copy ~40 lines of recharts boilerplate per chart.

const TS_TOOLTIP_STYLE = {
  background: 'var(--background)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  fontSize: 12,
} as const

export interface TimeSeriesCardProps {
  title: string
  /** Bucketed rows — anything with a `bucket_start` field plus the dataKey. */
  data: object[]
  dataKey: string
  kind: 'bar' | 'line' | 'area'
  color: string
  xTickFormatter: (iso: string) => string
  yTickFormatter?: (v: number) => string
  /** Tooltip value renderer + label, e.g. (v) => `${v} ms` / 'p95'. */
  valueFormatter?: (v: number) => string
  valueLabel?: string
  yUnit?: string
  allowDecimals?: boolean
  connectNulls?: boolean
  height?: number
}

export const TimeSeriesCard = ({
  title,
  data,
  dataKey,
  kind,
  color,
  xTickFormatter,
  yTickFormatter,
  valueFormatter,
  valueLabel,
  yUnit,
  allowDecimals = true,
  connectNulls = false,
  height = 220,
}: TimeSeriesCardProps) => {
  const gradientId = useId()

  const axes = (
    <>
      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
      <XAxis
        dataKey="bucket_start"
        tickFormatter={xTickFormatter}
        stroke="var(--muted-foreground)"
        fontSize={11}
      />
      <YAxis
        allowDecimals={allowDecimals}
        tickFormatter={yTickFormatter}
        unit={yUnit}
        stroke="var(--muted-foreground)"
        fontSize={11}
      />
      <Tooltip
        labelFormatter={(iso) => new Date(iso as string).toLocaleString()}
        formatter={
          valueFormatter
            ? (v) => [valueFormatter(Number(v)), valueLabel ?? title]
            : undefined
        }
        contentStyle={TS_TOOLTIP_STYLE}
      />
    </>
  )

  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
      </CardHeader>
      <CardContent className="pt-2">
        <ResponsiveContainer width="100%" height={height}>
          {kind === 'bar' ? (
            <BarChart data={data}>
              {axes}
              <Bar dataKey={dataKey} fill={color} radius={[3, 3, 0, 0]} />
            </BarChart>
          ) : kind === 'line' ? (
            <LineChart data={data}>
              {axes}
              <Line
                type="monotone"
                dataKey={dataKey}
                stroke={color}
                dot={false}
                strokeWidth={2}
                connectNulls={connectNulls}
              />
            </LineChart>
          ) : (
            <AreaChart data={data}>
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              {axes}
              <Area
                type="monotone"
                dataKey={dataKey}
                stroke={color}
                fill={`url(#${gradientId})`}
                strokeWidth={2}
              />
            </AreaChart>
          )}
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
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
