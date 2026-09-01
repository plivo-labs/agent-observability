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
 * Options: --dry-run (judge, print, write nothing) --concurrency N (default 3)
 *
 *   DATABASE_URL=… <judge provider env> bun run scripts/rejudge-transfer-axis.ts --tag transfer:human --tag-source legacy_backfill
 */
import { readFileSync } from "node:fs";
import { sql } from "../src/db.js";
import {
  getSessionEvalSource,
  getStoredSessionEvalVerdicts,
  listDoneSessionIdsWithTag,
  overwriteDoneSessionVerdicts,
} from "../src/evals-engine/db.js";
import { eventsFromChatHistory, refanExternalEvalsForDone } from "../src/evals-engine/eval-sweeper.js";
import { buildSessionEvalInput, type AgentConfig, type SessionEvalVerdicts, type StoredEvent } from "../src/evals-engine/integration/session-evals.js";
import { rejudgeTransferAxis } from "../src/evals-engine/transfer-rejudge.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const dryRun = process.argv.includes("--dry-run");
const concurrency = Math.max(1, Number(arg("--concurrency") ?? 3));

let sessionIds: string[];
const idsFile = arg("--session-ids-file");
const tag = arg("--tag");
if (idsFile) {
  sessionIds = readFileSync(idsFile, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
} else if (tag) {
  const since = arg("--since");
  sessionIds = await listDoneSessionIdsWithTag({
    name: tag,
    tagSource: arg("--tag-source"),
    since: since ? new Date(since) : undefined,
    limit: arg("--limit") ? Number(arg("--limit")) : undefined,
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
  console.log(`${sessionId} transfer=${cm.human_transfer.detected} consent=${cm.transfer_consent.available ? (cm.transfer_consent.detected ? `NO (${cm.transfer_consent.reason_code})` : "yes") : "n/a"}`);
  if (dryRun) { counts.rejudged++; return; }
  const written = await overwriteDoneSessionVerdicts(sessionId, next);
  if (!written) { counts.skipped++; return; }
  await refanExternalEvalsForDone(sessionId, next, source.sessionEndedAt ?? stored.completedAt ?? new Date());
  counts.rejudged++;
}

let cursor = 0;
const worker = async () => {
  while (cursor < sessionIds.length) {
    const id = sessionIds[cursor++]!;
    try { await one(id); } catch (e) { counts.failed++; console.error(`${id} failed: ${(e as Error).message}`); }
  }
};
await Promise.all(Array.from({ length: concurrency }, worker));
console.log(JSON.stringify(counts));
await sql.end();
