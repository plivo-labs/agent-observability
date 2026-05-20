import { describe, test, expect } from "bun:test";
import {
  deriveRunStatus,
  EVAL_RUN_STALE_ACTIVITY_MS,
} from "../src/evals/overlay.js";

describe("deriveRunStatus", () => {
  test("non-running statuses pass through unchanged", () => {
    expect(deriveRunStatus("completed", null)).toBe("completed");
    expect(deriveRunStatus("failed", null)).toBe("failed");
    expect(deriveRunStatus("cancelled", new Date())).toBe("cancelled");
    expect(deriveRunStatus("queued", null)).toBe("queued");
  });

  test("running with recent activity stays running", () => {
    const now = new Date("2026-05-14T10:00:00Z");
    const recent = new Date(now.getTime() - 5 * 60_000); // 5 min ago
    expect(deriveRunStatus("running", recent, now)).toBe("running");
  });

  test("running flips to completed once activity is older than the TTL", () => {
    const now = new Date("2026-05-14T10:00:00Z");
    const stale = new Date(now.getTime() - (EVAL_RUN_STALE_ACTIVITY_MS + 1_000));
    expect(deriveRunStatus("running", stale, now)).toBe("completed");
  });

  test("at exactly the threshold, status stays running (strict >)", () => {
    const now = new Date("2026-05-14T10:00:00Z");
    const atThreshold = new Date(now.getTime() - EVAL_RUN_STALE_ACTIVITY_MS);
    expect(deriveRunStatus("running", atThreshold, now)).toBe("running");
  });

  test("running without any recorded activity stays running (no evidence to flip)", () => {
    expect(deriveRunStatus("running", null)).toBe("running");
    expect(deriveRunStatus("running", undefined)).toBe("running");
  });

  test("accepts ISO string timestamps", () => {
    const now = new Date("2026-05-14T10:00:00Z");
    // 2 hours ago → past the 1h TTL.
    expect(deriveRunStatus("running", "2026-05-14T08:00:00Z", now)).toBe(
      "completed",
    );
    // 30 minutes ago → within the TTL.
    expect(deriveRunStatus("running", "2026-05-14T09:30:00Z", now)).toBe(
      "running",
    );
  });

  test("invalid timestamp string keeps status as running (don't false-positive)", () => {
    expect(deriveRunStatus("running", "not-a-date")).toBe("running");
  });

  test("threshold matches the advertised one-hour TTL", () => {
    // If this ever drifts we'd misalign the design contract documented
    // in migration 013 + the dashboard mental model.
    expect(EVAL_RUN_STALE_ACTIVITY_MS).toBe(60 * 60 * 1000);
  });
});
