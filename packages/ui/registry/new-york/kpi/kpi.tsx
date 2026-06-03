/**
 * Shared KPI primitives: the eval-kpi tile + the Sparkline used inside
 * it. Render on the agent-detail tabs (Sessions, Simulation Evals,
 * Conversation Evals) plus the standalone runs page. Styles live in
 * `styles/observability.css` under the `.eval-kpi-*` selectors so the
 * visual language stays consistent.
 */

interface SparklineProps {
  values: number[]
  color?: string
  width?: number
  height?: number
}

export function Sparkline({
  values,
  color = 'hsl(var(--accent-purple))',
  width = 80,
  height = 26,
}: SparklineProps) {
  if (!values || values.length < 2) return <svg width={width} height={height} />
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const dx = width / (values.length - 1)
  const pts = values.map((v, i): [number, number] => [
    i * dx,
    height - 2 - ((v - min) / range) * (height - 4),
  ])
  const path = pts
    .map(([x, y], i) => (i === 0 ? `M${x},${y}` : `L${x},${y}`))
    .join(' ')
  const area = path + ` L${width},${height} L0,${height} Z`
  return (
    <svg width={width} height={height}>
      <path d={area} fill={color} opacity={0.12} />
      <path d={path} fill="none" stroke={color} strokeWidth="1.5" />
      <circle
        cx={pts[pts.length - 1][0]}
        cy={pts[pts.length - 1][1]}
        r="2"
        fill={color}
      />
    </svg>
  )
}

interface KpiTileProps {
  label: string
  value: string
  unit?: string
  sub?: string
  /** Time-series for the sparkline. Drawn at the bottom-right of the
   *  tile. Hidden when fewer than 2 datapoints. */
  sparkValues?: number[]
  sparkColor?: string
  /** Single-bar fill (0..100). Used for things like pass-rate. */
  barPct?: number
  barVariant?: 'default' | 'pass' | 'fail' | 'warn'
}

export function KpiTile({
  label,
  value,
  unit,
  sub,
  sparkValues,
  sparkColor,
  barPct,
  barVariant,
}: KpiTileProps) {
  return (
    <div className="eval-kpi">
      <div className="eval-kpi__label">{label}</div>
      <div className="eval-kpi__value">
        {value}
        {unit && <span className="unit">{unit}</span>}
      </div>
      {sub && <div className="eval-kpi__delta">{sub}</div>}
      {sparkValues && sparkValues.length >= 2 && (
        <div className="eval-kpi__spark">
          <Sparkline
            values={sparkValues}
            color={sparkColor || 'hsl(var(--accent-purple))'}
            width={80}
            height={26}
          />
        </div>
      )}
      {barPct != null && (
        <div className={`eval-kpi__bar eval-kpi__bar--${barVariant || 'default'}`}>
          <span
            style={{ width: `${Math.max(0, Math.min(100, barPct))}%` }}
          />
        </div>
      )}
    </div>
  )
}
