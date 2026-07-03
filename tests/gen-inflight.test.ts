/**
 * The generation concurrency semaphore: acquire up to the cap, reject beyond it,
 * and free a slot on release.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import {
  tryAcquireGenerationSlot,
  releaseGenerationSlot,
  generationInFlight,
} from "../src/sim-engine/gen/inflight.js";

describe("generation inflight semaphore", () => {
  beforeEach(() => {
    // Drain any slots left over from a prior test (module-level counter).
    while (generationInFlight() > 0) releaseGenerationSlot();
  });

  test("admits up to the cap, then rejects", () => {
    expect(tryAcquireGenerationSlot(2)).toBe(true);
    expect(tryAcquireGenerationSlot(2)).toBe(true);
    expect(tryAcquireGenerationSlot(2)).toBe(false);
    expect(generationInFlight()).toBe(2);
  });

  test("releasing frees a slot for the next acquire", () => {
    expect(tryAcquireGenerationSlot(1)).toBe(true);
    expect(tryAcquireGenerationSlot(1)).toBe(false);
    releaseGenerationSlot();
    expect(tryAcquireGenerationSlot(1)).toBe(true);
  });

  test("release never underflows below zero", () => {
    releaseGenerationSlot();
    releaseGenerationSlot();
    expect(generationInFlight()).toBe(0);
  });
});
