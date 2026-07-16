import { describe, test, expect, mock } from "bun:test";
import { TEST_CONFIG_MODULE_DEFAULTS } from "./fixtures/judge-config.js";

// QUAL-01: the default zero-config deployment has neither auth pair set.
// That open path was previously untested — a regression could silently
// open or close ingest. Mock config with both modes disabled and assert
// the middleware lets requests through.
mock.module("../src/config.js", () => ({
  ...TEST_CONFIG_MODULE_DEFAULTS,
  config: { LIVEKIT_API_KEY: undefined, LIVEKIT_API_SECRET: undefined },
  basicAuthEnabled: false,
  liveKitAuthEnabled: false,
}));

const { nativeLiveKitUploadAuth } = await import("../src/livekit/auth.js");

function fakeCtx(authHeader?: string) {
  return {
    req: { header: (_name: string) => authHeader },
    json: (body: unknown, status?: number) => ({ body, status: status ?? 200 }),
  } as any;
}

describe("nativeLiveKitUploadAuth with no auth configured", () => {
  test("passes through when no Authorization header is present", async () => {
    let nextCalled = false;
    const result = await nativeLiveKitUploadAuth(fakeCtx(), async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
    expect(result).toBeUndefined(); // no 401 short-circuit
  });

  test("passes through even with a bogus Authorization header", async () => {
    let nextCalled = false;
    await nativeLiveKitUploadAuth(fakeCtx("Bearer not-a-real-token"), async () => {
      nextCalled = true;
    });
    expect(nextCalled).toBe(true);
  });
});
