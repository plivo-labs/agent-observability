import { useMemo, useState } from 'react'
import { Bot, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatDate, formatMs } from '@/lib/observability-format'
import { useEvalAgents } from '@/lib/observability-hooks'
import type { AgentRow } from '@/lib/observability-types'

const UNKNOWN_AGENT_ID = '__unknown__'

function TrendDots({ trend }: { trend: AgentRow['trend'] }) {
	const ordered = [...trend].reverse()
	return (
		<span className="eval-trend-dots">
			{ordered.map((t) => {
				const cls =
					t.pass_rate >= 70 ? 'dot--pass' : t.pass_rate >= 50 ? 'dot--warn' : 'dot--fail'
				return (
					<span
						key={t.run_id}
						className={`dot ${cls}`}
						title={`${Math.round(t.pass_rate)}%`}
					/>
				)
			})}
		</span>
	)
}

function PassRateCell({ rate, prevRate }: { rate: number; prevRate?: number }) {
	const pct = Math.round(rate)
	const tone = pct >= 70 ? 'good' : pct >= 50 ? 'warn' : 'bad'
	const delta = prevRate != null ? rate - prevRate : null
	return (
		<div className="flex items-center gap-2">
			<div className="eval-passrate">
				<span className={`eval-passrate__value eval-passrate__value--${tone}`}>{pct}%</span>
				<span className="eval-passrate__track">
					<span
						className={`eval-passrate__bar eval-passrate__bar--${tone}`}
						style={{ width: `${pct}%` }}
					/>
				</span>
			</div>
			{delta != null && Math.abs(delta) > 0.5 && (
				<span
					className="font-mono text-[11px]"
					style={{
						color:
							delta > 0
								? 'hsl(var(--success-fg, 142 70% 28%))'
								: 'hsl(var(--destructive))',
					}}
				>
					{delta > 0 ? '▲' : '▼'}
					{Math.abs(delta).toFixed(0)}
				</span>
			)}
		</div>
	)
}

function KpiTile({
	label,
	value,
	unit,
	subtitle,
	subtitleTone,
}: {
	label: string
	value: string
	unit?: string
	subtitle?: string
	subtitleTone?: 'good' | 'bad' | 'muted'
}) {
	const toneColor =
		subtitleTone === 'good'
			? 'hsl(var(--success-fg, 142 70% 28%))'
			: subtitleTone === 'bad'
				? 'hsl(var(--destructive))'
				: 'hsl(var(--muted-foreground))'
	return (
		<div className="eval-kpi">
			<div className="eval-kpi__label">{label}</div>
			<div className="eval-kpi__value">
				{value}
				{unit && <span className="unit">{unit}</span>}
			</div>
			{subtitle && (
				<div
					className="font-mono text-[11px] mt-1"
					style={{ color: toneColor }}
				>
					{subtitle}
				</div>
			)}
		</div>
	)
}

function FrameworkPill({
	options,
	active,
	onChange,
}: {
	options: string[]
	active: string
	onChange: (v: string) => void
}) {
	const items = ['all', ...options]
	return (
		<div className="inline-flex h-8 items-center rounded-md border bg-card p-0.5 text-[12px]">
			{items.map((it) => (
				<button
					key={it}
					type="button"
					onClick={() => onChange(it)}
					className={cn(
						'px-3 h-full rounded-[5px] transition capitalize',
						active === it
							? 'bg-foreground text-background font-medium'
							: 'text-muted-foreground hover:text-foreground',
					)}
				>
					{it}
				</button>
			))}
		</div>
	)
}

