import { describe, expect, test } from "bun:test";
import { generateMetrics, improveMetricDescription, summarizeFlow } from "../src/judges/ai-assist.js";
import { MockLLM } from "../src/llm/mock.js";

describe("metric AI authoring", () => {
  test("improve returns a sharpened name + description", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        display_name: "Appointment fully confirmed",
        description: "Fail if the call booked without reading back the date, time, doctor and patient details.",
      }),
    ]);
    const out = await improveMetricDescription(
      { name: "appt", description: "check they confirmed the booking", scope: "conversation" },
      llm,
    );
    expect(out.display_name).toBe("Appointment fully confirmed");
    expect(out.description).toContain("read");
  });

  test("summarizeFlow renders nodes, instructions, intents", () => {
    const s = summarizeFlow({
      name: "Clinic",
      nodes: [{ name: "Booking", type: "ai_agent_v2", instructions: "book a slot", intents: ["book", "cancel"], variables: ["name"] }],
    });
    expect(s).toContain("# Flow: Clinic");
    expect(s).toContain("Booking");
    expect(s).toContain("Intents: book, cancel");
  });

  test("generate returns candidates and drops ones duplicating existing", async () => {
    const llm = new MockLLM([
      JSON.stringify({
        metrics: [
          { display_name: "Insurance verified", description: "Fail if slots offered before verifying insurance.", scope: "conversation" },
          { display_name: "Appointment booked", description: "already have this", scope: "conversation" },
        ],
      }),
    ]);
    const out = await generateMetrics(
      { flow: { name: "Clinic", nodes: [{ name: "Book", instructions: "book" }] }, existing: [{ name: "Appointment booked" }] },
      llm,
    );
    expect(out.metrics.map((m) => m.display_name)).toEqual(["Insurance verified"]);
    expect(out.metrics[0]!.scope).toBe("conversation");
  });
});
