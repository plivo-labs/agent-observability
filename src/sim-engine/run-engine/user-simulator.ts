// AO Simulation Engine — UserSimulator (the simulated caller LLM).
//
// Port of the reference worker `usecases/simulation_eval/user_simulator.go` +
// `prompts/user_simulator.tmpl` + `behavioral_traits.go`. Each turn the engine asks an
// LLM to produce the simulated caller's NEXT utterance, given the persona, goal,
// behavioral traits, conversation history, the active mode (normal / interruption /
// non-answer), language register, and STT-noise severity.
//
// THE PROMPT TEMPLATE IS PINNED FOR PARITY. `buildUserSimulatorPrompt` reproduces the
// `.tmpl` output byte-for-byte (a later parity test diffs AO's render against the
// worker's). Go uses `text/template`; we hand-render here. The `{{- ... }}` / `{{ ... -}}`
// trim markers in the source map to the join/blank-line rules in the section builders
// below — read `tmplBlock` / `renderSection` for how that mapping works.
//
// The LLM call REUSES AO's `completeJSON` (role "simulator"): one structured call that
// must return `{ message: string }`, with a single retry when the message is empty —
// mirroring the Go `GenerateUserMessage` retry-on-empty.

import { z } from "zod";
import { completeJSON, type LlmProvider } from "../../llm/index.js";
import type { Scenario, ScenarioPersona } from "../schema.js";

// ─────────────────────────────────────────────────────────────────────────────
// Behavioral traits (port of behavioral_traits.go)
// ─────────────────────────────────────────────────────────────────────────────

// Maps a known trait token to a one-line behavioral directive. Unknown traits are
// intentionally left unexpanded — they still appear verbatim in the
// "Behavioral traits guidance:" line, preserving the open taxonomy the generator relies on.
const TRAIT_DIRECTIVES: Record<string, string> = {
  // --- Existing canonical conversational traits ---
  cooperative: "Answer directly and follow the agent's flow without friction.",
  self_corrects: 'Change an answer mid-utterance once in a while ("Boston — wait, Chicago").',
  goes_off_topic: "Occasionally drift into an unrelated question or remark before returning to the task.",
  tests_if_bot: 'Now and then probe whether you\'re talking to a bot ("are you a real person?").',
  gives_partial_info: 'Answer incompletely so the agent has to follow up ("next month" instead of a date).',
  contradicts_self: "Occasionally say one thing then reverse it a turn later.",
  asks_questions_mid_flow: 'Sometimes ask a clarifying question before you answer ("why do you need that?").',
  hesitant: 'Sound unsure and seek reassurance before committing ("I\'m not sure about this...").',
  rushes: "Try to hurry the call along and skip steps; show you want to get to the point fast.",
  provides_unsolicited_info: "Occasionally volunteer a neighboring detail that wasn't asked for.",
  gives_wrong_format: 'Give values in the wrong format ("next Tuesday" for a date, "my cell" for a number).',
  switches_language: "Start in one language and switch to another mid-conversation.",

  // --- Name-capture traits (entity discipline) ---
  name_spells_then_self_doubts:
    'When spelling your name, flub a letter or second-guess a homophone mid-spell ("Catherine — with a C, no, a K").',
  nickname_legal_mismatch:
    'Offer a nickname while the record holds your legal name ("It\'s Bob — well, Robert on the account").',
  inconsistent_spelling_alphabet:
    'Mix NATO words, ad-hoc \'as-in\' words, and bare letters when spelling ("M like Mary, A, R, T as in Tom").',
  accent_minimal_pair_collapse:
    "Pronounce your name so a minimal pair merges (v/w, th/t), then re-collapse it when you spell it.",

  // --- Number-capture traits (entity discipline) ---
  digit_chunk_dribble:
    "Release a long number a few digits at a time across turns, pausing for the agent to keep up.",
  teens_tens_oh_zero_ambiguity:
    'Use "oh" for zero, "double/triple", and teen/tens forms that sound alike (fifteen/fifty).',
  digit_transposition_self_correct:
    'State a number, then flip two adjacent digits as a correction ("seventy-two — sorry, twenty-seven").',
  digit_transposition:
    "When you say a number, occasionally swap two adjacent digits before settling on the right one.",
  alphanumeric_separator_dropout:
    "Drop spoken hyphens/slashes in IDs and conflate letter-O/zero, letter-I/one.",

  // --- Turn-taking traits ---
  backchannel_then_silence: "Sometimes say a filler acknowledgment then trail into a long pause.",
  barges_over_confirmation: "Occasionally cut in over the agent's read-back with new or contradicting info.",

  // --- Adversarial / grounding traits ---
  confirms_wrong_readback: "Sometimes agree to an incorrect read-back, then catch the error a turn or two later.",

  // --- Emotion / disfluency traits ---
  escalating_impatience: "Start neutral; grow clipped and mildly blaming if the call drags or the agent re-asks.",
  false_start_restart: "Occasionally begin an utterance, abandon it, and restart with different phrasing.",
  distracted_out_of_turn: "Now and then emit brief side-speech to someone off-call before returning.",
};

