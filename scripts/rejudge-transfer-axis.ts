/**
 * Re-judge ONLY the transfer axis (human_transfer + transfer_consent) on
 * already-judged sessions — the follow-up to importing `transfer:human` tags
 * for calls judged before the axis existed. Every other stored verdict stays
 * byte-identical (see src/evals-engine/transfer-rejudge.ts); the per-judge rows
 * are re-fanned so consumers read the new axis.
 *
 * Select sessions either explicitly or by tag:
 *   --session-ids-file ids.txt            one session_id per line
 *   --tag transfer:human [--tag-source legacy_backfill] [--since 2026-08-01T00:00:00Z] [--limit N]
 * Options: --dry-run (runs the judges — real LLM calls — prints each verdict, writes nothing)
 *          --concurrency N (default 3)
 * Exit code 1 when any session failed, so a cron/CI wrapper notices.
 *
 *   DATABASE_URL=… <judge provider env> bun run scripts/rejudge-transfer-axis.ts --tag transfer:human --tag-source legacy_backfill
 */
import { readFileSync } from "node:fs";
import { sql } from "../src/db.js";
import {
  getSessionEvalSource,
  getStoredSessionEvalVerdicts,
  listDoneSessionIdsWithTag,
} from "../src/evals-engine/db.js";
import { commitRejudgedVerdicts, eventsFromChatHistory } from "../src/evals-engine/eval-sweeper.js";
import { sanitizeForLog } from "../src/response.js";
import { buildSessionEvalInput, type AgentConfig, type SessionEvalVerdicts, type StoredEvent } from "../src/evals-engine/integration/session-evals.js";
import { rejudgeTransferAxis } from "../src/evals-engine/transfer-rejudge.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const dryRun = process.argv.includes("--dry-run");
function intArg(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) { console.error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`); process.exit(2); }
  return n;
}
function dateArg(name: string): Date | undefined {
  const raw = arg(name);
  if (raw === undefined) return undefined;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) { console.error(`${name} must be an ISO date, got ${JSON.stringify(raw)}`); process.exit(2); }
  return d;
}
const concurrency = intArg("--concurrency", 3);

let sessionIds: string[];
const idsFile = arg("--session-ids-file");
const tag = arg("--tag");
if (idsFile) {
  sessionIds = readFileSync(idsFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
} else if (tag) {
  sessionIds = await listDoneSessionIdsWithTag({
    name: tag,
    tagSource: arg("--tag-source"),
    since: dateArg("--since"),
    limit: arg("--limit") !== undefined ? intArg("--limit", 10_000) : undefined,
  });
} else {
  console.error("usage: --session-ids-file <file> | --tag <name> [--tag-source <src>] [--since <iso>] [--limit N]  [--dry-run] [--concurrency N]");
  process.exit(2);
}
console.log(`${sessionIds.length} session(s) selected${dryRun ? " [dry-run]" : ""}`);

const counts = { rejudged: 0, skipped: 0, failed: 0, transferred: 0, withoutConsent: 0 };

async function one(sessionId: string): Promise<void> {
  const stored = await getStoredSessionEvalVerdicts(sessionId);
  if (!stored || stored.status !== "done" || !stored.verdicts) { counts.skipped++; return; }
  const source = await getSessionEvalSource(sessionId);
  if (!source) { counts.skipped++; return; }
  const rawReport = (source.rawReport ?? {}) as { events?: unknown };
  let events: StoredEvent[] = Array.isArray(rawReport.events) ? (rawReport.events as StoredEvent[]) : [];
  if (events.length === 0) events = eventsFromChatHistory(source.chatHistory);
  const { input } = buildSessionEvalInput(source.config as AgentConfig, events);
  if (source.transport) input.transport = source.transport;
  input.tags = source.tags;
  const next = await rejudgeTransferAxis(input, stored.verdicts as unknown as SessionEvalVerdicts);
  const cm = next.conversation_metrics;
  if (cm.human_transfer.detected) counts.transferred++;
  if (cm.transfer_consent.available && cm.transfer_consent.detected) counts.withoutConsent++;
  console.log(`${sanitizeForLog(sessionId)} transfer=${cm.human_transfer.detected} consent=${cm.transfer_consent.available ? (cm.transfer_consent.detected ? `NO (${cm.transfer_consent.reason_code})` : "yes") : "n/a"}`);
  if (dryRun) { counts.rejudged++; return; }
  const committed = await commitRejudgedVerdicts(sessionId, next, source.sessionEndedAt ?? stored.completedAt ?? new Date());
  if (!committed) { counts.skipped++; return; }
  counts.rejudged++;
}

let cursor = 0;
const worker = async () => {
  while (cursor < sessionIds.length) {
    const id = sessionIds[cursor++]!;
    try { await one(id); } catch (e) { counts.failed++; console.error(`${sanitizeForLog(id)} failed: ${(e as Error).message}`); }
  }
};
await Promise.all(Array.from({ length: concurrency }, worker));
console.log(JSON.stringify(counts));
await sql.end();
if (counts.failed > 0) process.exit(1);
