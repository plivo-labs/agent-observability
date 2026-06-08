import type { Context, Hono } from "hono";
import { randomUUID } from "crypto";
import { z } from "zod";
import { simRequestSchema, generateRequestSchema } from "./schema.js";
import { runSimulation, generatePersonas, PERSONA_CATALOG, type PersonaType, type SimEvent } from "./engine.js";
import { createJob, getJob, updateJob, setJobController, cancelJob } from "./jobs.js";
import { persistSimRun } from "./persist.js";
import { buildErrorResponse, newApiId } from "../response.js";

/** Parse + zod-validate a JSON request body. Returns the typed data, or a ready
 *  400 Response (invalid_json / invalid_payload) for the handler to return. */
async function parseJsonBody<T>(c: Context, schema: z.ZodType<T>): Promise<{ data: T } | { error: Response }> {
  let body: unknown;
  try { body = await c.req.json(); } catch { return { error: c.json(buildErrorResponse("invalid_json", "Body is not valid JSON"), 400) }; }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    return { error: c.json(buildErrorResponse("invalid_payload", msg), 400) };
  }
  return { data: parsed.data };
}

export function registerSimulationRoutes(app: Hono) {
  // Persona catalog (so the UI can offer the same set the engine knows about).
  app.get("/api/personas", (c) => {
    return c.json({ api_id: newApiId(), objects: PERSONA_CATALOG });
  });

  // Generate personas from a prompt — AI-tailored to the agent's weak spots
  // (LLM when configured, else prompt-derived demo). Preview-then-approve.
  app.post("/api/personas/generate", async (c) => {
    const r = await parseJsonBody(c, generateRequestSchema);
    if ("error" in r) return r.error;
    try {
      const { engine, personas } = await generatePersonas(r.data.prompt, r.data.count, r.data.types as PersonaType[]);
      return c.json({ api_id: newApiId(), engine, personas });
    } catch (e) {
      console.error(`[sim] generate failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("generate_failed", "Persona generation failed"), 500);
    }
  });

  // Run a simulation from a pasted prompt (or YAML) + selected personas.
  app.post("/api/simulations", async (c) => {
    const r = await parseJsonBody(c, simRequestSchema);
    if ("error" in r) return r.error;
    try {
      const result = await runSimulation(r.data);
      console.log(`[sim] run ${result.runId} engine=${result.engine} agent="${result.agentName}" cases=${result.cases.length} overall=${result.overall}`);
      // Persist into the Evals tab (best-effort — never fail the sim on this).
      const evalRunId = await persistSimRun(result);
      if (evalRunId) console.log(`[sim] persisted as eval run ${evalRunId}`);
      return c.json({ api_id: newApiId(), evalRunId, ...result });
    } catch (e) {
      console.error(`[sim] failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("sim_failed", "Simulation failed to run"), 500);
    }
  });

  // Server-side simulation JOB — makes a text sim RESUMABLE across refresh / nav.
  // Same body + validation as /api/simulations, but the run executes in the
  // BACKGROUND on the server: we return a `jobId` immediately and stream the
  // engine's events into the in-memory job registry. The client polls
  // GET /api/simulations/jobs/:id to drive its live UI and to resume on mount.
  app.post("/api/simulations/jobs", async (c) => {
    const r = await parseJsonBody(c, simRequestSchema);
    if ("error" in r) return r.error;

    const jobId = randomUUID();
    createJob(jobId);
    // Abort handle so POST /jobs/:id/cancel actually stops the background run
    // (not just the client's polling).
    const controller = new AbortController();
    setJobController(jobId, controller);

    // onEvent (sync per the engine contract) folds each event into the job state.
    const onEvent = (evt: SimEvent) => {
      updateJob(jobId, (j) => {
        if (evt.type === "start") {
          j.cases = evt.cases.map((cs) => ({ index: cs.index, personaName: cs.personaName, personaType: cs.personaType, turns: [] }));
        } else if (evt.type === "turn") {
          const cs = j.cases[evt.caseIndex];
          if (cs) cs.turns.push(evt.turn);
        } else if (evt.type === "case_done") {
          const cs = j.cases[evt.caseIndex];
          if (cs) { cs.status = evt.status; cs.score = evt.score; }
        }
      });
    };

    // Kick off in the BACKGROUND — do NOT await before responding.
    void (async () => {
      try {
        const result = await runSimulation(r.data, controller.signal, onEvent);
        console.log(`[sim] job ${jobId} run ${result.runId} engine=${result.engine} agent="${result.agentName}" cases=${result.cases.length} overall=${result.overall}`);
        const runId = await persistSimRun(result); // best-effort — never fail the job on this
        if (runId) console.log(`[sim] job ${jobId} persisted as eval run ${runId}`);
        updateJob(jobId, (j) => { j.status = "done"; j.result = { ...result, evalRunId: runId } as any; j.runId = runId; });
      } catch (e) {
        // A cancel() aborts the run → AbortError. cancelJob already flipped the
        // status to "cancelled"; don't clobber it with an error.
        if (controller.signal.aborted || (e as Error)?.name === "AbortError") {
          console.log(`[sim] job ${jobId} cancelled`);
          return;
        }
        console.error(`[sim] job ${jobId} failed: ${(e as Error).message}`);
        updateJob(jobId, (j) => { j.status = "error"; j.error = "Simulation failed to run"; });
      }
    })();

    return c.json({ api_id: newApiId(), jobId });
  });

  // Poll / resume a simulation job: returns the JobState (status, cases incl.
  // turns-so-far, result, runId, error). 404 when the server has no record of
  // it (unknown id, expired, or cleared by a backend restart) — only then
  // should the client fall back to "Re-run".
  app.get("/api/simulations/jobs/:id", (c) => {
    const job = getJob(c.req.param("id"));
    if (!job) return c.json(buildErrorResponse("not_found", "Simulation job not found"), 404);
    return c.json(job);
  });

  // Cancel a running simulation job — aborts the background run (not just the
  // client's polling). 404 when unknown / already terminal (nothing to cancel).
  app.post("/api/simulations/jobs/:id/cancel", (c) => {
    const ok = cancelJob(c.req.param("id"));
    if (!ok) return c.json(buildErrorResponse("not_found", "No cancellable job"), 404);
    return c.json({ api_id: newApiId(), cancelled: true });
  });
}
