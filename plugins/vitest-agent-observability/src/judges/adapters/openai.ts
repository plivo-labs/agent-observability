/**
 * OpenAI-compatible LLM adapter using fetch (no SDK dependency).
 *
 * Sync target:
 *   plugins/pytest-agent-observability/src/pytest_agent_observability/judges/adapters/openai.py
 */

import type { LLMClient } from "../runner.js";

export function openaiAdapter({
  apiKey,
  model = "gpt-4o-mini",
  baseUrl,
}: {
  apiKey: string;
  model?: string;
  baseUrl?: string;
}): LLMClient {
  if (!apiKey) throw new Error("openaiAdapter: apiKey is required");

  const url =
    (baseUrl ?? "https://api.openai.com").replace(/\/$/, "") +
    "/v1/chat/completions";

  return {
    async evaluate(prompt: string): Promise<string> {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: "json_object" },
          messages: [{ role: "user", content: prompt }],
        }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`openaiAdapter: HTTP ${resp.status} — ${text}`);
      }

      const data = (await resp.json()) as any;
      return data.choices[0].message.content as string;
    },
  };
}
