/**
 * Vitest example where an LLM generates the scenarios.
 *
 * You describe the agent (role, instructions, tool signatures). A top-level
 * `await` calls OpenAI once at module-load time to produce N scenarios, then
 * `it.each` turns each one into its own Vitest case. Every case runs the
 * agent, lets a second LLM grade the reply, and passes/fails on the verdict
 * (plus a strict `expectedTool` check when the generator asked for one).
 *
 * Top-level await works because this file runs as an ES module under Vitest.
 *
 * Reused from `scenarioRunner.ts`:
 *   - `generateScenarios(spec, n)` → the LLM call
 *   - `runScenario(factory, sc)`   → one eval
 *
 * Run:
 *
 *   export OPENAI_API_KEY=sk-...
 *   export AGENT_OBSERVABILITY_AGENT_ID=demo-pizza-bot   # optional
 *   export AGENT_OBSERVABILITY_GENERATED_N=10            # optional; default 10
 *   npx vitest run plugins/examples/vitest_generated_agent.ts
 */

import { describe, it } from "vitest";
import { voice, llm } from "@livekit/agents";
const { Agent, AgentSession } = voice;
import { LLM as OpenAILLM } from "@livekit/agents-plugin-openai";
const { tool } = llm;
import { z } from "zod";

import {
  AgentSpec,
  Scenario,
  generateScenarios,
  runScenarios,
  requireOpenAIKey,
} from "./scenarioRunner.js";

// ── Agent under test ────────────────────────────────────────────────────────

const MENU: Record<string, { priceCents: number; desc: string }> = {
  margherita: { priceCents: 1200, desc: "tomato, mozzarella, basil" },
  pepperoni: { priceCents: 1400, desc: "pepperoni, mozzarella" },
  veggie: {
    priceCents: 1300,
    desc: "peppers, onions, olives, mushrooms",
  },
};

const ORDERS: Record<
  string,
  { status: string; items: string[]; address: string; totalCents: number }
> = {};

export class PizzaShopAgent extends Agent {
  constructor() {
    super({
      instructions:
        "You are the voice order-taker at Tony's Pizza. You can look up the " +
        "menu, place orders, check status, and cancel orders. Only take " +
        "orders for items on the menu — if the caller asks for something " +
        "not on the menu, say so. Always confirm the total and delivery " +
        "address before calling place_order. Never quote a price you did " +
        "not get from the menu tool. Stay on-topic: no jokes, no unrelated " +
        "chit-chat.",
      tools: {
        get_menu: tool({
          description: "Return the current menu with prices.",
          parameters: z.object({}),
          execute: async () =>
            "Menu:\n" +
            Object.entries(MENU)
              .map(
                ([n, i]) => `- ${n}: $${(i.priceCents / 100).toFixed(2)} — ${i.desc}`,
              )
              .join("\n"),
        }),
        place_order: tool({
          description: "Place an order for menu items.",
          parameters: z.object({
            items: z.array(z.string()),
            delivery_address: z.string(),
          }),
          execute: async ({ items, delivery_address }) => {
            const unknown = items.filter((i) => !MENU[i.toLowerCase()]);
            if (unknown.length)
              return `ERROR: items not on menu: ${unknown.join(", ")}`;
            const orderId = `o-${String(Object.keys(ORDERS).length + 1).padStart(4, "0")}`;
            const total = items.reduce(
              (s, i) => s + MENU[i.toLowerCase()].priceCents,
              0,
            );
            ORDERS[orderId] = {
              status: "received",
              items,
              address: delivery_address,
              totalCents: total,
            };
            return `Order ${orderId} placed. Total $${(total / 100).toFixed(2)}.`;
          },
        }),
        get_order_status: tool({
          description: "Return order status by id.",
          parameters: z.object({ order_id: z.string() }),
          execute: async ({ order_id }) => {
            const o = ORDERS[order_id];
            if (!o) return `ERROR: order '${order_id}' not found`;
            return `Order ${order_id}: ${o.status}`;
          },
        }),
        cancel_order: tool({
          description: "Cancel an order unless it is already delivered.",
          parameters: z.object({ order_id: z.string() }),
          execute: async ({ order_id }) => {
            const o = ORDERS[order_id];
            if (!o) return `ERROR: order '${order_id}' not found`;
            if (o.status === "delivered")
              return `ERROR: order ${order_id} was already delivered`;
            o.status = "cancelled";
            return `Order ${order_id} cancelled.`;
          },
        }),
      },
    });
  }
}

export const SPEC: AgentSpec = {
  name: "PizzaShopAgent",
  role: "Voice order-taker for a neighbourhood pizza shop.",
  instructions:
    "Take orders for menu items only. Confirm totals and address before " +
    "placing. Reject off-menu requests and off-topic chit-chat. Never " +
    "quote a price you did not get from get_menu.",
  tools: [
    { name: "get_menu", params: "", description: "Return menu with prices." },
    {
      name: "place_order",
      params: "items: string[], delivery_address: string",
      description: "Place an order; rejects off-menu items.",
    },
    {
      name: "get_order_status",
      params: "order_id: string",
      description: "Return status of an order.",
    },
    {
      name: "cancel_order",
      params: "order_id: string",
      description:
        "Cancel an order unless it's already delivered.",
    },
  ],
};

// ── Module-load-time scenario generation ────────────────────────────────────

const N = Number(process.env.AGENT_OBSERVABILITY_GENERATED_N ?? "10");

requireOpenAIKey();

// Top-level await — Vitest imports the file as an ES module, so this is
// fine. One network call per test run, same scenarios across all cases.
const SCENARIOS: Scenario[] = await generateScenarios(SPEC, N);

// Exposed for the Bun runner in `bun_runner.ts`.
export { SCENARIOS };
export async function runAll() {
  return runScenarios(() => new PizzaShopAgent(), SCENARIOS);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("LLM-generated PizzaShopAgent scenarios", () => {
  // We use the framework's `.judge()` rather than our own judge loop so the
  // `vitest-agent-observability` plugin — which monkey-patches
  // `ChatMessageAssert.judge` — captures each generated scenario's intent,
  // verdict, and reasoning as a first-class Judgment event in the dashboard.
  // A fail surfaces as a judgment card, not a raw Vitest assertion error.
  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    "scenario: %s",
    async (_name, scenario) => {
      const model = new OpenAILLM({ model: "gpt-4.1-mini" });
      const sess = new AgentSession({ llm: model });
      try {
        await sess.start({ agent: new PizzaShopAgent() });
        const result = await sess.run({ userInput: scenario.userInput }).wait();

        // Strict tool-call check when the generator specified one. This
        // stays a structural assertion — it's not an LLM-judged call.
        if (scenario.expectedTool) {
          result.expect.containsFunctionCall({ name: scenario.expectedTool });
        }

        // Main verdict goes through `.judge()`, which the plugin records.
        await result.expect.at(-1).isMessage({ role: "assistant" }).judge(model, {
          intent: scenario.judgeIntent,
        });
      } finally {
        await sess.close();
        await model?.close?.();
      }
    },
  );
});
