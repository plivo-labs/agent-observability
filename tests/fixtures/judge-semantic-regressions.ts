// Synthetic, non-customer examples. Expected verdicts never enter judge inputs.
import type { ConversationInput, NodeEvalInput } from "../../src/evals-engine/types.js";

export type SemanticCase = {
  id: string;
  expected: "pass" | "fail" | "unknown";
  input: ConversationInput;
} & ({ kind: "custom"; body: string } | { kind: "variable"; node: NodeEvalInput });

const conversation = (transcript: string): ConversationInput => ({
  flow_name: "regression-fixture", global_prompt: "Follow the configured instructions.",
  nodes: [], goals: [], full_transcript: transcript,
});

const opening = "Agent: Hello, I am calling from the equipment team. Am I speaking with the customer?";
const outcomeRule = "Use QUALIFIED when the caller engaged and shared requirements but did not give a final yes. Use FOLLOWUP DEFERRED when the caller requests a callback or the conversation ends before they share requirements.";
const variableCase = (id: string, expected: "pass" | "fail", name: string, rule: string, value: string | undefined, user: string): SemanticCase => {
  const agent = user ? "Thank you for your time. Goodbye." : "What do you need from your website?";
  const node: NodeEvalInput = {
    node_uuid: "discovery", node_name: "Discovery", node_prompt: "Ask the caller what they need from their website.",
    available_intents: [], chosen_intent: "", required_variables: [name], variable_rules: { [name]: rule },
    extracted_variables: value === undefined ? {} : { [name]: value },
    turns: [{ node_uuid: "discovery", user, agent, intent: "" }], turn_count: 1,
  };
  const input = conversation(`${user ? `User: ${user}\n` : ""}Agent: ${agent}`);
  input.nodes = [node];
  return { id, kind: "variable", expected, node, input };
};

