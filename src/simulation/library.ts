/* library.ts — CRUD for the simulation library: personas, rubrics, scenarios.
 * Persisted in Postgres (sim_personas / sim_rubrics / sim_scenarios). */
import type { Hono } from "hono";
import { randomUUID } from "crypto";
import { z } from "zod";
import { sql } from "../db.js";
import { buildErrorResponse, newApiId } from "../response.js";

const personaInput = z.object({
  name: z.string().min(1),
  type: z.enum(["baseline", "edge_case", "workflow", "knowledge", "red_team"]).default("edge_case"),
  goal: z.string().default(""),
  opener: z.string().default(""),
  voice: z.string().default("cartesia/sonic"),
  avatar: z.string().default("#6366f1"),
  source: z.enum(["user", "generated"]).default("user"),
});
const rubricInput = z.object({
  name: z.string().min(1),
  criteria: z
    .array(z.object({ name: z.string(), question: z.string().default(""), weight: z.coerce.number().optional() }))
    .default([]),
  pass_threshold: z.coerce.number().int().min(0).max(100).default(70),
});
const scenarioInput = z.object({
  name: z.string().min(1),
  yaml: z.string().min(1),
});
const agentInput = z.object({
  name: z.string().min(1),
  phone_number: z.string().optional().default(""),
  description: z.string().optional().default(""),
  system_prompt: z.string().min(1),
});

const parseJson = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

