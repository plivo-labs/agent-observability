import type { Hono } from "hono";
import { simRequestSchema, generateRequestSchema } from "./schema.js";
import { runSimulation, generatePersonas, PERSONA_CATALOG, type PersonaType } from "./engine.js";
import { persistSimRun } from "./persist.js";
import { buildErrorResponse, newApiId } from "../response.js";

export function registerSimulationRoutes(app: Hono) {
  // Persona catalog (so the UI can offer the same set the engine knows about).
  app.get("/api/personas", (c) => {
    return c.json({ api_id: newApiId(), objects: PERSONA_CATALOG });
  });

  // Generate personas from a prompt — AI-tailored to the agent's weak spots
  // (LLM when configured, else prompt-derived demo). Preview-then-approve.
  app.post("/api/personas/generate", async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json(buildErrorResponse("invalid_json", "Body is not valid JSON"), 400); }
    const parsed = generateRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(buildErrorResponse("invalid_payload", parsed.error.issues.map((i) => i.message).join("; ")), 400);
    }
    try {
      const { engine, personas } = await generatePersonas(parsed.data.prompt, parsed.data.count, parsed.data.types as PersonaType[]);
      return c.json({ api_id: newApiId(), engine, personas });
    } catch (e) {
      console.error(`[sim] generate failed: ${(e as Error).message}`);
      return c.json(buildErrorResponse("generate_failed", "Persona generation failed"), 500);
    }
  });

  // Run a simulation from a pasted prompt (or YAML) + selected personas.
  app.post("/api/simulations", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(buildErrorResponse("invalid_json", "Body is not valid JSON"), 400);
    }
    const parsed = simRequestSchema.safeParse(body);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
      return c.json(buildErrorResponse("invalid_payload", msg), 400);
    }
    try {
      const result = await runSimulation(parsed.data);
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
}