export const semanticCases: SemanticCase[] = [
  {
    id: "usage-before-caller-response", kind: "custom", expected: "unknown", input: conversation(opening),
    body: "Mark successful when the business learns how the customer uses the equipment: personal work, rental work, or both, regardless of whether anything else in the call is completed.",
  },
  {
    id: "support-before-caller-response", kind: "custom", expected: "unknown", input: conversation(opening),
    body: "Mark successful when the customer is given the support helpline as the place to get future help, and they acknowledge they know where to contact for support if needed.",
  },
  {
    id: "setup-offer-unanswered-after-live-introduction", kind: "custom", expected: "unknown",
    input: conversation("Agent: Is this Alex?\nUser: Yes.\nAgent: Congratulations on your purchase. Can we talk now?\nUser: Yes, go ahead.\nAgent: Have you installed the equipment app? If not, I can guide you.\nUser: Hello?\nAgent: Can you [interrupted]"),
    body: "Mark successful when the customer ends the call with the equipment app installed and opened, and they can log in or confirm they can proceed with login using their registered number and PIN.",
  },
  {
    id: "setup-started-but-login-failed", kind: "custom", expected: "fail",
    input: conversation("Agent: Open the equipment app and log in using your registered number and PIN.\nUser: I installed it and opened it. I entered my PIN, but login failed and I cannot continue.\nAgent: Goodbye."),
    body: "Mark successful when the customer ends the call with the equipment app installed and opened, and they can log in or confirm they can proceed with login using their registered number and PIN.",
  },
  {
    id: "setup-completed-and-login-confirmed", kind: "custom", expected: "pass",
    input: conversation("Agent: Open the equipment app and log in using your registered number and PIN.\nUser: I installed it, opened it and logged in successfully.\nAgent: Thank you. Goodbye."),
    body: "Mark successful when the customer ends the call with the equipment app installed and opened, and they can log in or confirm they can proceed with login using their registered number and PIN.",
  },
  {
    id: "required-handoff-after-request", kind: "custom", expected: "fail",
    input: conversation("User: Please connect me to a human.\nAgent: I will not transfer you. Goodbye."),
    body: "If the caller asks for a human, the agent must transfer them. Fail if the agent refuses the requested transfer.",
  },
  {
    id: "handoff-not-requested", kind: "custom", expected: "unknown",
    input: conversation("User: What are your opening hours?\nAgent: Nine to five.\nUser: Thank you. Goodbye."),
    body: "If the caller asks for a human, the agent must transfer them. Fail if the agent refuses the requested transfer.",
  },
  {
    id: "human-followup-not-needed", kind: "custom", expected: "unknown",
    input: conversation("Agent: Do you know your start date?\nUser: No.\nAgent: It is Monday. Is anything in the offer unclear, or do you have other concerns?\nUser: No, nothing. No issues.\nAgent: Thank you. Goodbye."),
    body: "The conversation identifies an issue or question that needs a human HR partner to step in, and the company has enough context to follow up appropriately.",
  },
  {
    id: "human-followup-needed-and-context-captured", kind: "custom", expected: "pass",
    input: conversation("User: The offer says my salary is 50,000, but the agreed amount was 60,000. I need HR to correct it before I can join. My email is alex@example.com.\nAgent: I recorded the salary discrepancy and your email for a human HR partner to follow up.\nUser: Thank you."),
    body: "The conversation identifies an issue or question that needs a human HR partner to step in, and the company has enough context to follow up appropriately.",
  },
  {
    id: "unconditional-prohibition-observed", kind: "custom", expected: "pass", input: conversation(opening),
    body: "The agent must never ask for a password. Pass when the agent does not request a password; fail if it does.",
  },
  {
    id: "opening-disclosure-omitted", kind: "custom", expected: "fail", input: conversation(opening),
    body: "The agent must disclose that it is an automated assistant in its opening message. Fail when the opening omits this disclosure, even if the caller never replies.",
  },
  {
    id: "explicit-immediate-disconnect-failure", kind: "custom", expected: "fail",
    input: conversation(`${opening}\nUser: I cannot talk.\nAgent: Goodbye.`),
    body: "Mark successful if the welcome call collects the customer's requirements and completes setup. Do not mark successful if the call ends immediately without either step.",
  },
  {
    id: "welcome-stops-before-required-closure", kind: "custom", expected: "fail",
    input: conversation("Agent: Welcome, congratulations on your purchase! Is this Alex?\nUser: Yes.\nAgent: Please open the app.\nUser: I opened the store listing.\nAgent: Install it and enter your login code."),
    body: "Mark successful if the agent greets and congratulates the customer, verifies their name, completes setup, explains support and ends politely. Do not mark successful if the call ends abruptly without proper closure.",
  },
  {
    id: "closure-not-reached-at-interrupted-opening", kind: "custom", expected: "unknown",
    input: conversation("Agent: Hello, I am calling from the university about our course. Are you [interrupted]"),
    body: "Handle neutral closure, not-interested, wrong-number, opt-out, busy, unsupported-language, voicemail and technical cases without extra pitching or misclassification.",
  },
  {
    id: "completed-call-with-interrupted-polite-closing", kind: "custom", expected: "pass",
    input: conversation("Agent: Welcome, congratulations on your purchase! Is this Alex?\nUser: Yes.\nAgent: Please install the app and log in.\nUser: Done, it works.\nAgent: You can view device history and receive alerts there. Support is available at 555-0100.\nUser: Understood, I know where to get help. No more questions.\nAgent: Glad we could help. If you need anything else [interrupted]"),
    body: "Mark successful if the agent greets and congratulates the customer, verifies their name, completes setup, explains support and ends politely. Do not mark successful if the agent ends abruptly without proper closure.",
  },
  {
    id: "brief-support-acknowledgement", kind: "custom", expected: "pass",
    input: conversation("Agent: For future help, call our support helpline at 555-0100.\nUser: हाँ हाँ.\nAgent: Thank you for your time.\nUser: ठीक है."),
    body: "Mark successful when the customer is given the support helpline as the place to get future help, and they acknowledge they know where to contact for support if needed.",
  },
  {
    id: "earlier-agreement-does-not-override-later-confusion", kind: "custom", expected: "fail",
    input: conversation("Agent: Can we talk now?\nUser: Yes, okay.\nAgent: For future help, call our support helpline at 555-0100.\nUser: I did not understand. I still do not know where to get help.\nAgent: Goodbye."),
    body: "Mark successful when the customer is given the support helpline as the place to get future help, and they acknowledge they know where to contact for support if needed.",
  },
  variableCase("qualification-before-requirements", "fail", "conversation_outcome", outcomeRule, "QUALIFIED", ""),
  variableCase("qualification-after-requirements", "pass", "conversation_outcome", outcomeRule, "QUALIFIED", "I need a website with a booking page. Please send a proposal; I have not decided yet."),
  variableCase("configured-no-dispute-default", "pass", "remember_form", "Extract yes if the caller remembers or does not dispute. Extract no for a wrong person.", "yes", "Please call this afternoon."),
  variableCase("explicit-negative-answer-not-recorded", "fail", "website_interest", "Extract whether the caller is interested in a website. Use yes, no, or unclear.", undefined, "No, I am not interested in a website. Goodbye."),
  variableCase("unreached-budget-after-decline", "pass", "website_budget", "Extract the caller's website budget if they state one.", undefined, "No, I am not interested in a website. Goodbye."),
];
