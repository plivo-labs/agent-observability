import { AlertTriangle, Check, ChevronRight, X } from "lucide-react";
import type * as React from "react";
import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDuration, formatMs } from "@/lib/observability-format";
import { useEvalCase } from "@/lib/observability-hooks";
import type {
	JudgmentResult,
	RunEvent,
	RunEventAgentHandoff,
	RunEventFunctionCall,
	RunEventFunctionCallOutput,
	RunEventMessage,
} from "@/lib/observability-types";
import { cn } from "@/lib/utils";

interface MetricsSummary {
	turnsWithMetrics: number;
	avgTtftMs: number | null;
	avgTtfbMs: number | null;
}

function computeCaseMetrics(events: RunEvent[]): MetricsSummary {
	const ttfts: number[] = [];
	const ttfbs: number[] = [];
	let turns = 0;
	for (const ev of events) {
		if (ev.type !== "message") continue;
		const metrics = (ev as RunEventMessage).metrics;
		if (!metrics) continue;
		turns += 1;
		const ttft = metrics.llm_node_ttft;
		if (typeof ttft === "number") ttfts.push(ttft * 1000);
		const ttfb = metrics.llm_node_ttfb;
		if (typeof ttfb === "number") ttfbs.push(ttfb * 1000);
	}
	return {
		turnsWithMetrics: turns,
		avgTtftMs: ttfts.length
			? ttfts.reduce((a, b) => a + b, 0) / ttfts.length
			: null,
		avgTtfbMs: ttfbs.length
			? ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length
			: null,
	};
}

// ── Verdict ──────────────────────────────────────────────────────────────────

function pickPrimaryJudgment(
	judgments: JudgmentResult[],
): JudgmentResult | null {
	if (judgments.length === 0) return null;
	return judgments.find((j) => j.verdict === "fail") ?? judgments[0];
}

function trimReasoning(text: string): string {
	// Strip the trailing "Context around failure:" event dump — the transcript
	// section already shows the events in a readable form.
	const idx = text.search(/\n\s*Context around failure:/i);
	return (idx >= 0 ? text.slice(0, idx) : text).trim();
}

function removeRubricPrefix(reasoning: string, rubric?: string): string {
	if (!rubric) return reasoning;
	const normalizedReasoning = reasoning.replace(/\r\n/g, "\n").trim();
	const normalizedRubric = rubric.replace(/\r\n/g, "\n").trim();
	const extractEvaluation = (text: string): string => {
		const lastTheReply = text.toLowerCase().lastIndexOf("the reply ");
		if (lastTheReply >= 0) return text.slice(lastTheReply).trim();
		const fullTail = text.match(/(?:^|\n)\s*The reply\b[\s\S]*$/i);
		if (fullTail) return fullTail[0].trim();
		const paragraphs = text
			.split(/\n{2,}/)
			.map((p) => p.trim())
			.filter(Boolean);
		const candidates = paragraphs.filter((p) => /^The reply\b/i.test(p));
		return candidates.length > 0 ? candidates[candidates.length - 1] : text;
	};
	if (!normalizedRubric) return extractEvaluation(normalizedReasoning);
	if (!normalizedReasoning.startsWith(normalizedRubric)) {
		return extractEvaluation(normalizedReasoning);
	}
	const stripped = normalizedReasoning.slice(normalizedRubric.length).trim();
	return extractEvaluation(stripped);
}