export const AgentsPage = ({
	onAgentClick,
}: {
	onAgentClick?: (agentId: string) => void
}) => {
	const { agents, stats: runStats, loading, error } = useEvalAgents()
	const [search, setSearch] = useState('')
	const [frameworkFilter, setFrameworkFilter] = useState('all')

	const frameworkOptions = useMemo(
		() => [...new Set(agents.map((a) => a.framework).filter(Boolean) as string[])],
		[agents],
	)

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase()
		return agents.filter((a) => {
			if (frameworkFilter !== 'all' && a.framework !== frameworkFilter) return false
			if (q && !(a.agent_id ?? '').toLowerCase().includes(q)) return false
			return true
		})
	}, [agents, search, frameworkFilter])

	const stats = useMemo(() => {
		const totalRuns = agents.reduce((s, a) => s + a.run_count, 0)
		const p95Values = agents.map((a) => a.ttft_p95_ms).filter((v): v is number => v != null)
		const avgP95 = p95Values.length
			? p95Values.reduce((s, v) => s + v, 0) / p95Values.length
			: null

		// Regressions: agents whose latest run pass_rate dropped >5pts vs prior run.
		// `trend` is newest-first.
		const REGRESSION_THRESHOLD = 5
		let regressions = 0
		for (const a of agents) {
			if (a.trend.length < 2) continue
			const delta = a.trend[0].pass_rate - a.trend[1].pass_rate
			if (delta < -REGRESSION_THRESHOLD) regressions++
		}

		return { totalRuns, avgP95, regressions }
	}, [agents])

	const runs24h = runStats?.runs_24h ?? 0
	const runsPrev24h = runStats?.runs_prev_24h ?? 0
	const runsDelta = runs24h - runsPrev24h

	const headers: { k: string; label: string; cls?: string }[] = [
		{ k: 'agent', label: 'Agent' },
		{ k: 'last', label: 'Last run' },
		{ k: 'trend', label: 'Trend' },
		{ k: 'pass', label: 'Pass rate' },
		{ k: 'ttft', label: 'p95 TTFT' },
		{ k: 'runs', label: 'Runs' },
		{ k: 'fw', label: 'Framework' },
		{ k: 'chev', label: '' },
	]

	return (
		<div className="w-full p-6 flex flex-col gap-4 min-w-0">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-h2-600 font-semibold m-0">Evals</h1>
					<div className="text-s-400 text-muted-foreground">
						{agents.length} agents under test · {stats.totalRuns} runs
					</div>
				</div>
			</div>

			<div className="eval-kpi-grid">
				<KpiTile label="Agents" value={agents.length.toString()} />
				<KpiTile
					label="Runs (24h)"
					value={runs24h.toString()}
					subtitle={
						runStats == null
							? undefined
							: runsDelta === 0
								? `→ vs prior 24h`
								: `${runsDelta > 0 ? '▲' : '▼'}${Math.abs(runsDelta)} vs prior 24h`
					}
					subtitleTone={
						runsDelta > 0 ? 'good' : runsDelta < 0 ? 'bad' : 'muted'
					}
				/>
				<KpiTile
					label="Regressions"
					value={stats.regressions.toString()}
					subtitle={
						agents.length
							? `agents ▼>5pts vs prior run`
							: undefined
					}
					subtitleTone={stats.regressions > 0 ? 'bad' : 'muted'}
				/>
				<KpiTile
					label="p95 TTFT"
					value={stats.avgP95 != null ? formatMs(stats.avgP95) : '—'}
				/>
			</div>

			{error && (
				<div
					role="alert"
					className="border border-border bg-muted text-foreground px-4 py-2.5 rounded-lg text-s-400"
				>
					Failed to load agents: {error}
				</div>
			)}

			<div>
				<div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
					<h2 className="text-[14px] font-semibold tracking-tight">
						Agents{' '}
						<span className="text-muted-foreground font-normal text-[12px]">
							({filtered.length} of {agents.length})
						</span>
					</h2>
					<div className="flex items-center gap-2">
						<input
							type="text"
							placeholder="Search name…"
							value={search}
							onChange={(e) => setSearch(e.target.value)}
							className="h-8 w-56 rounded-md border border-border bg-card px-3 text-[12px] outline-none focus:ring-1 focus:ring-ring"
						/>
						{frameworkOptions.length > 0 && (
							<FrameworkPill
								options={frameworkOptions}
								active={frameworkFilter}
								onChange={setFrameworkFilter}
							/>
						)}
					</div>
				</div>

				<div className="rounded-lg border bg-card overflow-hidden">
					<table className="w-full text-[12px] border-collapse">
						<thead>
							<tr className="text-muted-foreground">
								{headers.map((h) => (
									<th
										key={h.k}
										className={cn(
											'h-9 px-3.5 text-[10px] font-semibold tracking-[0.12em] uppercase border-b border-border bg-card whitespace-nowrap',
											h.cls ?? 'text-left',
										)}
									>
										{h.label}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{loading && (
								<tr>
									<td
										colSpan={headers.length}
										className="px-4 py-10 text-center text-muted-foreground"
									>
										Loading agents…
									</td>
								</tr>
							)}
							{!loading &&
								filtered.map((a) => {
									const agentId = a.agent_id ?? UNKNOWN_AGENT_ID
									return (
										<tr
											key={agentId}
											onClick={() => onAgentClick?.(agentId)}
											className="cursor-pointer transition-colors hover:bg-muted/40"
										>
											<td className="h-10 px-3.5 border-b border-border">
												<span className="inline-flex items-center gap-2 font-mono font-medium text-[12.5px]">
													<Bot
														size={14}
														color="hsl(var(--muted-foreground))"
														className="shrink-0"
													/>
													{a.agent_id ?? (
														<em className="text-muted-foreground">unknown</em>
													)}
												</span>
											</td>
											<td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-muted-foreground">
												{formatDate(a.last_run_at)}
											</td>
											<td className="h-10 px-3.5 border-b border-border">
												{a.trend.length ? (
													<TrendDots trend={a.trend} />
												) : (
													<span className="text-muted-foreground">—</span>
												)}
											</td>
											<td className="h-10 px-3.5 border-b border-border">
												<PassRateCell rate={a.avg_pass_rate} prevRate={a.last_pass_rate} />
											</td>
											<td
												className={cn(
													'h-10 px-3.5 border-b border-border font-mono tabular-nums',
													a.ttft_p95_ms != null && a.ttft_p95_ms > 10000
														? 'text-[hsl(var(--destructive))]'
														: 'text-foreground/85',
												)}
											>
												{a.ttft_p95_ms != null ? formatMs(a.ttft_p95_ms) : '—'}
											</td>
											<td className="h-10 px-3.5 border-b border-border font-mono tabular-nums text-foreground/85">
												{a.run_count}
											</td>
											<td className="h-10 px-3.5 border-b border-border">
												{a.framework ? (
													<span className="eval-fw-pill">
														<Bot size={10} />
														{a.framework}
													</span>
												) : (
													<span className="text-muted-foreground">—</span>
												)}
											</td>
											<td className="h-10 px-3.5 border-b border-border text-muted-foreground/60 w-6">
												<ChevronRight size={14} />
											</td>
										</tr>
									)
								})}
							{!loading && filtered.length === 0 && (
								<tr>
									<td
										colSpan={headers.length}
										className="px-4 py-10 text-center text-muted-foreground"
									>
										No agents match.
									</td>
								</tr>
							)}
						</tbody>
					</table>
				</div>
			</div>

		</div>
	)
}
