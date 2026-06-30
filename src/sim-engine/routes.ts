// AO Simulation Engine — HTTP + SSE routes (scenario library + generation).
//
// AO is the simulation engine: it owns scenario generation and the generated scenario
// *library* CRUD. Runs are NOT exposed here — in the managed deployment the orchestrator service produces runs (publishes
// SQS, consumed by AO's worker) and owns run history; on the run path AO writes only the
// Redis :RESULTS stream. So this module mounts generation + library routes only. (The
// OSS-only in-process run mode + its run-history routes were removed for V1; re-add behind a
// driver seam when OSS lands.)
//
// These routes live under AO's `/api/simulation` prefix, behind AO's existing `/api/*` basic
// auth. The library routes are Postgres-backed. Generation streams an error event if no LLM is
// configured rather than pre-blocking. Tenant id comes from the `auth-id` header (= the API gateway's
// injected org account id → AO `account_id`); `phlo_uuid` → AO `agent_id`.

import type { Hono, Context } from "hono";
import { streamSSE } from "hono/streaming";
import { simEngineConfig, scenarioPersistDefault } from "./config.js";
import { dbConfigured } from "../config.js";
import {
  GenerateScenariosRequest,
  DeleteScenariosRequest,
  parseFlowJson,
  FlowJsonError,
} from "./schema.js";
import {
  listScenarios,
  createScenario,
  deleteScenarios,
  deleteScenariosByAgent,
  type SimScenarioRow,
} from "./db.js";
import { generateScenarios } from "./gen/generate.js";
import { SSE, envelope } from "./events.js";
import { newApiId, buildErrorResponse } from "../response.js";

// ── helpers ───────────────────────────────────────────────────────────────────

// SECURITY: `auth-id` is the tenant scope for every scenario read/write below. It is injected
// (and the session it derives from is validated) by the API gateway — AO trusts it because
// AO runs ONLY behind the API gateway on a private network, never exposed directly. A direct caller could
// spoof this header, so if AO is ever fronted by anything other than the API gateway, add real auth here
// (validate the account) before using it. Null (no header) = unscoped, single-tenant/no-auth mode.
const accountIdOf = (c: Context): string | null => c.req.header("auth-id") || null;

function pageParams(c: Context, defaultPageSize: number): { page: number; pageSize: number; limit: number; offset: number } {
  const page = Math.max(1, Number(c.req.query("page")) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(c.req.query("page_size")) || defaultPageSize));
  return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
}

async function readJson<T>(c: Context, parse: (v: unknown) => T): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: parse(await c.req.json()) };
  } catch {
    return { ok: false };
  }
}

const toPersistedScenario = (r: SimScenarioRow) => ({
  uuid: r.id,
  account_id: r.account_id,
  agent_id: r.agent_id,
  name: r.name,
  scenario: r.scenario,
  tags: r.tags,
  source: r.source,
  coverage_key: r.coverage_key,
  created_at: r.created_at,
  updated_at: r.updated_at,
});

// ── registration ────────────────────────────────────────────────────────────────