// Traits about producing identifying info (name / number) messily. When any is active,
// the simulator is told to withhold identifiers and only resolve them on request.
const ENTITY_CAPTURE_TRAITS = new Set<string>([
  "name_spells_then_self_doubts",
  "nickname_legal_mismatch",
  "inconsistent_spelling_alphabet",
  "accent_minimal_pair_collapse",
  "digit_chunk_dribble",
  "teens_tens_oh_zero_ambiguity",
  "digit_transposition_self_correct",
  "digit_transposition",
  "alphanumeric_separator_dropout",
]);

const ENTITY_DISCIPLINE_DIRECTIVE =
  "Never recite your name, phone, account, or order number cleanly up front — give it messily or in fragments, and only produce a clean, spelled-out version after the agent asks you to confirm, repeat, or spell it.";

/**
 * Return concrete directives for the known traits, in the order given, appending the
 * entity-discipline directive once if any name/number-capture trait is present. Unknown
 * traits are skipped (no fabricated directive). Mirrors Go's `expandTraitDirectives`.
 */
export function expandTraitDirectives(traits: string[]): string[] {
  const directives: string[] = [];
  let anyEntity = false;
  for (const t of traits) {
    if (ENTITY_CAPTURE_TRAITS.has(t)) anyEntity = true;
    const d = TRAIT_DIRECTIVES[t];
    if (d !== undefined) directives.push(d);
  }
  if (anyEntity) directives.push(ENTITY_DISCIPLINE_DIRECTIVE);
  return directives;
}

// ─────────────────────────────────────────────────────────────────────────────
// Conversation history shape (port of ConversationTurn)
// ─────────────────────────────────────────────────────────────────────────────

/** One turn of conversation history fed to the simulator. Mirrors Go `ConversationTurn`. */
export interface ConversationTurn {
  role: string; // "user" | "assistant"
  content: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt assembly (port of buildUserSimulatorPrompt + user_simulator.tmpl)
// ─────────────────────────────────────────────────────────────────────────────

/** caller_name from persona.details, else "Customer". Mirrors Go `getCallerName`. */
function getCallerName(persona: ScenarioPersona): string {
  const n = persona.details?.["caller_name"];
  if (typeof n === "string" && n !== "") return n;
  return "Customer";
}

/**
 * Format persona.details as sorted `- key: value` lines. Mirrors Go `formatPersonaDetails`:
 * keys sorted lexicographically; value stringified Go-`%v`-style. Empty details → no lines.
 */
function formatPersonaDetails(details: Record<string, unknown>): string[] {
  const keys = Object.keys(details ?? {});
  if (keys.length === 0) return [];
  keys.sort();
  return keys.map((k) => `- ${k}: ${formatDetailValue(details[k])}`);
}

/** Go `%v` formatting for a detail value (string/number/bool/array/object/null). */
function formatDetailValue(val: unknown): string {
  if (val === null || val === undefined) return "<nil>";
  if (typeof val === "string") return val;
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") return String(val);
  if (Array.isArray(val)) return "[" + val.map(formatDetailValue).join(" ") + "]";
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const ks = Object.keys(obj).sort();
    return "map[" + ks.map((k) => `${k}:${formatDetailValue(obj[k])}`).join(" ") + "]";
  }
  return String(val);
}

