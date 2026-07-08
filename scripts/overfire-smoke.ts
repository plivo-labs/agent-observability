/**
 * Over-fire smoke harness for the AO judges (live LLM).
 *
 * Proves the calibration restored on feat/ao-judge-parity does NOT over-fire on
 * the classic traps the SDK-compressed prompts got wrong. Each case is a scenario
 * a well-calibrated judge should PASS; a fail here = the judge over-fired.
 *
 * Run from the agent-observability repo root (auto-loads .env):
 *   OPENAI_API_KEY=... JUDGE_LLM_MODEL=gpt-5.4 LLM_PROVIDER=openai \
 *   OPENAI_API_MODE=responses OPENAI_BASE_URL=... \
 *   bun run scripts/overfire-smoke.ts
 * (Anthropic: ANTHROPIC_API_KEY=... LLM_PROVIDER=anthropic JUDGE_LLM_MODEL=claude-opus-4-8)
 *
 * Uses the real provider resolved from env — no provider is injected, so this
 * exercises the exact path production uses. Read-only; makes ~5 judge calls.
 */
import { runInstructionAdherenceJudge, runHallucinationJudge, runLoopJudge, runVariableExtractionJudge } from "../src/evals-engine/judges/node-judges.js";
import type { ConversationInput, NodeEvalInput } from "../src/evals-engine/types.js";

const baseCtx = (over: Partial<ConversationInput> = {}): ConversationInput => ({
  flow_name: "smoke",
  global_prompt: "You are a helpful support agent for Acme.",
  nodes: [],
  goals: [],
  full_transcript: "",
  ...over,
});
const baseNode = (over: Partial<NodeEvalInput> = {}): NodeEvalInput => ({
  node_uuid: "n1",
  node_name: "node",
  node_prompt: "",
  available_intents: [],
  chosen_intent: "",
  required_variables: [],
  extracted_variables: {},
  turns: [],
  turn_count: 0,
  ...over,
});

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${name}\n         ${detail}\n`);
  ok ? passed++ : failed++;
};

async function run() {
  // 1) ADHERENCE — objective met, wording deviates from a "MUST say exactly" script.
  //    Calibrated verdict: adherence_passed=true, no CRITICAL missed step.
  {
    const node = baseNode({
      node_name: "greet_and_collect",
      node_prompt: "You MUST greet the caller by saying exactly: 'Good morning, thank you for calling Acme.' Then collect the order id and confirm it.",
      turns: [
        { node_uuid: "n1", user: "", agent: "Hi there! Thanks for reaching Acme. Can I grab your order id?", intent: "" },
        { node_uuid: "n1", user: "It's 4471", agent: "Great, order 4471 — got it.", intent: "" },
      ],
      turn_count: 2,
    });
    const ctx = baseCtx({ full_transcript: "Agent: Hi there! Thanks for reaching Acme. Can I grab your order id?\nUser: It's 4471\nAgent: Great, order 4471 — got it." });
    const { data } = await runInstructionAdherenceJudge(node, ctx);
    // The judge returns the RAW 4 sub-metrics; `adherence_passed` is derived
    // downstream (aggregate.ts) as objective.achieved ∧ no-critical-step ∧ policy.passed.
    const crit = data.procedure_compliance?.missed_steps?.some((m) => m.severity === "critical") ?? false;
    const objectiveMet = data.objective_progress?.achieved === true;
    const policyOk = data.policy_boundary_compliance?.passed === true;
    const adherencePassed = objectiveMet && !crit && policyOk;
    check("adherence: wording deviation on a met objective is NOT critical", adherencePassed,
      `objective_achieved=${objectiveMet} critical_missed=${crit} policy_passed=${policyOk}`);
  }

  // 2) HALLUCINATION — agent cites a value present only in global_variables.
  //    Calibrated verdict: hallucinated=false (grounded by runtime context).
  {
    const node = baseNode({
      node_name: "verify_identity",
      node_prompt: "Confirm you are speaking with the account holder.",
      turns: [
        { node_uuid: "n1", user: "who is this?", agent: "This is Acme. I see you're calling from 415-555-0142 — is that right?", intent: "" },
      ],
      turn_count: 1,
    });
    const ctx = baseCtx({
      full_transcript: "User: who is this?\nAgent: This is Acme. I see you're calling from 415-555-0142 — is that right?",
      global_variables: { caller_number: "+14155550142" },
    });
    const { data } = await runHallucinationJudge(node, ctx);
    check("hallucination: a value from global_variables is grounded", data.hallucinated === false,
      `hallucinated=${data.hallucinated} reason=${data.reason}`);
  }

  // 3) LOOP — repeated re-engagement while the user is silent.
  //    Calibrated verdict: loop_detected=false (idle re-engagement is exempt).
  {
    const node = baseNode({
      node_name: "collect_order",
      node_prompt: "Collect the order id.",
      turns: [
        { node_uuid: "n1", user: "", agent: "What's your order id?", intent: "" },
        { node_uuid: "n1", user: "", agent: "Are you still there? I can wait — what's your order id?", intent: "" },
        { node_uuid: "n1", user: "", agent: "Still here whenever you're ready — could you share your order id?", intent: "" },
      ],
      turn_count: 3,
    });
    const ctx = baseCtx({ full_transcript: "Agent: What's your order id?\nAgent: Are you still there? I can wait — what's your order id?\nAgent: Still here whenever you're ready — could you share your order id?" });
    const { data } = await runLoopJudge(node, ctx);
    check("loop: idle re-engagement is NOT a loop", data.loop_detected === false,
      `loop_detected=${data.loop_detected} reason=${data.reason}`);
  }

  // 4) VARIABLE — spoken digits normalized to a compact value.
  //    Calibrated verdict: extraction_successful=true (normalization is expected).
  {
    const node = baseNode({
      node_name: "collect_order",
      node_prompt: "Ask for the order id and store it.",
      required_variables: ["order_id"],
      variable_rules: { order_id: "The numeric order identifier the caller provides." },
      extracted_variables: { order_id: "1234" },
      turns: [
        { node_uuid: "n1", user: "", agent: "What's your order id?", intent: "" },
        { node_uuid: "n1", user: "one two three four", agent: "Thanks, order 1234.", intent: "" },
      ],
      turn_count: 2,
    });
    const ctx = baseCtx({ full_transcript: "Agent: What's your order id?\nUser: one two three four\nAgent: Thanks, order 1234." });
    const { data } = await runVariableExtractionJudge(node, ctx);
    check("variable: spoken digits normalized to '1234' is correct", data.extraction_successful === true,
      `extraction_successful=${data.extraction_successful} missing=${JSON.stringify(data.missing_variables)} incorrect=${JSON.stringify(data.incorrect_variables)}`);
  }

  console.log(`\n── over-fire smoke: ${passed} passed, ${failed} failed ──`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error("harness error (check LLM env: provider/key/model):", e?.message ?? e);
  process.exit(2);
});
