/* schedules.ts — recurring scheduled evaluations. A schedule runs a saved
 * scenario on a cadence; if the pass-rate drops below a threshold it records an
 * alert (and optionally pings a Slack webhook). */
import type { Hono } from "hono";
import { randomUUID } from "crypto";
import { z } from "zod";
import { sql } from "../db.js";
import { runSimulation } from "./engine.js";
import { persistSimRun } from "./persist.js";
import { buildErrorResponse, newApiId } from "../response.js";

const scheduleInput = z.object({
  name: z.string().min(1),
  scenario_id: z.string().min(1),
  interval_minutes: z.coerce.number().int().min(1).max(43200).default(1440),
  enabled: z.boolean().default(true),
  alert_pass_rate: z.coerce.number().int().min(0).max(100).nullable().optional(),
  slack_webhook: z.string().url().nullable().optional(),
});

// ── run one schedule now ─────────────────────────────────────────────────────
async function runScheduleById(id: string): Promise<{ passRate: number; evalRunId: string | null } | null> {
  const [sch] = await sql`SELECT * FROM sim_schedules WHERE id = ${id}`;
  if (!sch) return null;
  const [scn] = await sql`SELECT * FROM sim_scenarios WHERE id = ${sch.scenario_id}`;
  if (!scn) {
    await sql`UPDATE sim_schedules SET enabled = false WHERE id = ${id}`;
    console.error(`[schedule] ${id}: scenario gone — disabled`);
    return null;
  }

  const result = await runSimulation({ yaml: scn.yaml, mode: "text", personaIds: [], personas: [], autoGen: false, threshold: 70 });
  const evalRunId = await persistSimRun(result);
  const passRate = result.total ? Math.round((result.passN / result.total) * 100) : 0;
  const next = new Date(Date.now() + sch.interval_minutes * 60_000);

  await sql`
    UPDATE sim_schedules
    SET last_run_at = NOW(), last_pass_rate = ${passRate}, last_eval_run_id = ${evalRunId}, next_run_at = ${next}
    WHERE id = ${id}`;

  if (sch.alert_pass_rate != null && passRate < sch.alert_pass_rate) {
    const message = `Pass-rate ${passRate}% fell below ${sch.alert_pass_rate}% on "${sch.name}"`;
    await sql`INSERT INTO sim_alerts (schedule_id, schedule_name, message, pass_rate, eval_run_id) VALUES (${id}, ${sch.name}, ${message}, ${passRate}, ${evalRunId})`;
    console.log(`[schedule] ALERT: ${message}`);
    if (sch.slack_webhook) {
      try {
        await fetch(sch.slack_webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: `:rotating_light: ${message}` }) });
      } catch (e) {
        console.error(`[schedule] slack post failed: ${(e as Error).message}`);
      }
    }
  }
  return { passRate, evalRunId };
}

// ── background loop ──────────────────────────────────────────────────────────
let running = false;
export function startScheduler() {
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const due = await sql`SELECT id FROM sim_schedules WHERE enabled = true AND next_run_at <= NOW() ORDER BY next_run_at ASC LIMIT 5`;
      for (const d of due) {
        try { await runScheduleById(d.id); } catch (e) { console.error(`[schedule] run ${d.id} failed: ${(e as Error).message}`); }
      }
    } catch { /* db unavailable — try again next tick */ } finally {
      running = false;
    }
  }, 30_000);
  console.log("[schedule] scheduler started (30s tick)");
}

// ── routes ───────────────────────────────────────────────────────────────────
export function registerScheduleRoutes(app: Hono) {
  app.get("/api/schedules", async (c) => {
    const rows = await sql`SELECT * FROM sim_schedules ORDER BY created_at DESC`;
    return c.json({ api_id: newApiId(), objects: rows });
  });

  app.post("/api/schedules", async (c) => {
    const parsed = scheduleInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(buildErrorResponse("invalid_payload", parsed.error.issues.map((i) => i.message).join("; ")), 400);
    const s = parsed.data;
    const [scn] = await sql`SELECT id FROM sim_scenarios WHERE id = ${s.scenario_id}`;
    if (!scn) return c.json(buildErrorResponse("not_found", "Scenario not found"), 400);
    const id = randomUUID();
    const [row] = await sql`
      INSERT INTO sim_schedules (id, name, scenario_id, interval_minutes, enabled, alert_pass_rate, slack_webhook, next_run_at)
      VALUES (${id}, ${s.name}, ${s.scenario_id}, ${s.interval_minutes}, ${s.enabled}, ${s.alert_pass_rate ?? null}, ${s.slack_webhook ?? null}, NOW())
      RETURNING *`;
    return c.json({ api_id: newApiId(), ...row }, 201);
  });

  app.patch("/api/schedules/:id", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const [existing] = await sql`SELECT * FROM sim_schedules WHERE id = ${id}`;
    if (!existing) return c.json(buildErrorResponse("not_found", "Schedule not found"), 404);
    const enabled = typeof body.enabled === "boolean" ? body.enabled : existing.enabled;
    const interval = Number.isFinite(body.interval_minutes) ? body.interval_minutes : existing.interval_minutes;
    const alert = body.alert_pass_rate === null || Number.isFinite(body.alert_pass_rate) ? body.alert_pass_rate : existing.alert_pass_rate;
    const [row] = await sql`
      UPDATE sim_schedules SET enabled = ${enabled}, interval_minutes = ${interval}, alert_pass_rate = ${alert}
      WHERE id = ${id} RETURNING *`;
    return c.json({ api_id: newApiId(), ...row });
  });

  app.delete("/api/schedules/:id", async (c) => {
    const deleted = await sql`DELETE FROM sim_schedules WHERE id = ${c.req.param("id")} RETURNING id`;
    if (deleted.length === 0) return c.json(buildErrorResponse("not_found", "Not found"), 404);
    return c.json({ api_id: newApiId(), deleted: deleted.length });
  });

  app.post("/api/schedules/:id/run", async (c) => {
    try {
      const res = await runScheduleById(c.req.param("id"));
      if (!res) return c.json(buildErrorResponse("not_found", "Schedule or scenario not found"), 404);
      return c.json({ api_id: newApiId(), ...res });
    } catch (e) {
      return c.json(buildErrorResponse("run_failed", (e as Error).message), 500);
    }
  });

  app.get("/api/alerts", async (c) => {
    const rows = await sql`SELECT * FROM sim_alerts ORDER BY created_at DESC LIMIT 30`;
    return c.json({ api_id: newApiId(), objects: rows });
  });
}