export function registerLibraryRoutes(app: Hono) {
  /* ---------- personas ---------- */
  app.get("/api/library/personas", async (c) => {
    const rows = await sql`SELECT * FROM sim_personas ORDER BY builtin DESC, created_at ASC`;
    return c.json({ api_id: newApiId(), objects: rows });
  });

  app.post("/api/library/personas", async (c) => {
    const parsed = personaInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(buildErrorResponse("invalid_payload", parsed.error.issues.map((i) => i.message).join("; ")), 400);
    const p = parsed.data;
    const id = randomUUID();
    const [row] = await sql`
      INSERT INTO sim_personas (id, name, type, goal, opener, voice, avatar, builtin, source)
      VALUES (${id}, ${p.name}, ${p.type}, ${p.goal}, ${p.opener}, ${p.voice}, ${p.avatar}, false, ${p.source})
      RETURNING *`;
    return c.json({ api_id: newApiId(), ...row }, 201);
  });

  app.patch("/api/library/personas/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = personaInput.partial().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(buildErrorResponse("invalid_payload", "bad fields"), 400);
    const [existing] = await sql`SELECT * FROM sim_personas WHERE id = ${id}`;
    if (!existing) return c.json(buildErrorResponse("not_found", "Persona not found"), 404);
    if (existing.builtin) return c.json(buildErrorResponse("forbidden", "Built-in personas can't be edited"), 403);
    const p = parsed.data;
    const [row] = await sql`
      UPDATE sim_personas SET
        name = ${p.name ?? existing.name},
        type = ${p.type ?? existing.type},
        goal = ${p.goal ?? existing.goal},
        opener = ${p.opener ?? existing.opener},
        voice = ${p.voice ?? existing.voice},
        avatar = ${p.avatar ?? existing.avatar}
      WHERE id = ${id} RETURNING *`;
    return c.json({ api_id: newApiId(), ...row });
  });

  app.delete("/api/library/personas/:id", async (c) => {
    const id = c.req.param("id");
    const deleted = await sql`DELETE FROM sim_personas WHERE id = ${id} AND builtin = false RETURNING id`;
    if (deleted.length === 0) return c.json(buildErrorResponse("not_deletable", "Not found or built-in"), 400);
    return c.json({ api_id: newApiId(), deleted: deleted.length });
  });

  /* ---------- rubrics (criteria-based) ---------- */
  app.get("/api/library/rubrics", async (c) => {
    const rows = await sql`SELECT * FROM sim_rubrics ORDER BY builtin DESC, created_at ASC`;
    return c.json({ api_id: newApiId(), objects: rows.map((r: any) => ({ ...r, criteria: parseJson(r.criteria), axes: parseJson(r.axes) })) });
  });
  app.post("/api/library/rubrics", async (c) => {
    const parsed = rubricInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(buildErrorResponse("invalid_payload", parsed.error.issues.map((i) => i.message).join("; ")), 400);
    const r = parsed.data;
    const id = randomUUID();
    // `${r.criteria}::jsonb` (array straight in) → real jsonb array. NOT
    // `${JSON.stringify(r.criteria)}::jsonb` — that double-encodes to a string scalar.
    const [row] = await sql`
      INSERT INTO sim_rubrics (id, name, criteria, pass_threshold, builtin)
      VALUES (${id}, ${r.name}, ${r.criteria}::jsonb, ${r.pass_threshold}, false)
      RETURNING *`;
    return c.json({ api_id: newApiId(), ...row, criteria: parseJson(row.criteria), axes: parseJson(row.axes) }, 201);
  });
  app.patch("/api/library/rubrics/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = rubricInput.partial().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(buildErrorResponse("invalid_payload", "bad fields"), 400);
    const [existing] = await sql`SELECT * FROM sim_rubrics WHERE id = ${id}`;
    if (!existing) return c.json(buildErrorResponse("not_found", "Rubric not found"), 404);
    if (existing.builtin) return c.json(buildErrorResponse("forbidden", "Built-in rubrics can't be edited"), 403);
    const r = parsed.data;
    // Pass the ARRAY straight into `${...}::jsonb` — bun:sql JSON-encodes it and
    // the cast parses it into a real jsonb array. Do NOT JSON.stringify first:
    // a stringified value bound to a jsonb cast is double-encoded into a jsonb
    // STRING scalar, which breaks jsonb_array_elements / jsonb_array_length.
    const criteria = r.criteria !== undefined ? r.criteria : (parseJson(existing.criteria) ?? []);
    const [row] = await sql`
      UPDATE sim_rubrics SET
        name = ${r.name ?? existing.name},
        criteria = ${criteria}::jsonb,
        pass_threshold = ${r.pass_threshold ?? existing.pass_threshold}
      WHERE id = ${id} RETURNING *`;
    return c.json({ api_id: newApiId(), ...row, criteria: parseJson(row.criteria), axes: parseJson(row.axes) });
  });
  app.delete("/api/library/rubrics/:id", async (c) => {
    const deleted = await sql`DELETE FROM sim_rubrics WHERE id = ${c.req.param("id")} AND builtin = false RETURNING id`;
    if (deleted.length === 0) return c.json(buildErrorResponse("not_deletable", "Not found or built-in"), 400);
    return c.json({ api_id: newApiId(), deleted: deleted.length });
  });

  /* ---------- scenarios ---------- */
  app.get("/api/library/scenarios", async (c) => {
    const rows = await sql`SELECT * FROM sim_scenarios ORDER BY created_at DESC`;
    return c.json({ api_id: newApiId(), objects: rows });
  });
  app.post("/api/library/scenarios", async (c) => {
    const parsed = scenarioInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(buildErrorResponse("invalid_payload", parsed.error.issues.map((i) => i.message).join("; ")), 400);
    const s = parsed.data;
    const id = randomUUID();
    const [row] = await sql`INSERT INTO sim_scenarios (id, name, yaml) VALUES (${id}, ${s.name}, ${s.yaml}) RETURNING *`;
    return c.json({ api_id: newApiId(), ...row }, 201);
  });
  app.delete("/api/library/scenarios/:id", async (c) => {
    const deleted = await sql`DELETE FROM sim_scenarios WHERE id = ${c.req.param("id")} RETURNING id`;
    if (deleted.length === 0) return c.json(buildErrorResponse("not_found", "Not found"), 404);
    return c.json({ api_id: newApiId(), deleted: deleted.length });
  });

  /* ---------- agents ---------- */
  app.get("/api/library/agents", async (c) => {
    const rows = await sql`SELECT * FROM sim_agents ORDER BY builtin DESC, created_at ASC`;
    return c.json({ api_id: newApiId(), objects: rows });
  });
  app.post("/api/library/agents", async (c) => {
    const parsed = agentInput.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(buildErrorResponse("invalid_payload", parsed.error.issues.map((i) => i.message).join("; ")), 400);
    const a = parsed.data;
    const id = randomUUID();
    const [row] = await sql`
      INSERT INTO sim_agents (id, name, phone_number, description, system_prompt, builtin)
      VALUES (${id}, ${a.name}, ${a.phone_number}, ${a.description}, ${a.system_prompt}, false)
      RETURNING *`;
    return c.json({ api_id: newApiId(), ...row }, 201);
  });
  app.patch("/api/library/agents/:id", async (c) => {
    const id = c.req.param("id");
    const parsed = agentInput.partial().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(buildErrorResponse("invalid_payload", "bad fields"), 400);
    const [existing] = await sql`SELECT * FROM sim_agents WHERE id = ${id}`;
    if (!existing) return c.json(buildErrorResponse("not_found", "Agent not found"), 404);
    if (existing.builtin) return c.json(buildErrorResponse("forbidden", "Built-in agents can't be edited"), 403);
    const a = parsed.data;
    const [row] = await sql`
      UPDATE sim_agents SET
        name = ${a.name ?? existing.name},
        phone_number = ${a.phone_number ?? existing.phone_number},
        description = ${a.description ?? existing.description},
        system_prompt = ${a.system_prompt ?? existing.system_prompt}
      WHERE id = ${id} RETURNING *`;
    return c.json({ api_id: newApiId(), ...row });
  });
  app.delete("/api/library/agents/:id", async (c) => {
    const deleted = await sql`DELETE FROM sim_agents WHERE id = ${c.req.param("id")} AND builtin = false RETURNING id`;
    if (deleted.length === 0) return c.json(buildErrorResponse("not_deletable", "Not found or built-in"), 400);
    return c.json({ api_id: newApiId(), deleted: deleted.length });
  });
}