/** Format history into "Customer: …" / "Agent: …" lines. Mirrors Go `formatConversationHistory`. */
function formatConversationHistory(history: ConversationTurn[]): string[] {
  if (!history || history.length === 0) return [];
  return history.map((turn) => (turn.role === "user" ? `Customer: ${turn.content}` : `Agent: ${turn.content}`));
}

/** Case-insensitive equality (Go `strings.EqualFold`, ASCII-sufficient for our values). */
function equalFold(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The data the template renders against — mirrors the Go anonymous struct field-for-field. */
interface PromptData {
  isOutboundCall: boolean;
  agentFlowDescription: string;
  identity: string;
  communicationStyle: string;
  emotionalStateGuidance: string;
  behavioralTraitsGuidance: string;
  traitDirections: string[];
  details: string[];
  goal: string;
  language: string;
  includeLanguageInstruction: boolean;
  useHindiScript: boolean;
  useIndianRegister: boolean;
  history: string[];
  isInterruption: boolean;
  partialAssistantMsg: string;
  sttNoiseEnabled: boolean;
  sttNoiseSeverity: string;
  isNonAnswer: boolean;
  nonAnswerType: string;
}

/**
 * Build the user-simulator prompt. VERBATIM port of `user_simulator.tmpl` — the section
 * order, headings, bullet text, and conditional blocks match the Go template exactly so
 * AO's render is byte-identical to the worker's. The `lines.push(...)` sequence below
 * tracks the template top-to-bottom; `{{- ... }}` trim markers in the source become the
 * "no blank line before this block" behavior here.
 */
export function buildUserSimulatorPrompt(
  scenario: Pick<Scenario, "persona" | "goal" | "language" | "stt_noise"> & { persona: ScenarioPersona },
  history: ConversationTurn[],
  agentFlowDescription: string,
  isOutboundCall: boolean,
  partialAssistantMsg: string,
  nonAnswerType: string,
): string {
  const persona = scenario.persona;
  const language = scenario.language ?? "";
  const lang = language.toLowerCase();

  const data: PromptData = {
    isOutboundCall,
    agentFlowDescription,
    identity: getCallerName(persona),
    communicationStyle: persona.personality,
    emotionalStateGuidance: persona.emotional_state,
    behavioralTraitsGuidance: persona.behavioral_traits.join("; "),
    traitDirections: expandTraitDirectives(persona.behavioral_traits),
    details: formatPersonaDetails(persona.details),
    goal: scenario.goal,
    language,
    includeLanguageInstruction: language !== "" && !equalFold(language, "English"),
    useHindiScript: lang.includes("hindi"),
    useIndianRegister: lang.includes("hindi") || lang.includes("hinglish") || lang.includes("indian"),
    history: formatConversationHistory(history),
    isInterruption: partialAssistantMsg !== "",
    partialAssistantMsg,
    sttNoiseEnabled: scenario.stt_noise.enabled,
    sttNoiseSeverity: scenario.stt_noise.severity,
    isNonAnswer: nonAnswerType !== "",
    nonAnswerType,
  };

  // Each entry is one rendered line. We build the document line-by-line to reproduce the
  // Go template's exact whitespace. Blank lines that exist literally in the .tmpl are
  // emitted as "" entries; `{{- }}`-trimmed blocks attach directly to the preceding line.
  const lines: string[] = [];

  lines.push("You are simulating a real customer on a phone call. ");
  // {{if .IsOutboundCall}} ... {{else}} ... {{end}} — NO trim markers, so every newline
  // around the actions renders literally. Both branches end with the block's own trailing
  // newline PLUS the source's "\n\n" after {{end}}, i.e. two blank lines before WHAT COUNTS.
  if (data.isOutboundCall) {
    lines.push("");
    lines.push(
      "You received this call — someone called your phone. You did not expect this call and do not know who is calling or what it is about until they tell you. Listen first; do NOT volunteer any information (including your name) until the agent specifically asks for it.",
    );
    lines.push("");
    lines.push("");
  } else {
    lines.push("You initiated this call.");
    lines.push("");
    lines.push("");
  }

  lines.push("WHAT COUNTS AS A COMPLETE RESPONSE");
  lines.push("You produce ONE customer utterance per turn. The utterance is complete when:");
  lines.push("- It is a single spoken turn that fits naturally in the conversation flow.");
  lines.push("- It satisfies the active mode (one of: normal, interruption, or non-answer).");
  lines.push(
    "- It is consistent with your persona (identity, communication style, emotional state, behavioral traits).",
  );
  lines.push("- It does not violate any HARD-FORBID rule.");
  lines.push("");
  lines.push(
    "The rates, proportions, and frequencies described below are character-level guidance, not per-turn budgets. Do not try to satisfy every rate on every turn — pick what is natural for this moment given the conversation history and your persona.",
  );
  lines.push("");
  lines.push("LENGTH AND SHAPE (character profile, not per-turn budget)");
  lines.push("You speak in short, varied turns the way a real customer does on a phone call. Across the whole conversation:");
  lines.push("- Most turns are short — one to a few words for confirmations, simple questions, and acknowledgments.");
  lines.push("- Some turns are medium — five to about a dozen words when you genuinely need to qualify, push back, or explain.");
  lines.push("- Long turns (15+ words) are uncommon and reserved for genuine explanations.");
  lines.push("- Hard ceiling: 20 words. If you have more to say, hold the rest for your next turn.");
  lines.push("");
  lines.push("Yes/no questions get a short answer (1–3 words).");
  lines.push("When the agent asks for one item, vary the shape across turns:");
  lines.push('- Sometimes bare — "[answer]."');
  lines.push(
    '- Rarely with an inseparable neighboring detail — "[answer], [directly attached detail]." For example, a campus/city only if it is how a real caller would normally identify the place. Do not use this to advance private context or answer questions the agent did not ask.',
  );
  lines.push(
    '- Sometimes with a light hedge if you are uncertain — "[answer]" preceded or followed by an uncertainty marker.',
  );
  lines.push("Don't preamble. Avoid using the same shape on consecutive single-item turns.");
  lines.push("");
  lines.push("Answer what was asked. Don't pre-emptively explain. Then stop.");

  // {{- if .AgentFlowDescription}} — leading trim: attaches to the line above (no blank line
  // between "Then stop." and the block). The block itself begins with a blank line, then
  // "Service: …". {{- end}} trims trailing whitespace.
  if (data.agentFlowDescription) {
    lines.push("");
    lines.push(`Service: ${data.agentFlowDescription}`);
  }

  // Blank line then "Your identity:" — the source has a literal blank line before it.
  lines.push("");
  lines.push(`Your identity: ${data.identity}`);

  // The following are all {{- if}} blocks (leading-trimmed): each renders directly on the
  // next line with no intervening blank line.
  if (data.communicationStyle) lines.push(`Communication style: ${data.communicationStyle}`);
  if (data.emotionalStateGuidance) lines.push(`Emotional state guidance: ${data.emotionalStateGuidance}`);
  if (data.behavioralTraitsGuidance) lines.push(`Behavioral traits guidance: ${data.behavioralTraitsGuidance}`);
  if (data.traitDirections.length > 0) {
    lines.push("How to play your traits (apply naturally, never announce them, not every turn):");
    for (const d of data.traitDirections) lines.push(`- ${d}`);
  }
  if (data.details.length > 0) {
    lines.push("Your details:");
    // {{range .Details}}{{.}}{{end}} — each detail line is already "- key: value".
    for (const d of data.details) lines.push(d);
  }

  // Literal blank line, then the private-context block.
  lines.push("");
  lines.push("Private caller context:");
  lines.push(data.goal);
  lines.push("");
  lines.push("Use this as memory, not as a checklist or script. Let the agent lead; your context only shapes natural reactions.");
  lines.push(
    "Do not volunteer facts from this context unless the agent asks, misstates something important, or directly triggers a natural concern.",
  );
  lines.push(
    'If this context contains sequencing words like "then", "when", or "as soon as", treat those as possible reactions over time, not instructions to combine multiple steps in one turn.',
  );
  lines.push("If you ask the agent a question, stop after the question and wait for the answer.");

  // {{- if .IncludeLanguageInstruction}} (leading-trimmed): blank line, "Language: …".
  if (data.includeLanguageInstruction) {
    lines.push("");
    lines.push(`Language: Respond in ${data.language}.`);
    if (data.useHindiScript) {
      lines.push(
        "Use Devanagari script for Hindi words but mix English freely throughout — verbs, connectors, fillers, casual words, and technical/business terms. Real Indian users code-switch mid-utterance, not just on technical vocabulary.",
      );
      lines.push(
        'About 1 in 12 turns is mixed Hindi+English in a single utterance ("मुझे book करना है", "ये thoda confusing है", "haan बस यही चाहिए"). Don\'t restrict to all-Hindi or all-English — natural code-switching is common.',
      );
    }
  }

  // {{- if .UseIndianRegister}} (leading-trimmed): blank line, then the register block.
  if (data.useIndianRegister) {
    lines.push("");
    lines.push("Indian phone register:");
    lines.push('- Verb-final word order leaks in: "For which time you are calling?", "Tomorrow you can do?"');
    lines.push('- Tag questions: occasionally (~1 in 10 statements) end with "no?" or "na?" — "you said 3 PM, no?". Not on every turn.');
    lines.push('- "Madam" / "Sir" / "ji" appear naturally, not at every turn.');
    lines.push('- Times spoken digit-by-digit: "two thirty", "ten o\'clock"; for Hindi, "kal", "parso", "X बजे".');
    lines.push("- Sentences may stay grammatically loose — that is normal, do not auto-correct yourself.");
  }

  // Literal blank line, then HARD-FORBID.
  lines.push("");
  lines.push("HARD-FORBID (these break the simulation):");
  lines.push(
    '- Meta-frustration vocabulary: do NOT accuse the agent of "dodging", "hiding", "lying", "being fake", or "not telling the truth". Real frustration sounds like "I already told you" or "I said X" — not interview-style indictment.',
  );
  lines.push('- "wait wait" as a turn opener: real callers don\'t.');
  lines.push(
    '- Parallel-fragment template "[Answer]. [Restated answer]." — don\'t say the same thing twice in two clauses where the second clause just rephrases the first. Pick one phrasing.',
  );
  lines.push(
    '- Service-agent phrasing: never say "how can I help you", "please tell me", "I\'d be happy to", "let me assist".',
  );
  lines.push('- Self-narration: don\'t describe what you\'re about to say or do ("I\'ll now tell you my name").');
  lines.push('- Stage directions or labels: no "(pause)", no "Customer:", no JSON, no markdown.');
  lines.push("- Made-up brand names, businesses, or proper nouns the agent has not introduced.");
  lines.push("- Pop-culture / fictional references the agent didn't bring up.");
  lines.push(
    "- Volunteering details the agent did not ask for, beyond a rare inseparable detail that belongs with the direct answer.",
  );
  lines.push("");
  lines.push("NATURAL HUMAN BEHAVIORS (allowed but only when context warrants it, not on every turn):");
  lines.push(
    "- Affirmation + follow-up question in the same turn — only when the agent's last turn directly triggers an immediate clarification. Otherwise affirm alone and save the question for a later turn.",
  );
  lines.push("");
  lines.push("NATURAL PHONE-SPEECH STYLE (these patterns are real and acceptable — they keep you from sounding scripted):");
  lines.push(
    '- Same-word doubling for emphasis is fine and human ("Yes yes.", "Yeah yeah.", "no no."). Don\'t avoid these — just don\'t open every turn with one.',
  );
  lines.push(
    '- Comma-prefixed affirmation lead-ins ("Yeah, …", "Yes, …", "Okay, …") are acceptable occasionally but should not be your default. Bare "Yes." / "Yeah." varies your speech and matters more than every turn sounding warm. Never use a comma-prefix lead-in on a plain confirmation turn.',
  );
  lines.push(
    '- Multi-clause turns joining with "and" / "but" / "aur" / "lekin" are fine when one thought genuinely leads to another. Don\'t stack more than two clauses.',
  );
  lines.push("- Brief two-sentence turns are fine when a one-clause answer naturally needs a short qualifier or condition.");
  lines.push(
    "- Trail-offs and unfinished thoughts happen naturally — real callers stop mid-clause when they realize they don't know or get distracted. Leaving a turn hanging without a final period is fine.",
  );
  lines.push("");
  lines.push("Behavior rules:");
  lines.push("- Output only the customer's next spoken utterance. Plain text, one turn.");
  lines.push("- Stay in character. You are the customer.");
  lines.push(
    '- When the agent paraphrases what you already said and asks you to confirm a detail, do NOT repeat their words back. Affirm only: "Yes." / "Yeah." / "Right." / "Mhm." / "Correct." They already have the information — restating it is the agent\'s job, not yours.',
  );
  lines.push(
    '- Voice-STT cleans most disfluencies; visible "uh"/"umm"/"hmm" should be rare (<2% of turns). Don\'t open turns with them.',
  );
  lines.push(
    '- If the agent clearly misheard a key word, repeat the correction once (e.g. "[Word]. [Word].") or restate with contrast (e.g. "[Right word], not [wrong word]."). Don\'t open consecutive turns with the same correction.',
  );
  lines.push(
    '- Real-world phone interruptions (NOT creative tangents) appear ~1 in 10 turns: "give me a second", "I\'m in traffic", "kid is crying — what?", "signal is bad", "can I call you back".',
  );
  lines.push(
    '- Pushback on sensitive asks (income, ID, SSN, aadhaar, full address, DOB, account numbers): occasionally "why do you need that?" or "is this safe?". Not every time.',
  );
  lines.push("- Comprehension failures: when asked a multi-part or jargon-heavy question, sometimes only answer one part.");
  lines.push(
    "- Emotional state evolves across the call. Frustration builds with repeated probes or being misunderstood; deflates when the agent reassures or makes progress; anxiety rises near sensitive questions. Do not stay flat.",
  );
  lines.push("- Vary phrasing across turns. Never repeat the same lead-in twice in a row.");
  lines.push("- Never mention being AI, a simulator, workflow steps, intents, or routing.");
  lines.push("- Behavioral traits are tendencies, not obligations. Do not force a trait every turn.");
  lines.push("- Let the agent lead. React from your private context; do not drive the conversation through a planned agenda.");
  lines.push("");
  lines.push(
    "Register samples (these are the *register* you imitate — do not copy verbatim; produce turns that sit in the same set):",
  );
  lines.push(
    '- Native English: "Yes." | "No." | "Okay." | "Yeah." | "Same number." | "Same address." | "Day after tomorrow." | "Thank you." | "I don\'t know." | "Not interested." | "Sounds good."',
  );
  lines.push(
    '- Indian English (note the verb-final order, "only"/"itself"/"na" particles, and polite tags): "Same number only." | "Tomorrow itself, no?" | "Sir please tell." | "What was that, ma\'am?" | "Achha okay." | "Tell me na." | "I am calling from [city]." | "Yes only, sir." | "One minute ji."',
  );
  // {{- if .UseHindiScript}} (leading-trimmed): the Hindi register sample line.
  if (data.useHindiScript) {
    lines.push(
      '- Hindi / Hinglish: "ठीक है जी." | "हाँ बोलिए." | "Madam अभी busy हूँ." | "थोड़ा slow बोलिए." | "पता नहीं sir." | "Hello hello."',
    );
  }

  // Literal blank line, then "Conversation so far:".
  lines.push("");
  lines.push("Conversation so far:");
  // {{- range .History}} (leading-trimmed range): each history line attaches directly.
  for (const h of data.history) lines.push(h);

  // {{- if .IsInterruption}} (leading-trimmed): blank line, then INTERRUPTION MODE block.
  if (data.isInterruption) {
    lines.push("");
    lines.push("INTERRUPTION MODE:");
    lines.push("The agent was speaking and you interrupted. The agent only got to say this much before you cut them off:");
    lines.push(`"${data.partialAssistantMsg}"`);
    lines.push("");
    lines.push("Generate what you would say to interrupt. Pick ONE of these based on what fits the conversation context and your persona:");
    lines.push("");
    lines.push("1. **Answer** — You already know what the agent is asking. Give the answer directly.");
    lines.push('   Example: Agent asking about transfer → "yes transfer me"');
    lines.push("2. **Wait/Hold** — You need a moment.");
    lines.push('   Example: Agent mid-sentence → "hold on", "one sec", "give me a moment", "sorry — what?"');
    lines.push("3. **Question** — You have an unrelated question or need clarification.");
    lines.push('   Example: Agent mid-sentence → "who is this?" or "what company?"');
    lines.push("4. **Objection** — You have a concern or pushback.");
    lines.push('   Example: Agent mid-sentence → "I don\'t have time" or "I\'m not interested"');
    lines.push("");
    lines.push(
      'Do NOT mention that you\'re interrupting — just say what you\'d naturally say. Keep it to 1-3 words maximum. Real interruptions are terse and varied: "yes", "hold on", "one sec", "Thursday", "who is this", "sorry?".',
    );
  }

  // {{- if .IsNonAnswer}} (leading-trimmed): blank line, then NON-ANSWER MODE block.
  if (data.isNonAnswer) {
    lines.push("");
    lines.push("NON-ANSWER MODE:");
    lines.push("Do NOT answer the agent's question this turn.");
    // The blank line after this in the .tmpl is consumed by the inner `{{- if eq ...}}`
    // leading trim, so the presence_check / clarification text attaches with no gap.
    // {{- if eq .NonAnswerType "presence_check"}} … {{- else}} … {{- end}}
    if (data.nonAnswerType === "presence_check") {
      lines.push("You think there was silence or the connection dropped. Generate a brief presence check.");
      lines.push('Examples: "hello?", "hello hello", "are you there?", "can you hear me?", "hey?"');
      if (data.useHindiScript) {
        lines.push('Hindi examples: "हाँ?", "सुन रहे हो?", "बोलिए", "hello? सुनाई दे रहा है?"');
      }
    } else {
      lines.push("You didn't hear or understand the agent's question. Generate a brief clarification request.");
      lines.push('Examples: "what?", "sorry?", "huh?", "can you repeat that?", "I didn\'t catch that"');
      if (data.useHindiScript) {
        lines.push('Hindi examples: "क्या?", "फिर से बोलो", "समझ नहीं आया", "दोबारा बताइए"');
      }
    }
    lines.push("");
    lines.push("Keep it to 1-5 words maximum. Match your persona's tone. Do NOT answer the actual question.");
  }

  // {{- if not .IsNonAnswer}} (leading-trimmed): blank line, then STT SIMULATION block.
  if (!data.isNonAnswer) {
    lines.push("");
    lines.push("STT SIMULATION (always lightly on — production phone STT is never perfectly clean):");
    // Severity: {{if .STTNoiseEnabled}}{{.STTNoiseSeverity}}{{else}}light{{end}} — inline, no trims.
    lines.push(`Severity: ${data.sttNoiseEnabled ? data.sttNoiseSeverity : "light"}`);
    lines.push("");
    lines.push("You are speaking and a speech-to-text engine is transcribing you.");
    lines.push("Output what the transcription would produce, not what you intend to say.");
    lines.push("");
    lines.push("How speech-to-text errors work:");
    lines.push("1. Word boundary breaks — one spoken word becomes multiple fragments.");
    lines.push("2. Phonetic substitution — spelled by sound, not spelling.");
    lines.push("3. Number homophones — digits transcribed as sound-alike words.");
    lines.push("4. Syllable drops/additions — parts of words lost or garbled.");
    lines.push("");
    lines.push("These errors are MORE likely on:");
    lines.push("- Proper nouns, names, places.");
    lines.push("- Numbers, codes, alphanumeric IDs, dates, times.");
    lines.push("- Domain-specific or uncommon vocabulary.");
    lines.push("- Non-English words.");
    lines.push("");
    lines.push("These errors are LESS likely on:");
    lines.push("- Simple affirmations (yes, no, yeah, okay).");
    lines.push("- Very common short phrases.");
    lines.push("- Words the engine hears frequently.");
    lines.push("");
    lines.push("Severity calibration:");
    lines.push("- light (default): roughly 1 in 20 turns has a number/name garble. Simple words pass clean.");
    lines.push("- medium: most number/name turns get phonetic substitution.");
    lines.push("- heavy: numbers, names, and some common words get garbled.");
    lines.push("");
    lines.push("Within a corrupted turn, mix correct and garbled words. Do not mention transcription errors. Just output the text.");
  }

  // Literal blank line, then the final instruction. The .tmpl ends with a trailing newline
  // after this line (the file's last byte is "\n"), so we join with "\n" and append one.
  lines.push("");
  lines.push("Generate your next response as the customer.");

  return lines.join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM call (port of GenerateUserMessage)
// ─────────────────────────────────────────────────────────────────────────────

/** Structured output schema — the LLM must return `{ message: string }`. Mirrors Go `userMessageSchema`. */
const UserMessageSchema = z.object({ message: z.string() });

// JSON schema handed to providers that support strict structured output (OpenAI/Azure),
// mirroring the Go `BuildJSONSchemaFormat("user_message", true, …)` strict object.
const USER_MESSAGE_JSON_SCHEMA = {
  name: "user_message",
  schema: {
    type: "object",
    properties: { message: { type: "string", description: "The customer's next message" } },
    required: ["message"],
    additionalProperties: false,
  },
};

export interface GenerateUserMessageInput {
  scenario: Scenario;
  history: ConversationTurn[];
  agentFlowDescription: string;
  isOutboundCall: boolean;
  /** Set when the agent was interrupted — the partial (truncated) assistant message. */
  partialAssistantMsg: string;
  /** "presence_check" | "topic_lock" when injecting a non-answer turn; "" otherwise. */
  nonAnswerType: string;
  /** Inject a provider in tests (MockLLM); prod resolves from env. */
  provider?: LlmProvider;
  /** Explicit model override; defaults to the configured SIMULATOR_MODEL. */
  model?: string;
}

/**
 * Generate the simulated customer's next message. Builds the (pinned) prompt, calls the LLM
 * for structured `{ message }`, and — mirroring the Go retry — makes ONE more attempt when
 * the first message is blank, throwing if it's still blank after the retry.
 *
 * Runs hot (temperature 0.85) like the Go simulator profile so caller utterances vary turn
 * to turn instead of collapsing to the same safe phrasing.
 */
export async function generateUserMessage(input: GenerateUserMessageInput): Promise<string> {
  const prompt = buildUserSimulatorPrompt(
    input.scenario,
    input.history,
    input.agentFlowDescription,
    input.isOutboundCall,
    input.partialAssistantMsg,
    input.nonAnswerType,
  );

  const call = () =>
    completeJSON({
      schema: UserMessageSchema,
      prompt,
      role: "simulator",
      model: input.model,
      temperature: 0.85,
      jsonSchema: USER_MESSAGE_JSON_SCHEMA,
      provider: input.provider,
    });

  let result = await call();
  let msg = result.data.message;
  if (msg.trim() === "") {
    // Empty message — one retry, identical prompt (matches Go's retry-on-empty).
    result = await call();
    msg = result.data.message;
    if (msg.trim() === "") {
      throw new Error("user simulator returned empty message after retry");
    }
  }
  return msg;
}
