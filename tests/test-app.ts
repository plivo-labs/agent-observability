/**
 * Shared test harness for endpoint tests: mocks the side-effectful modules
 * (db, config, migrate, s3) BEFORE importing the Hono app, and exports the
 * app plus the mock handles and request/auth helpers.
 *
 * Not a test file itself (no .test. infix) — bun test ignores it. Import
 * order matters: mock.module() calls here run before the app import below,
 * which is the whole point of centralizing this preamble.
 */
import { mock } from "bun:test";
import { createHmac } from "node:crypto";

export const mockInsertSession = mock(() => Promise.resolve());
export const mockApplyStoredSessionTags = mock(() => Promise.resolve());
export const mockDrainStagedRawReportPatches = mock(() => Promise.resolve());
export const mockUpsertSessionTag = mock(() => Promise.resolve());
export const mockInsertLiveKitEvaluation = mock(() => Promise.resolve());
export const mockUpsertSessionOutcome = mock(() => Promise.resolve());
export const mockApplySessionTagMetadata = mock(() => Promise.resolve());
export const mockMergeSessionRawReport = mock(() => Promise.resolve());
export const mockSql: any = mock((..._args: any[]) => Promise.resolve([]));
// Route `sql.unsafe(...)` through the same queue as `sql\`...\`` so the
// existing `.mockResolvedValueOnce(...)` pattern works for both call styles.
mockSql.unsafe = mockSql;
// `sql.begin(fn)` is used by the recordings handler so the agent upsert
// and session insert share one transaction. The mock just invokes the
// callback with the same handle — no real isolation, but the test
// surface only cares that the inner calls happen.
mockSql.begin = (fn: (tx: any) => Promise<unknown>) => fn(mockSql);

export const TEST_USER = "test-user";
export const TEST_PASS = "test-pass";
export const LIVEKIT_API_KEY = "plivo-labs-livekit-api-key";
export const LIVEKIT_API_SECRET = "plivo-labs-livekit-api-secret";

/**
 * (Re)register the module mocks. bun test runs every file in one process,
 * and mock.module live-rebinds already-imported modules — so a later test
 * file mocking ../src/db.js with its OWN handles steals the app's `sql`
 * binding from under us. Every file that imports this harness must call
 * registerAppMocks() at top level: files load right before their tests
 * run, so the re-registration wins for that file's duration.
 */
export function registerAppMocks(): void {
  mock.module("../src/config.js", () => ({
    config: {
      PORT: 9090,
      AGENT_OBSERVABILITY_USER: TEST_USER,
      AGENT_OBSERVABILITY_PASS: TEST_PASS,
      LIVEKIT_API_KEY,
      LIVEKIT_API_SECRET,
      AUTO_MIGRATE: false,
      DATABASE_URL: "postgres://localhost:5432/test",
      S3_REGION: "us-east-1",
      S3_PREFIX: "recordings",
    },
    s3Enabled: false,
    basicAuthEnabled: true,
    liveKitAuthEnabled: true,
  }));

  mock.module("../src/db.js", () => ({
    sql: mockSql,
    insertSession: mockInsertSession,
    applyStoredSessionTags: mockApplyStoredSessionTags,
    drainStagedRawReportPatches: mockDrainStagedRawReportPatches,
    upsertSessionTag: mockUpsertSessionTag,
    insertLiveKitEvaluation: mockInsertLiveKitEvaluation,
    upsertSessionOutcome: mockUpsertSessionOutcome,
    applySessionTagMetadata: mockApplySessionTagMetadata,
    mergeSessionRawReport: mockMergeSessionRawReport,
  }));

  mock.module("../src/migrate.js", () => ({
    migrate: () => Promise.resolve(),
  }));

  mock.module("../src/s3.js", () => ({
    uploadRecording: () => Promise.resolve("https://s3.example.com/recording.ogg"),
    deleteRecording: () => Promise.resolve(),
  }));
}

registerAppMocks();

// Import the app only after the mocks above are registered.
export const server = (await import("../src/index.js")).default;

export function basicAuthHeader(): string {
  return `Basic ${Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString("base64")}`;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

export function liveKitBearerHeader(overrides?: Record<string, unknown>, secret = LIVEKIT_API_SECRET): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    observability: { write: true },
    sub: "",
    iss: LIVEKIT_API_KEY,
    nbf: now - 1,
    exp: now + 3600,
    ...(overrides ?? {}),
  }));
  const signingInput = `${header}.${payload}`;
  const signature = createHmac("sha256", secret).update(signingInput).digest();
  return `Bearer ${signingInput}.${base64Url(signature)}`;
}

export function makeRequest(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost:9090${path}`, init);
}
