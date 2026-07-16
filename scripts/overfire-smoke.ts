/**
 * Over-fire smoke harness for the AO judges (live LLM).
 *
 * Proves the calibration restored on feat/ao-judge-parity does NOT over-fire on
 * the classic traps the SDK-compressed prompts got wrong. Each case is a scenario
 * a well-calibrated judge should PASS; a fail here = the judge over-fired.
 *
 * Provider config comes from env. In dev/prod it is set via consul; the vars
 * below are only for running this harness manually from the repo root (auto-loads .env):
 *   OPENAI_API_KEY=... JUDGE_MODEL=gpt-5.4 LLM_PROVIDER=openai \
 *   OPENAI_API_MODE=responses OPENAI_BASE_URL=... \
 *   bun run scripts/overfire-smoke.ts
 * (Anthropic: ANTHROPIC_API_KEY=... LLM_PROVIDER=anthropic JUDGE_MODEL=claude-opus-4-8)
 * NOTE: the var is JUDGE_MODEL, not JUDGE_LLM_MODEL — the judge role reads JUDGE_MODEL
 * (else it defaults to gpt-4.1-mini → Azure DeploymentNotFound).
 *
 * Uses the real provider resolved from env — no provider is injected, so this
 * exercises the exact path production uses. Read-only; makes ~15 judge calls.
 * Set SMOKE_JUDGE=variable to run only the Variable Extraction cases.
 */
import { runInstructionAdherenceJudge, runHallucinationJudge, runLoopJudge } from "../src/evals-engine/judges/node-judges.js";
import { runVariableExtractionJudge } from "../src/evals-engine/judges/variable-extraction.js";
import { deriveInstructionAdherence } from "../src/evals-engine/aggregate.js";
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

async function checkVariableCase(
  name: string,
  node: NodeEvalInput,
  ctx: ConversationInput,
  expectedSuccessful: boolean,
) {
  const { data } = await runVariableExtractionJudge(node, ctx);
  check(
    name,
    data.extraction_successful === expectedSuccessful,
    `expected=${expectedSuccessful} extraction_successful=${data.extraction_successful} missing=${JSON.stringify(data.missing_variables)} incorrect=${JSON.stringify(data.incorrect_variables)} reason=${data.reason}`,
  );
}