export function registerSimulationRoutes(app: Hono): void {
  // 1. list scenarios
  app.get("/api/simulation/scenarios", async (c) => {
    const agentId = c.req.query("phlo_uuid") || null;
    const { page, pageSize, limit, offset } = pageParams(c, 50);
    // STATELESS mode: AO owns no scenario store — the library is empty by definition.
    if (!dbConfigured) return c.json({ api_id: newApiId(), scenarios: [], total: 0, page, page_size: pageSize });
    const { objects, total } = await listScenarios({ accountId: accountIdOf(c), agentId, limit, offset });
    return c.json({ api_id: newApiId(), scenarios: objects.map(toPersistedScenario), total, page, page_size: pageSize });
  });

  // 2. generate scenarios (SSE) — needs an LLM, NOT a queue. If no LLM is configured the generator
  //    throws and the catch below streams an `error` event (no upfront block, so the route stays
  //    testable with a mocked generator).
  app.post("/api/simulation/scenarios/generate", async (c) => {
    const parsed = await readJson(c, (v) => GenerateScenariosRequest.parse(v));
    if (!parsed.ok) return c.json(buildErrorResponse("invalid_request", "Body failed GenerateScenariosRequest validation"), 400);
    const body = parsed.value;
    let canonical: Record<string, unknown>;
    try {
      canonical = parseFlowJson(body.flow_json) as unknown as Record<string, unknown>;
    } catch (e) {
      const detail = e instanceof FlowJsonError ? e.message : "invalid flow_json";
      return c.json(buildErrorResponse("invalid_flow_json", detail), 400);
    }
    const accountId = accountIdOf(c);
    // `persist` (default true): standalone/OSS AO owns the scenario library, so it
    // writes each generated scenario to its own table. Behind the orchestrator service in the managed deployment, AO
    // runs as a STATELESS generator (`?persist=false`) — it streams scenarios but
    // writes no DB; the orchestrator service persists each `scenario_saved` it relays into core-db
    // (the system of record). The full scenario rides on the SSE event either way.
    // Precedence: the per-request `?persist=` query param overrides the env default
    // (SIM_PERSIST). ANDed with dbConfigured — persistence is impossible without a database.
    const persistQuery = c.req.query("persist");
    const persist = (persistQuery != null ? persistQuery !== "false" : scenarioPersistDefault) && dbConfigured;
    const genId = crypto.randomUUID();
    return streamSSE(c, async (stream) => {
      try {
        const iterator = generateScenarios({
          flowJson: canonical,
          phloUuid: body.phlo_uuid,
          maxScenarios: body.max_scenarios,
          model: simEngineConfig.scenarioGenerationModel,
          simulationMode: body.simulation_mode,
          testCaseGenerationInstructions: body.test_case_generation_instructions,
        })[Symbol.asyncIterator]();
        // Heartbeat: emit a real `progress` event every ~10s while the generator is silent (the
        // planner + parallel writer LLM calls run for tens of seconds with no events). This keeps
        // Bun's idleTimeout / any proxy alive AND — critically — keeps the aiassist relay's Redis
        // stream (SIM_GEN:{id}:EVENTS) active: aiassist's SSE reader SKIPS `:`-comment lines, so a
        // bare keepalive comment never reached Redis; the consumer's XREAD connection then idled and
        // the ELB reset it after ~60s → the console "stream error". A real progress frame IS forwarded
        // (XADDed), so the stream/connection never idles out. `stage:"heartbeat"` carries no counts,
        // so it is safe for the console (advisory progress; a stage switch hits its default no-op).
        const HEARTBEAT_MS = 10_000;
        let hbSeq = 0;
        for (;;) {
          const nextEvent = iterator.next();
          let result: Awaited<typeof nextEvent> | undefined;
          for (;;) {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const heartbeat = new Promise<"__hb__">((resolve) => {
              timer = setTimeout(() => resolve("__hb__"), HEARTBEAT_MS);
            });
            const winner = await Promise.race([nextEvent, heartbeat]);
            if (timer) clearTimeout(timer);
            if (winner === "__hb__") {
              await stream.writeSSE({
                event: SSE.PROGRESS,
                data: envelope("generation_id", genId, { stage: "heartbeat", generation_id: genId, seq: ++hbSeq }),
              });
              continue;
            }
            result = winner;
            break;
          }
          if (!result || result.done) break;
          const ev = result.value;
          if (ev.type === "scenario") {
            const s = ev.scenario;
            if (persist) {
              await createScenario({
                accountId,
                agentId: body.phlo_uuid,
                name: s.name,
                scenario: s,
                tags: s.tags,
                coverageKey: s.eval_metadata?.coverage_key ?? null,
              });
            }
            await stream.writeSSE({
              event: SSE.SCENARIO_SAVED,
              data: envelope("generation_id", genId, { scenario: s, agent_flow_description: s.agent_flow_description ?? "" }),
            });
          } else if (ev.type === "metadata") {
            await stream.writeSSE({
              event: SSE.COMPLETED,
              data: envelope("generation_id", genId, { count: ev.metadata.saved_count, ...ev.metadata }),
            });
          } else {
            // progress phases — console reads event_data.stage
            await stream.writeSSE({
              event: SSE.PROGRESS,
              data: envelope("generation_id", genId, { stage: ev.type, generation_id: genId, ...ev }),
            });
          }
        }
      } catch (e) {
        // Log on AO's own stdout too — until now the failure reached only the client as an SSE
        // error, so a "Stream error" in the console left no server-side trace to debug from.
        console.error(`[sim-gen] generation stream failed (generation_id=${genId}):`, (e as Error).message);
        await stream.writeSSE({ event: SSE.ERROR, data: envelope("generation_id", genId, { error: (e as Error).message }) });
      }
    });
  });

  // 3. delete one scenario — account-scoped: a tenant can only delete its own; a
  //    uuid owned by another account is a no-op → 404 (so existence isn't leaked).
  app.delete("/api/simulation/scenarios/:scenario_uuid", async (c) => {
    if (!dbConfigured) return c.json(buildErrorResponse("not_found", "scenario not found"), 404);
    const deleted = await deleteScenarios([c.req.param("scenario_uuid")], accountIdOf(c));
    if (deleted === 0) return c.json(buildErrorResponse("not_found", "scenario not found"), 404);
    return c.json({ api_id: newApiId(), deleted });
  });

  // 4. batch delete — account-scoped: uuids owned by other accounts are silent no-ops.
  app.post("/api/simulation/scenarios/batch-delete", async (c) => {
    const parsed = await readJson(c, (v) => DeleteScenariosRequest.parse(v));
    if (!parsed.ok) return c.json(buildErrorResponse("invalid_request", "Body must be { uuids: string[] (1-200) }"), 400);
    if (!dbConfigured) return c.json({ api_id: newApiId(), deleted_count: 0 });
    const deleted = await deleteScenarios(parsed.value.uuids, accountIdOf(c));
    return c.json({ api_id: newApiId(), deleted_count: deleted });
  });

  // 5. delete all scenarios for a phlo
  app.delete("/api/simulation/scenarios", async (c) => {
    const agentId = c.req.query("phlo_uuid");
    if (!agentId) return c.json(buildErrorResponse("invalid_request", "phlo_uuid query param is required"), 400);
    if (!dbConfigured) return c.json({ api_id: newApiId(), phlo_uuid: agentId, deleted_count: 0 });
    const deleted = await deleteScenariosByAgent(agentId, accountIdOf(c));
    return c.json({ api_id: newApiId(), phlo_uuid: agentId, deleted_count: deleted });
  });
}
