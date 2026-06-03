import { describe, test, expect } from "bun:test";
import { isAgentTurn, sawAudioEvidence, perceivedMs } from "../src/turn-rules.js";

describe("turn-rules", () => {
  // ── isAgentTurn ───────────────────────────────────────────────────────────

  test("isAgentTurn is true only for assistant role", () => {
    expect(isAgentTurn("assistant")).toBe(true);
    expect(isAgentTurn("user")).toBe(false);
    expect(isAgentTurn("system")).toBe(false);
    expect(isAgentTurn(undefined)).toBe(false);
    expect(isAgentTurn(null)).toBe(false);
  });

  // ── sawAudioEvidence ──────────────────────────────────────────────────────

  test("sawAudioEvidence detects any audio-pipeline field", () => {
    expect(sawAudioEvidence({ transcription_delay: 0.1 })).toBe(true);
    expect(sawAudioEvidence({ tts_node_ttfb: 0.08 })).toBe(true);
    expect(sawAudioEvidence({ started_speaking_at: 1 })).toBe(true);
    expect(sawAudioEvidence({ stopped_speaking_at: 1 })).toBe(true);
  });

  test("sawAudioEvidence is false for text-only / empty metrics", () => {
    expect(sawAudioEvidence({ llm_node_ttft: 0.3 })).toBe(false);
    expect(sawAudioEvidence({})).toBe(false);
    expect(sawAudioEvidence(null)).toBe(false);
    expect(sawAudioEvidence(undefined)).toBe(false);
  });

  test("sawAudioEvidence does NOT key on tts_metadata (that is a per-turn gate)", () => {
    // tts_metadata is the per-turn TTS-synthesis signal metrics.ts uses
    // for tts_characters — intentionally NOT part of the session-level
    // audio-evidence definition.
    expect(sawAudioEvidence({ tts_metadata: { model_name: "tts-1" } })).toBe(false);
  });

  // ── perceivedMs (canonical: e2e ?? llm, no +tts) ──────────────────────────

  test("perceivedMs prefers e2e when present", () => {
    expect(perceivedMs(600, 450)).toBe(600);
  });

  test("perceivedMs falls back to llm when e2e is nil", () => {
    expect(perceivedMs(undefined, 450)).toBe(450);
    expect(perceivedMs(null, 450)).toBe(450);
  });

  test("perceivedMs is undefined when both inputs are nil", () => {
    expect(perceivedMs(undefined, undefined)).toBeUndefined();
    expect(perceivedMs(null, null)).toBeUndefined();
  });

  test("perceivedMs ignores tts entirely (no summing)", () => {
    // The signature has no tts parameter — the canonical formula is
    // e2e ?? llm. A turn with only llm timing yields exactly llm.
    expect(perceivedMs(undefined, 450)).toBe(450);
  });
});