async function run() {
  const variableOnly = process.env.SMOKE_JUDGE === "variable";
  if (!variableOnly) {
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
    // The judge returns the RAW 4 sub-metrics; run them through the canonical
    // aggregate rule rather than re-deriving it here, so this harness can't
    // drift from the production adherence_passed logic it exists to guard.
    const adherence = deriveInstructionAdherence(data);
    check("adherence: wording deviation on a met objective is NOT critical", adherence.adherence_passed,
      `objective_achieved=${adherence.objective_progress?.achieved} procedure_passed=${adherence.procedure_compliance?.passed} policy_passed=${adherence.policy_boundary_compliance?.passed}`);
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

  // 5) VARIABLE PRECISION — Round-4 clean cases that previously over-fired.
  await checkVariableCase(
    "variable: a derived year the caller never stated is NOT missing",
    baseNode({
      node_name: "education",
      node_prompt: "Ask for the graduation year and record it only when the caller states a year.",
      required_variables: ["graduation_year"],
      variable_rules: { graduation_year: "The four-digit year explicitly stated by the caller." },
      extracted_variables: {},
      turns: [{ node_uuid: "n1", user: "I completed it last year.", agent: "Thanks.", intent: "" }],
      turn_count: 1,
    }),
    baseCtx({ full_transcript: "User: I completed it last year.\nAgent: Thanks." }),
    true,
  );

  await checkVariableCase(
    "variable: one statement need not be duplicated into a sibling variable",
    baseNode({
      node_name: "team_size",
      node_prompt: "Collect the number of callers and team size when separately provided.",
      required_variables: ["number_of_callers", "team_size"],
      variable_rules: {
        number_of_callers: "The number of telecallers stated by the caller.",
        team_size: "A separately stated total team size, if provided.",
      },
      extracted_variables: { number_of_callers: 5 },
      turns: [{ node_uuid: "n1", user: "We have five telecallers.", agent: "Got it.", intent: "" }],
      turn_count: 1,
    }),
    baseCtx({ full_transcript: "User: We have five telecallers.\nAgent: Got it." }),
    true,
  );

  await checkVariableCase(
    "variable: an unopened gate does NOT require a negative default",
    baseNode({
      node_name: "qualification",
      node_prompt: "Discuss CRM only when the caller has time; otherwise arrange a callback.",
      required_variables: ["crm_requirement_valid"],
      variable_rules: { crm_requirement_valid: "Record yes or no only after the CRM requirement is discussed." },
      extracted_variables: {},
      turns: [{ node_uuid: "n1", user: "I'm busy, please call tomorrow.", agent: "Sure, I will call tomorrow.", intent: "" }],
      turn_count: 1,
    }),
    baseCtx({ full_transcript: "User: I'm busy, please call tomorrow.\nAgent: Sure, I will call tomorrow." }),
    true,
  );

  await checkVariableCase(
    "variable: a config-directed default need not be spoken literally",
    baseNode({
      node_name: "form_confirmation",
      node_prompt: "Treat the form as remembered unless the caller disputes submitting it.",
      required_variables: ["form_recall_confirmed"],
      variable_rules: { form_recall_confirmed: "Record yes when the caller remembers OR does not dispute submitting the form; otherwise no." },
      extracted_variables: { form_recall_confirmed: "yes" },
      turns: [{ node_uuid: "n1", user: "Hello?", agent: "I'm calling about the form you submitted.", intent: "" }],
      turn_count: 1,
    }),
    baseCtx({ full_transcript: "User: Hello?\nAgent: I'm calling about the form you submitted." }),
    true,
  );

  await checkVariableCase(
    "variable: supported agent-authored summaries and labels are fact-grounded",
    baseNode({
      node_name: "callback",
      node_prompt: "Summarize the call and assign the workflow disposition.",
      required_variables: ["conversation_summary", "outcome_status"],
      variable_rules: {
        conversation_summary: "A concise agent-authored factual summary.",
        outcome_status: "An agent-authored workflow status label.",
      },
      extracted_variables: { conversation_summary: "Caller requested a callback tomorrow.", outcome_status: "follow_up" },
      turns: [{ node_uuid: "n1", user: "Please call me tomorrow.", agent: "Sure.", intent: "" }],
      turn_count: 1,
    }),
    baseCtx({ full_transcript: "User: Please call me tomorrow.\nAgent: Sure." }),
    true,
  );

  await checkVariableCase(
    "variable: backend ids and lookup values are NOT caller extraction misses",
    baseNode({
      node_name: "property_lookup",
      node_prompt: "Search listings and discuss available properties.",
      required_variables: ["property_id", "monthly_rent", "property_size"],
      variable_rules: {
        property_id: "Internal backend property identifier returned by the listing lookup.",
        monthly_rent: "Rent returned by the listing lookup.",
        property_size: "Size returned by the listing lookup.",
      },
      extracted_variables: {},
      turns: [{ node_uuid: "n1", user: "Show me a two-bedroom near downtown.", agent: "I found one that may work.", intent: "" }],
      turn_count: 1,
    }),
    baseCtx({
      full_transcript: "User: Show me a two-bedroom near downtown.\nTool_Result: {\"property_id\":\"internal-742\",\"monthly_rent\":2200,\"property_size\":950}\nAgent: I found one that may work.",
      global_variables: { property_id: "internal-742", monthly_rent: "2200", property_size: "950" },
    }),
    true,
  );

  await checkVariableCase(
    "variable: a visibly truncated call is not a completed recording miss",
    baseNode({
      node_name: "lead_transfer",
      node_prompt: "Confirm lead details, then record them immediately before the final transfer or ending outcome.",
      required_variables: ["budget", "preferred_city", "purchase_goal"],
      variable_rules: {
        budget: "The caller-stated budget.",
        preferred_city: "The caller-stated city.",
        purchase_goal: "The caller-stated purchase goal.",
      },
      extracted_variables: {},
      turns: [
        { node_uuid: "n1", user: "Budget is 50 lakh, Bengaluru, for my own home.", agent: "", intent: "" },
        { node_uuid: "n1", user: "", agent: "Let me explain the transfer process— [interrupted]", intent: "" },
        { node_uuid: "n1", user: "Okay", agent: "", intent: "" },
      ],
      turn_count: 3,
    }),
    baseCtx({ full_transcript: "User: Budget is 50 lakh, Bengaluru, for my own home.\nAgent: Let me explain the transfer process— [interrupted]\nUser: Okay" }),
    true,
  );

  // 6) VARIABLE RECALL — true defects must still fire after precision tightening.
  await checkVariableCase(
    "variable: a caller-stated value omitted on a completed call IS missing",
    baseNode({
      node_name: "collect_name",
      node_prompt: "Collect and record the caller's name.",
      required_variables: ["customer_name"],
      variable_rules: { customer_name: "The name explicitly stated by the caller." },
      extracted_variables: {},
      turns: [{ node_uuid: "n1", user: "My name is Vijay.", agent: "Thank you, Vijay. Goodbye.", intent: "" }],
      turn_count: 1,
    }),
    baseCtx({ full_transcript: "User: My name is Vijay.\nAgent: Thank you, Vijay. Goodbye." }),
    false,
  );

  await checkVariableCase(
    "variable: vague speech cannot be converted into a precise bucket",
    baseNode({
      node_name: "caller_count",
      node_prompt: "Record an exact caller-count bucket only when the caller expresses that bucket.",
      required_variables: ["number_of_callers"],
      variable_rules: { number_of_callers: "One of: one, two-to-six, more-than-six; record only when explicitly supported." },
      extracted_variables: { number_of_callers: "more-than-six" },
      turns: [{ node_uuid: "n1", user: "There are a lot.", agent: "Understood.", intent: "" }],
      turn_count: 1,
    }),
    baseCtx({ full_transcript: "User: There are a lot.\nAgent: Understood." }),
    false,
  );

  await checkVariableCase(
    "variable: a fabricated value inside a recording tool IS incorrect",
    baseNode({
      node_name: "collect_name",
      node_prompt: "Collect and record the caller's name.",
      required_variables: ["customer_name"],
      variable_rules: { customer_name: "The caller's explicitly stated name." },
      extracted_variables: { customer_name: "I want to book an appointment" },
      turns: [{ node_uuid: "n1", user: "I want to book an appointment.", agent: "Sure.", intent: "" }],
      turn_count: 1,
    }),
    baseCtx({ full_transcript: "User: I want to book an appointment.\nAgent: Sure." }),
    false,
  );

  await checkVariableCase(
    "variable: a completed screening that records none of the stated answers IS a failure",
    baseNode({
      node_name: "screening",
      node_prompt: "Collect and record each screening answer before completing the call.",
      required_variables: ["years_experience", "notice_period", "current_ctc"],
      variable_rules: {
        years_experience: "The explicitly stated years of experience.",
        notice_period: "The explicitly stated notice period.",
        current_ctc: "The explicitly stated current CTC.",
      },
      extracted_variables: {},
      turns: [{ node_uuid: "n1", user: "I have four years, a 30-day notice, and my current CTC is 12 lakh.", agent: "That completes the screening. Thank you.", intent: "" }],
      turn_count: 1,
    }),
    baseCtx({ full_transcript: "User: I have four years, a 30-day notice, and my current CTC is 12 lakh.\nAgent: That completes the screening. Thank you." }),
    false,
  );

  if (!variableOnly) {
  // 7) ADHERENCE — transcript carries internal-event lines (Tool_Call/Agent_Handoff/System_Note).
  //    These are runtime annotations rendered as context, NOT agent speech. A mis-calibrated judge
  //    reads them as the agent revealing internals / breaking a silent handoff and fails adherence.
  //    Calibrated verdict: adherence_passed=true, no CRITICAL missed step.
  {
    const node = baseNode({
      node_name: "route_to_billing",
      node_prompt: "When the caller asks about a charge, hand off to billing SILENTLY. NEVER mention internal tools, systems, or transfers to the caller.",
      turns: [
        { node_uuid: "n1", user: "why was I charged twice?", agent: "Let me pull that up for you right away.", intent: "" },
        { node_uuid: "n1", user: "", agent: "Tool_Call: lookup_charges(account=***)", intent: "" },
        { node_uuid: "n1", user: "", agent: "Tool_Result: {\"charges\": 2}", intent: "" },
        { node_uuid: "n1", user: "", agent: "Agent_Handoff: billing", intent: "" },
        { node_uuid: "n1", user: "", agent: "System_Note: transferring to billing specialist", intent: "" },
        { node_uuid: "n1", user: "", agent: "One moment while I connect you to the right person.", intent: "" },
      ],
      turn_count: 6,
    });
    const ctx = baseCtx({ full_transcript: "User: why was I charged twice?\nAgent: Let me pull that up for you right away.\nAgent: Tool_Call: lookup_charges(account=***)\nAgent: Tool_Result: {\"charges\": 2}\nAgent: Agent_Handoff: billing\nAgent: System_Note: transferring to billing specialist\nAgent: One moment while I connect you to the right person." });
    const { data } = await runInstructionAdherenceJudge(node, ctx);
    const crit = data.procedure_compliance?.missed_steps?.some((m) => m.severity === "critical") ?? false;
    const objectiveMet = data.objective_progress?.achieved === true;
    const policyOk = data.policy_boundary_compliance?.passed === true;
    const adherencePassed = objectiveMet && !crit && policyOk;
    check("adherence: Tool_Call/Handoff/System_Note lines are NOT agent speech (no silent-handoff/reveal fail)", adherencePassed,
      `objective_achieved=${objectiveMet} critical_missed=${crit} policy_passed=${policyOk}`);
  }
  }

  console.log(`\n── over-fire smoke: ${passed} passed, ${failed} failed ──`);
  process.exit(failed ? 1 : 0);
}

run().catch((e) => {
  console.error("harness error (check LLM env: provider/key/model):", e?.message ?? e);
  process.exit(2);
});
