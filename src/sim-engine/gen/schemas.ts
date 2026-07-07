import { z } from "zod";

// AO Simulation Engine — PLANNER + WRITER output schemas (Phase 1.1).
//
// Ported VERBATIM from the orchestrator service `scenario_generator.py` (PLANNER_OUTPUT_SCHEMA L276-352,
// WRITER_OUTPUT_SCHEMA L354-454). Two representations:
//   • `*_JSON_SCHEMA` — the raw JSON Schema (the inner "schema" object), passed to
//     `completeJSON`'s `jsonSchema` option. The PLANNER is LOOSE (strict:false → we do
//     NOT pass it to the LLM; json_object mode + Zod validate). The WRITER is STRICT
//     (strict:true → passed as `jsonSchema`, the openai provider sets strict:true).
//   • `*Z` — Zod validators used by `completeJSON`'s `schema` to validate/parse the result.
//
// NOTE: the WRITER schema has NO interruption/stt_noise/non_answer — those are derived
// by validate_and_fix from the slot's runtime_stress_combo_id (Phase 1.5), not emitted.

// ── Raw JSON Schemas (inner `schema` objects) ──────────────────────────────────

export const PLANNER_SCHEMA_NAME = "capability_planner_output";
export const WRITER_SCHEMA_NAME = "scenario_writer_output";

export const PLANNER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    agent_flow_description: { type: "string" },
    capabilities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          capability_id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          priority: { type: "string", enum: ["core", "secondary", "boundary"] },
          risk: { type: "string", enum: ["high", "medium", "low"] },
          source_signals: { type: "array", items: { type: "string" } },
          success_criteria: { type: "array", items: { type: "string" } },
          route_anchors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                source_node_id: { type: "string" },
                intent_name: { type: "string" },
                target_node_type: { type: "string" },
                support: { type: "string", enum: ["fully_executable", "supported_terminal", "blocked"] },
              },
              required: ["source_node_id", "intent_name", "target_node_type", "support"],
              additionalProperties: false,
            },
          },
          action_anchors: { type: "array", items: { type: "string" } },
          variable_anchors: { type: "array", items: { type: "string" } },
          recommended_conversation_patterns: { type: "array", items: { type: "string" } },
          boundary_patterns: { type: "array", items: { type: "string" } },
          smoke_units: {
            type: "array",
            description:
              "Smoke coverage units under this capability. Each unit produces exactly one smoke scenario. Required when simulation_mode=smoke; ignored otherwise.",
            items: {
              type: "object",
              properties: {
                unit_id: { type: "string" },
                kind: { type: "string", enum: ["happy_path", "boundary"] },
                route_id: { type: "string" },
                scenario_type: { type: "string", enum: ["clean_baseline", "boundary_pressure"] },
                description: { type: "string" },
              },
              required: ["unit_id", "kind", "scenario_type", "description"],
              additionalProperties: false,
            },
          },
        },
        required: ["capability_id", "name", "description", "priority", "risk", "source_signals", "success_criteria"],
        additionalProperties: false,
      },
    },
    blocked_or_deferred_outcomes: {
      type: "array",
      items: {
        type: "object",
        properties: {
          capability_or_route: { type: "string" },
          reason: { type: "string" },
        },
        required: ["capability_or_route", "reason"],
        additionalProperties: false,
      },
    },
    planner_rationale: { type: "string" },
  },
  required: ["agent_flow_description", "capabilities", "planner_rationale"],
  additionalProperties: false,
};