function VerdictBanner({ judgment }: { judgment: JudgmentResult }) {
	const extras = judgment as JudgmentResult & {
		name?: string;
		score?: number;
		threshold?: number;
	};
	const failed = judgment.verdict === "fail";
	const passed = judgment.verdict === "pass";
	const reasoning = judgment.reasoning
		? removeRubricPrefix(trimReasoning(judgment.reasoning), judgment.intent)
		: "";
	const headerLabel = extras.name;
	const showScoreBadge = extras.score !== undefined;
	const showIntentBlock = !extras.name && !!judgment.intent;
	return (
		<div
			className={cn(
				"rounded-md border px-3 py-2.5",
				failed &&
					"border-rose-200 bg-rose-50/60 dark:border-rose-900/40 dark:bg-rose-950/30",
				passed &&
					"border-emerald-200 bg-emerald-50/60 dark:border-emerald-900/40 dark:bg-emerald-950/30",
				!failed && !passed && "border-border bg-muted/40",
			)}
		>
			<div className="flex items-start gap-2.5">
				<div
					className={cn(
						"flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xxs-600",
						failed &&
							"bg-rose-200 text-rose-900 dark:bg-rose-900/60 dark:text-rose-100",
						passed &&
							"bg-emerald-200 text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-100",
						!failed && !passed && "bg-muted text-muted-foreground",
					)}
				>
					{failed ? (
						<AlertTriangle className="h-3 w-3" />
					) : (
						<Check className="h-3 w-3" />
					)}
				</div>
				<div className="min-w-0 flex-1">
					<div className="flex items-center gap-2 text-s-600 text-foreground">
						<span>
							{headerLabel
								? headerLabel
								: failed
									? "Judge failed"
									: passed
										? "Judge passed"
										: `verdict: ${judgment.verdict}`}
						</span>
						{showScoreBadge && (
							<span
								className={cn(
									"inline-flex items-center rounded px-1.5 py-0.5 text-xxs-600 font-mono",
									failed
										? "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200"
										: passed
											? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200"
											: "bg-muted text-muted-foreground",
								)}
							>
								{extras.score!.toFixed(2)}
								{extras.threshold !== undefined
									? ` / ${extras.threshold.toFixed(2)}`
									: ""}
							</span>
						)}
					</div>
					{reasoning && (
						<div className="mt-1 text-s-400 text-foreground whitespace-pre-wrap">
							{reasoning}
						</div>
					)}
					{showIntentBlock && (
						<details className="mt-2 text-xxs-400 text-muted-foreground">
							<summary className="cursor-pointer hover:text-foreground select-none">
								Rubric
							</summary>
							<div className="mt-1 whitespace-pre-wrap">{judgment.intent}</div>
						</details>
					)}
				</div>
			</div>
		</div>
	);
}

// ── Event rows ───────────────────────────────────────────────────────────────

// Extract trailing "Sources: path:Lx-Ly[, ...]" line from message content into
// clickable chips. Returns the stripped body and parsed source refs.
function extractSources(text: string): { body: string; sources: string[] } {
	const re = /\n+\s*Sources?:\s*([^\n]+)\s*$/i;
	const m = text.match(re);
	if (!m) return { body: text, sources: [] };
	const sources = m[1]
		.split(/\s*[,;]\s*/)
		.map((s) => s.trim())
		.filter(Boolean);
	return { body: text.slice(0, m.index).trimEnd(), sources };
}

