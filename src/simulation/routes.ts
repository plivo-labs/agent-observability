import type { Context, Hono } from "hono";
import { randomUUID } from "crypto";
import { z } from "zod";
import { simRequestSchema, generateRequestSchema, criterionSchema } from "./schema.js";
import { runSimulation, runCall, generatePersonas, PERSONA_CATALOG, type PersonaType, type SimEvent } from "./engine.js";
import { createJob, getJob, updateJob, setJobController, cancelJob } from "./jobs.js";
import { persistSimRun, persistCallRun, persistCallBatch } from "./persist.js";
import { buildErrorResponse, newApiId } from "../response.js";
import { config, trumanEnabled } from "../config.js";
import { trumanHealthy, trumanAudioUpstream, takeoverStart, takeoverStop, endCall, fetchVoices } from "./truman.js";
import { createLiveSuite, reconcileSuite } from "./live.js";

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

const callRequestSchema = z.object({
  prompt: z.string().min(1, "prompt (agent under test) is required"),
  persona: z.object({}).passthrough(),
  criteria: z.array(criterionSchema).default([]),
  opener: z.string().optional(),
  phoneNumber: z.string().optional(),    // target number Truman dials (real mode)
  rubricId: z.string().optional(),       // AO rubric id, for Truman entity dedup
  rubricName: z.string().optional(),
});