export const WRITER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    agent_flow_description: { type: "string" },
    scenario_items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          slot_id: { type: "string" },
          scenario: {
            type: "object",
            properties: {
              name: { type: "string" },
              persona: {
                type: "object",
                properties: {
                  personality: { type: "string" },
                  emotional_state: { type: "string" },
                  behavioral_traits: { type: "array", items: { type: "string" } },
                  details_json: {
                    type: "string",
                    description:
                      'JSON-encoded object of caller details (e.g., caller_name, phone_number, lead-specific keys). Use "{}" if none.',
                  },
                },
                required: ["personality", "emotional_state", "behavioral_traits", "details_json"],
                additionalProperties: false,
              },
              goal: {
                type: "string",
                description:
                  "Conversational instructions for the simulated caller, describing what they want to accomplish. Always include this field; never leave it empty.",
              },
              language: { type: "string" },
              world_state: {
                type: "array",
                description:
                  "One entry per mockable node this scenario touches on its route. Use an empty array if the scenario does not touch any mockable nodes.",
                items: {
                  type: "object",
                  properties: {
                    node_id: { type: "string" },
                    outcome: { type: "string" },
                    data_json: {
                      type: "string",
                      description: 'JSON-encoded object of mock response variables. Use "{}" if none.',
                    },
                    action_mocks_json: {
                      type: "string",
                      description:
                        'JSON-encoded object keyed by embedded action tool name. Each value is the mock JSON response object. Use "{}" if none.',
                    },
                  },
                  required: ["node_id", "outcome", "data_json", "action_mocks_json"],
                  additionalProperties: false,
                },
              },
              start_node_params_json: {
                type: "string",
                description:
                  'JSON-encoded object of start_node trigger parameter values, keyed by parameter name. Use "{}" if no start node params are required.',
              },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["name", "persona", "goal", "language", "world_state", "start_node_params_json", "tags"],
            additionalProperties: false,
          },
        },
        required: ["slot_id", "scenario"],
        additionalProperties: false,
      },
    },
  },
  required: ["agent_flow_description", "scenario_items"],
  additionalProperties: false,
};

// ── Zod validators (parse the LLM output) ──────────────────────────────────────

export const RouteAnchorZ = z
  .object({
    source_node_id: z.string(),
    intent_name: z.string(),
    target_node_type: z.string(),
    support: z.enum(["fully_executable", "supported_terminal", "blocked"]),
  })
  .passthrough();

export const SmokeUnitZ = z
  .object({
    unit_id: z.string(),
    kind: z.enum(["happy_path", "boundary"]),
    route_id: z.string().optional(),
    scenario_type: z.enum(["clean_baseline", "boundary_pressure"]),
    description: z.string(),
  })
  .passthrough();

export const CapabilityZ = z
  .object({
    capability_id: z.string(),
    name: z.string(),
    description: z.string(),
    priority: z.enum(["core", "secondary", "boundary"]),
    risk: z.enum(["high", "medium", "low"]),
    source_signals: z.array(z.string()),
    success_criteria: z.array(z.string()),
    route_anchors: z.array(RouteAnchorZ).optional().default([]),
    action_anchors: z.array(z.string()).optional().default([]),
    variable_anchors: z.array(z.string()).optional().default([]),
    recommended_conversation_patterns: z.array(z.string()).optional().default([]),
    boundary_patterns: z.array(z.string()).optional().default([]),
    smoke_units: z.array(SmokeUnitZ).optional().default([]),
  })
  .passthrough();

// Planner is strict:false → keep the validator lenient (passthrough) so extra
// fields the model adds don't fail the parse.
export const PlannerOutputZ = z
  .object({
    agent_flow_description: z.string(),
    capabilities: z.array(CapabilityZ),
    blocked_or_deferred_outcomes: z
      .array(z.object({ capability_or_route: z.string(), reason: z.string() }).passthrough())
      .optional()
      .default([]),
    planner_rationale: z.string(),
  })
  .passthrough();

const WriterWorldStateEntryZ = z.object({
  node_id: z.string(),
  outcome: z.string(),
  data_json: z.string(),
  action_mocks_json: z.string(),
});

const WriterPersonaZ = z.object({
  personality: z.string(),
  emotional_state: z.string(),
  behavioral_traits: z.array(z.string()),
  details_json: z.string(),
});

export const WriterScenarioZ = z.object({
  name: z.string(),
  persona: WriterPersonaZ,
  goal: z.string(),
  language: z.string(),
  world_state: z.array(WriterWorldStateEntryZ),
  start_node_params_json: z.string(),
  tags: z.array(z.string()),
});

export const WriterOutputZ = z.object({
  agent_flow_description: z.string(),
  scenario_items: z.array(z.object({ slot_id: z.string(), scenario: WriterScenarioZ })),
});

export type Capability = z.infer<typeof CapabilityZ>;
export type RouteAnchor = z.infer<typeof RouteAnchorZ>;
export type SmokeUnit = z.infer<typeof SmokeUnitZ>;
export type PlannerOutput = z.infer<typeof PlannerOutputZ>;
export type WriterScenario = z.infer<typeof WriterScenarioZ>;
export type WriterOutput = z.infer<typeof WriterOutputZ>;