// Tiny inline markdown: **bold**, *italic*, `code`. Returns React nodes.
function renderInline(text: string): React.ReactNode[] {
	const tokens: React.ReactNode[] = [];
	const re = /(\*\*([^*\n]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`)/g;
	let last = 0;
	let m: RegExpExecArray | null;
	let key = 0;
	while ((m = re.exec(text)) !== null) {
		if (m.index > last) tokens.push(text.slice(last, m.index));
		if (m[2] != null)
			tokens.push(
				<strong key={key++} className="font-semibold text-foreground">
					{m[2]}
				</strong>,
			);
		else if (m[3] != null)
			tokens.push(
				<em key={key++} className="italic">
					{m[3]}
				</em>,
			);
		else if (m[4] != null)
			tokens.push(
				<code key={key++} className="px-1 py-0.5 rounded bg-muted font-mono">
					{m[4]}
				</code>,
			);
		last = m.index + m[0].length;
	}
	if (last < text.length) tokens.push(text.slice(last));
	return tokens;
}

function MarkdownBody({ text }: { text: string }) {
	const paragraphs = text.split(/\n{2,}/);
	return (
		<>
			{paragraphs.map((p, i) => (
				<p key={i} className={cn("whitespace-pre-wrap", i > 0 && "mt-2")}>
					{renderInline(p)}
				</p>
			))}
		</>
	);
}

// Timeline rail layout — every event sits on a vertical rail with a marker
// at row top, kind badge inline with optional preview, and content below.

type Tone = "muted" | "sky" | "violet" | "rose" | "ink";

const TONE_BG: Record<Tone, string> = {
	muted: "bg-muted-foreground/60",
	sky: "bg-sky-500",
	violet: "bg-violet-500",
	rose: "bg-rose-500",
	ink: "bg-foreground",
};

const TONE_TEXT: Record<Tone, string> = {
	muted: "text-muted-foreground",
	sky: "text-sky-700 dark:text-sky-300",
	violet: "text-violet-700 dark:text-violet-300",
	rose: "text-rose-700 dark:text-rose-400",
	ink: "text-foreground",
};

function Marker({
	tone,
	shape = "dot",
}: {
	tone: Tone;
	shape?: "dot" | "diamond" | "ring";
}) {
	return (
		<span
			aria-hidden
			className={cn(
				"absolute left-[6px] top-[7px] z-[1]",
				shape === "diamond" && "w-[9px] h-[9px] rotate-45",
				shape === "dot" && "w-[9px] h-[9px] rounded-full",
				shape === "ring" &&
					"w-[9px] h-[9px] rounded-full border-2 border-current bg-background",
				shape !== "ring" && TONE_BG[tone],
				shape === "ring" && TONE_TEXT[tone],
				"ring-2 ring-background",
			)}
		/>
	);
}

function KindBadge({
	children,
	tone,
}: {
	children: React.ReactNode;
	tone: Tone;
}) {
	return (
		<span
			className={cn(
				"capitalize font-medium select-none shrink-0",
				TONE_TEXT[tone],
			)}
		>
			{children}
		</span>
	);
}

// Each row sits on the rail: marker absolute on the left, content with pl-7.
const ROW = "relative pl-7";

function MessageRow({ event }: { event: RunEventMessage }) {
	const isAssistant = (event.role ?? "assistant") !== "user";
	const ttft = event.metrics?.llm_node_ttft;
	const ttftMs = typeof ttft === "number" ? Math.round(ttft * 1000) : null;
	const raw = event.content ?? "";
	const { body, sources } = isAssistant
		? extractSources(raw)
		: { body: raw, sources: [] };
	const tone: Tone = isAssistant ? "violet" : "ink";
	return (
		<div className={ROW}>
			<Marker tone={tone} />
			<div className="flex items-center gap-2 min-h-[20px]">
				<KindBadge tone={tone}>{event.role ?? "assistant"}</KindBadge>
				{event.interrupted && (
					<Badge
						variant="outline"
						className="text-xxs-600 text-foreground border-border"
					>
						interrupted
					</Badge>
				)}
				{ttftMs != null && (
					<span className="ml-auto font-mono text-xxs-400 tabular-nums text-muted-foreground">
						{ttftMs}ms
					</span>
				)}
			</div>
			<div className="mt-1 text-s-400 text-foreground min-w-0">
				<MarkdownBody text={body} />
			</div>
			{sources.length > 0 && (
				<div className="mt-2 flex flex-wrap items-center gap-1.5">
					{sources.map((s, i) => (
						<button
							key={i}
							type="button"
							className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded border border-border bg-background hover:border-foreground/40 hover:bg-muted transition-colors font-mono text-xxs-400 text-foreground cursor-pointer"
							onClick={() => navigator.clipboard?.writeText(s)}
							title="Copy source path"
						>
							<span className="text-muted-foreground">↗</span>
							{s}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

function ToolCallRow({ event }: { event: RunEventFunctionCall }) {
	const argsStr =
		typeof event.arguments === "string"
			? event.arguments
			: event.arguments == null
				? ""
				: JSON.stringify(event.arguments);
	const argsPretty =
		typeof event.arguments === "object" && event.arguments != null
			? JSON.stringify(event.arguments, null, 2)
			: argsStr;
	const argsEmpty =
		argsStr.trim() === "" ||
		argsStr.trim() === "{}" ||
		argsStr.trim() === "null";
	return (
		<Collapsible className={ROW}>
			<Marker tone="muted" shape="ring" />
			<CollapsibleTrigger className="group flex items-center gap-2 text-left cursor-pointer min-h-[20px] hover:[&_.preview]:text-foreground">
				<KindBadge tone="muted">tool call</KindBadge>
				<span className="font-mono text-xs-600 text-foreground shrink-0">
					{event.name ?? "unknown"}
				</span>

				<ChevronRight className="ml-auto h-3 w-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="mt-1.5">
					{argsEmpty ? (
						<div className="text-xs-400 italic text-muted-foreground">
							No arguments recorded.
						</div>
					) : (
						<pre className="bg-muted/50 rounded-md px-3 py-2 text-xs-400 font-mono whitespace-pre overflow-x-auto border">
							{argsPretty}
						</pre>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

function ToolResultRow({ event }: { event: RunEventFunctionCallOutput }) {
	const out = event.output == null ? "" : String(event.output);
	const outEmpty = out.trim() === "";
	const tone: Tone = event.is_error ? "rose" : "muted";
	return (
		<Collapsible className={ROW}>
			<Marker tone={tone} shape={event.is_error ? "dot" : "ring"} />
			<CollapsibleTrigger className="group flex items-center gap-2 text-left cursor-pointer min-h-[20px]">
				<KindBadge tone={tone}>tool result</KindBadge>
				{event.is_error && (
					<Badge
						variant="outline"
						className="text-xxs-600 text-rose-700 border-rose-300 shrink-0"
					>
						error
					</Badge>
				)}
				<span
					className={cn(
						"font-mono text-xxs-400 truncate",
						event.is_error
							? "text-rose-700 dark:text-rose-300"
							: "text-muted-foreground",
					)}
				></span>
				<ChevronRight className="ml-auto h-3 w-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
			</CollapsibleTrigger>
			<CollapsibleContent>
				<div className="mt-1.5">
					{outEmpty ? (
						<div className="text-s-400 italic text-muted-foreground">
							No output recorded.
						</div>
					) : (
						<div className="bg-muted/50 rounded-md px-3 py-2 text-s-400 font-mono whitespace-pre-wrap break-words border">
							{out}
						</div>
					)}
				</div>
			</CollapsibleContent>
		</Collapsible>
	);
}

function HandoffRow({ event }: { event: RunEventAgentHandoff }) {
	return (
		<div className={ROW}>
			<Marker tone="sky" shape="diamond" />
			<div className="flex items-center gap-2 min-h-[20px]">
				<KindBadge tone="sky">handoff</KindBadge>
				<span className="font-mono text-xs-600 text-foreground">
					{event.from_agent ?? "?"}
				</span>
				<span className="font-mono text-xs-600 text-sky-700 dark:text-sky-400">
					→
				</span>
				<span className="font-mono text-xs-600 text-foreground">
					{event.to_agent ?? "?"}
				</span>
			</div>
		</div>
	);
}

function EventRow({ event }: { event: RunEvent }) {
	if (event.type === "message") return <MessageRow event={event} />;
	if (event.type === "function_call") return <ToolCallRow event={event} />;
	if (event.type === "function_call_output")
		return <ToolResultRow event={event} />;
	if (event.type === "agent_handoff") return <HandoffRow event={event} />;
	return null;
}

// ── Page ─────────────────────────────────────────────────────────────────────

function formatTokensInline(tokens: number): string {
	if (tokens <= 0) return "—";
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return tokens.toString();
}

function formatCostInline(cost: number | null): string {
	return cost == null ? "—" : `$${cost.toFixed(cost < 0.01 ? 4 : 2)}`;
}

export const EvalCaseDetailPage = ({
	runId,
	caseId,
	onBack,
}: {
	runId: string;
	caseId: string;
	onBack?: () => void;
}) => {
	const { evalCase, loading, error } = useEvalCase(runId, caseId);
	const summary = useMemo(
		() => (evalCase ? computeCaseMetrics(evalCase.events) : null),
		[evalCase],
	);
	const primaryJudgment = useMemo(
		() => (evalCase ? pickPrimaryJudgment(evalCase.judgments) : null),
		[evalCase],
	);
	const userTurnCount = useMemo(() => {
		if (!evalCase) return 0;
		return evalCase.events.reduce(
			(n, ev) =>
				ev.type === "message" && (ev as RunEventMessage).role === "user"
					? n + 1
					: n,
			0,
		);
	}, [evalCase]);
	const showUserInputHero = !!evalCase?.user_input && userTurnCount <= 1;

	if (loading) {
		return (
			<div className="flex flex-col gap-3.5 p-[18px_22px]" aria-busy="true">
				<Skeleton className="h-5 w-48" />
				<Skeleton className="h-4 w-64" />
				<Skeleton className="h-9 w-full" />
				<Skeleton className="h-16 w-full" />
				<Skeleton className="h-40 w-full" />
			</div>
		);
	}

	if (error || !evalCase) {
		return (
			<div className="p-12 text-center text-foreground">
				<p>Failed to load case: {error ?? "not found"}</p>
			</div>
		);
	}

	return (
		<>
			<div className="sticky top-0 z-10 bg-background border-b">
				<div className="flex items-start justify-between gap-2 px-[18px] pt-3 pb-2.5">
					<div className="flex flex-col gap-1.5 min-w-0 flex-1">
						<div className="flex items-center gap-2 flex-wrap">
							<span className="font-mono text-s-600 font-medium break-all">
								{evalCase.name}
							</span>
						</div>
						<div className="font-mono text-xxs-400 text-muted-foreground flex flex-wrap items-center gap-x-1.5">
							<span className="text-muted-foreground/70">dur</span>
							<span>{formatDuration(evalCase.duration_ms)}</span>
							<span className="text-muted-foreground/50">·</span>
							<span className="text-muted-foreground/70">events</span>
							<span>{evalCase.events.length}</span>
							{summary?.avgTtftMs != null && (
								<>
									<span className="text-muted-foreground/50">·</span>
									<span className="text-muted-foreground/70">TTFT</span>
									<span>{formatMs(summary.avgTtftMs)}</span>
								</>
							)}
							{evalCase.total_tokens > 0 && (
								<>
									<span className="text-muted-foreground/50">·</span>
									<span className="text-muted-foreground/70">tokens</span>
									<span>{formatTokensInline(evalCase.total_tokens)}</span>
								</>
							)}
							{evalCase.estimated_cost_usd != null && (
								<>
									<span className="text-muted-foreground/50">·</span>
									<span className="text-muted-foreground/70">cost</span>
									<span>{formatCostInline(evalCase.estimated_cost_usd)}</span>
								</>
							)}
						</div>
					</div>
					<Button
						variant="ghost"
						size="icon"
						className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
						onClick={onBack}
						aria-label="Close"
					>
						<X className="h-3.5 w-3.5" />
					</Button>
				</div>
			</div>

			<div className="px-[18px] py-4 pb-8 flex flex-col gap-5">
				{showUserInputHero && evalCase.user_input && (
					<div className="relative">
						<div className="absolute left-0 top-0 bottom-0 w-[3px] rounded-full bg-foreground/80" />
						<div className="pl-4">
							<div className="text-xxs-600 text-muted-foreground uppercase tracking-wider mb-1">
								User input
							</div>
							<div className="text-h3-600 font-bold text-foreground whitespace-pre-wrap">
								{evalCase.user_input}
							</div>
						</div>
					</div>
				)}

				{primaryJudgment &&
					// Skip the green "Judge passed" banner when it would just duplicate
					// the StatusChip in the header — only show it if the verdict is
					// failed/other, or the judge supplied reasoning or a rubric worth
					// surfacing.
					(primaryJudgment.verdict !== "pass" ||
						!!primaryJudgment.reasoning?.trim() ||
						!!primaryJudgment.intent?.trim()) && (
						<VerdictBanner judgment={primaryJudgment} />
					)}

				<div>
					<div className="text-xxs-600 text-muted-foreground uppercase tracking-wider mb-4 mt-2">
						Transcript
					</div>
					<div className="relative">
						<div
							aria-hidden
							className="absolute left-[10px] top-3 bottom-3 w-px bg-border"
						/>
						<div className="flex flex-col gap-3.5">
							{evalCase.events.map((ev, i) => (
								<EventRow key={i} event={ev} />
							))}
						</div>
					</div>
				</div>

				{evalCase.judgments.length > 1 && (
					<div>
						<div className="text-xxs-600 text-muted-foreground uppercase tracking-wider mb-2">
							Other judgments
						</div>
						<div className="flex flex-col gap-2">
							{evalCase.judgments
								.filter((j) => j !== primaryJudgment)
								.map((j, i) => (
									<VerdictBanner key={`${j.intent}-${i}`} judgment={j} />
								))}
						</div>
					</div>
				)}

				{evalCase.failure && evalCase.failure.kind !== "judge_failed" && (
					<FailureCard failure={evalCase.failure} />
				)}
			</div>
		</>
	);
};

function FailureCard({
	failure,
}: {
	failure: NonNullable<ReturnType<typeof useEvalCase>["evalCase"]>["failure"];
}) {
	if (!failure) return null;
	return (
		<Card className="border-border bg-muted/40">
			<CardContent className="py-3">
				<div className="flex items-center gap-2 text-s-600 text-foreground mb-2">
					<AlertTriangle className="h-3.5 w-3.5" /> Failure ({failure.kind})
				</div>
				{failure.message && (
					<div className="text-s-500 mb-2">{failure.message}</div>
				)}
				{failure.stack && (
					<Collapsible>
						<CollapsibleTrigger className="text-xs-600 text-muted-foreground uppercase tracking-wider hover:text-foreground cursor-pointer bg-transparent border-none p-0">
							Stack trace
						</CollapsibleTrigger>
						<CollapsibleContent className="mt-2">
							<pre className="border rounded-md bg-card px-2.5 py-2 font-mono text-xs-400 text-muted-foreground whitespace-pre-wrap break-words max-h-[180px] overflow-auto">
								{failure.stack}
							</pre>
						</CollapsibleContent>
					</Collapsible>
				)}
			</CardContent>
		</Card>
	);
}
