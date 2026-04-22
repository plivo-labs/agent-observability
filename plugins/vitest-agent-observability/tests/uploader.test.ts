import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { upload, configFromEnv, type UploadConfig } from "../src/uploader.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const silentLogger = { warn: () => {}, error: () => {} };

function cfg(partial: Partial<UploadConfig> = {}): UploadConfig {
  return {
    url: "http://localhost:9090",
    timeoutMs: 500,
    maxRetries: 1,
    basicAuth: null,
    ...partial,
  };
}

function tmpDir(): string {
  return mkdtempSync(path.join(tmpdir(), "vitest-ao-"));
}

describe("upload", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("success returns true and hits /observability/evals/v0", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    const ok = await upload(
      { version: "v0", run: { run_id: "r1" } } as any,
      cfg(),
      { logger: silentLogger },
    );
    expect(ok).toBe(true);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:9090/observability/evals/v0");
  });

  test("retries on 5xx", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("bad gateway", { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 201 }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const ok = await upload(
        { version: "v0", run: { run_id: "r1" } } as any,
        cfg({ maxRetries: 3 }),
        { logger: silentLogger },
      );
      expect(ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test("4xx does not retry and writes fallback", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad", { status: 400 }));
    const dir = tmpDir();
    try {
      const ok = await upload(
        { version: "v0", run: { run_id: "r1" } } as any,
        cfg({ maxRetries: 3 }),
        { fallbackDir: dir, logger: silentLogger },
      );
      expect(ok).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const contents = JSON.parse(readFileSync(path.join(dir, "r1.json"), "utf8"));
      expect(contents.run.run_id).toBe("r1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("network failure writes fallback", async () => {
    fetchMock.mockRejectedValue(new TypeError("connection refused"));
    const dir = tmpDir();
    try {
      const ok = await upload(
        { version: "v0", run: { run_id: "r99" } } as any,
        cfg({ maxRetries: 1 }),
        { fallbackDir: dir, logger: silentLogger },
      );
      expect(ok).toBe(false);
      expect(readFileSync(path.join(dir, "r99.json"), "utf8")).toContain("r99");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("attaches basic auth header", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 201 }));
    await upload(
      { version: "v0", run: { run_id: "r1" } } as any,
      cfg({ basicAuth: { user: "u", pass: "p" } }),
      { logger: silentLogger },
    );
    const [, init] = fetchMock.mock.calls[0];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^Basic /);
  });
});

describe("configFromEnv", () => {
  test("returns null without URL", () => {
    expect(configFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
  });

  test("builds config with auth", () => {
    const c = configFromEnv({
      AGENT_OBSERVABILITY_URL: "http://x",
      AGENT_OBSERVABILITY_USER: "u",
      AGENT_OBSERVABILITY_PASS: "p",
    } as NodeJS.ProcessEnv);
    expect(c).not.toBeNull();
    expect(c!.url).toBe("http://x");
    expect(c!.basicAuth).toEqual({ user: "u", pass: "p" });
  });
});