const callBatchSchema = z.object({
  prompt: z.string().min(1, "prompt (agent under test) is required"),
  personas: z.array(z.object({}).passthrough()).min(1, "select at least one persona"),
  criteria: z.array(criterionSchema).default([]),
  opener: z.string().optional(),
  phoneNumber: z.string().optional(),    // target number Truman dials (real mode)
  rubricId: z.string().optional(),       // AO rubric id, for Truman entity dedup
  rubricName: z.string().optional(),
});

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

  // ElevenLabs voice catalog (proxied from Truman, token kept server-side).
  // Returns the bare array; degrades to [] (status 200) if Truman is off/errors.
  app.get("/api/voices", async (c) => {
    return c.json(await fetchVoices());
  });

  // Which Live mode is active — so the UI can badge real vs shell, and poll.
  app.get("/api/calls/config", (c) => {
    const mode = trumanEnabled ? "truman" : config.SIM_LLM_API_KEY ? "llm" : "demo";
    return c.json({ api_id: newApiId(), mode, truman: trumanEnabled });
  });

  // Place one live call (Truman model): agent + one persona + criteria rubric.
  // Real mode → a one-persona Truman suite (async); demo/LLM mode → synchronous.
  app.post("/api/calls", async (c) => {
    const parsed = callRequestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(buildErrorResponse("invalid_payload", parsed.error.issues.map((i) => i.message).join("; ")), 400);
    const d = parsed.data;
    if (trumanEnabled) {
      if (!d.phoneNumber?.trim()) return c.json(buildErrorResponse("phone_required", "A phone number is required for real calls"), 400);
      if (!(await trumanHealthy())) return c.json(buildErrorResponse("truman_unavailable", "Truman caller is unreachable — start its API + worker, or unset TRUMAN_API_URL"), 502);
      try {
        const suite = await createLiveSuite({ prompt: d.prompt, phoneNumber: d.phoneNumber, personas: [d.persona], criteria: d.criteria, opener: d.opener, rubricId: d.rubricId, rubricName: d.rubricName });
        return c.json({ api_id: newApiId(), ...suite });
      } catch (e) {
        console.error(`[live] call failed: ${(e as Error).message}`);
        return c.json(buildErrorResponse("call_failed", (e as Error).message), 502);
      }
    }
    try {
      const result = await runCall(d as any);
      const evalRunId = await persistCallRun(result);
      console.log(`[call] ${result.personaName} → ${result.agentName} verdict=${result.verdict} engine=${result.engine}`);
      return c.json({ api_id: newApiId(), evalRunId, ...result });
    } catch (e) {
      console.error(`[call] failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("call_failed", "Call run failed"), 500);
    }
  });

  // Place a batch of live calls (a Truman "suite"): one call per persona.
  // Real mode → provisions Truman + a suite and returns queued calls (poll
  // GET /api/calls/batch/:suiteId). Demo/LLM mode → synchronous as before.
  app.post("/api/calls/batch", async (c) => {
    const parsed = callBatchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json(buildErrorResponse("invalid_payload", parsed.error.issues.map((i) => i.message).join("; ")), 400);
    const { prompt, personas, criteria, opener, phoneNumber, rubricId, rubricName } = parsed.data;
    if (trumanEnabled) {
      if (!phoneNumber?.trim()) return c.json(buildErrorResponse("phone_required", "A phone number is required for real calls"), 400);
      if (!(await trumanHealthy())) return c.json(buildErrorResponse("truman_unavailable", "Truman caller is unreachable — start its API + worker, or unset TRUMAN_API_URL"), 502);
      try {
        const suite = await createLiveSuite({ prompt, phoneNumber, personas, criteria, opener, rubricId, rubricName });
        console.log(`[live] suite ${suite.suiteId} placed → ${suite.agentName} · ${suite.calls.length} calls queued`);
        return c.json({ api_id: newApiId(), ...suite });
      } catch (e) {
        console.error(`[live] batch failed: ${(e as Error).message}`);
        return c.json(buildErrorResponse("call_failed", (e as Error).message), 502);
      }
    }
    try {
      const calls = await Promise.all(personas.map((p) => runCall({ prompt, persona: p, criteria, opener })));
      const agentName = calls[0]?.agentName ?? "your agent";
      const evalRunId = await persistCallBatch(agentName, calls);
      console.log(`[call] batch ${calls.length} calls → ${agentName} · ${calls.filter((c) => c.verdict === "pass").length}/${calls.length} passed`);
      return c.json({ api_id: newApiId(), evalRunId, agentName, calls });
    } catch (e) {
      console.error(`[call] batch failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("call_failed", "Call batch failed"), 500);
    }
  });

  // Poll a real (Truman) suite: reconcile against Truman, persist when complete.
  app.get("/api/calls/batch/:suiteId", async (c) => {
    try {
      const suite = await reconcileSuite(c.req.param("suiteId"));
      if (!suite) return c.json(buildErrorResponse("not_found", "Suite not found"), 404);
      return c.json({ api_id: newApiId(), ...suite });
    } catch (e) {
      console.error(`[live] poll failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("poll_failed", (e as Error).message), 502);
    }
  });

  // Proxy a finished call's recording from Truman (keeps the Truman token server-side).
  app.get("/api/calls/audio/:runId", async (c) => {
    if (!trumanEnabled) return c.json(buildErrorResponse("not_available", "Real calling is not enabled"), 404);
    try {
      const upstream = await trumanAudioUpstream(c.req.param("runId"));
      if (!upstream.ok || !upstream.body) return c.json(buildErrorResponse("no_recording", "Recording unavailable"), 404);
      return new Response(upstream.body, { headers: { "content-type": "audio/ogg" } });
    } catch (e) {
      return c.json(buildErrorResponse("audio_failed", (e as Error).message), 502);
    }
  });

  // Director controls for a live call — proxy to Truman (Bearer kept server-side).
  const control = (fn: (id: string) => Promise<any>) => async (c: any) => {
    if (!trumanEnabled) return c.json(buildErrorResponse("not_available", "Real calling is not enabled"), 404);
    try { return c.json({ api_id: newApiId(), ...(await fn(c.req.param("runId"))) }); }
    catch (e) { return c.json(buildErrorResponse("control_failed", (e as Error).message), 502); }
  };
  app.post("/api/calls/:runId/takeover/start", control(takeoverStart));
  app.post("/api/calls/:runId/takeover/stop", control(takeoverStop));
  app.post("/api/calls/:runId/end-call", control(endCall));

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
