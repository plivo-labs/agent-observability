import { afterAll, beforeAll, expect, test } from "bun:test";
import { migrate } from "../src/migrate.js";
import { sql } from "../src/db.js";
import { describeDb, testRun } from "./helpers.js";

const t = testRun("session-tenant-access");
const accountA = t.uid("account");
const serviceKey = crypto.randomUUID();
const serviceAuthorization = () => "Basic " + btoa(["tenant-test", serviceKey].join(":"));

describeDb("gateway-facing APIs with real service authentication", () => {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let base: string;
  let ownSession: string;

  beforeAll(async () => {
    await migrate(sql);
    ownSession = await t.seedSession({ accountId: accountA });
    await t.seedSession({ accountId: accountA + "-different-account" });
    await t.seedSession({ accountId: accountA.toUpperCase() });
    child = Bun.spawn([process.execPath, "run", "src/index.ts"], {
      cwd: new URL("../", import.meta.url).pathname,
      env: {
        ...process.env, PORT: "0", SIM_PERSIST: "false", AUTO_MIGRATE: "false",
        ALERT_SWEEPER: "off", EVAL_SWEEPER: "off", JUDGES_FROM_DB: "off",
        AGENT_OBSERVABILITY_USER: "tenant-test", AGENT_OBSERVABILITY_PASS: serviceKey,
        REQUIRE_ACCOUNT_SCOPE: "true", ALLOW_UNAUTHENTICATED: "false",
      },
      stdout: "pipe", stderr: "pipe",
    });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    const deadline = setTimeout(() => child?.kill(), 15000);
    let output = "";
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) throw new Error(`AO did not start: ${output}`);
        output += new TextDecoder().decode(part.value);
        const port = /API listening on :(\d+)/.exec(output)?.[1];
        if (port) { base = `http://127.0.0.1:${port}`; break; }
      }
    } finally {
      clearTimeout(deadline);
      reader.releaseLock();
    }
  }, 20000);

  afterAll(async () => {
    child?.kill();
    if (child) await child.exited;
    await t.cleanup();
  });

  test("service authentication and account context are both required", async () => {
    expect((await fetch(`${base}/api/sessions`, { headers: { "X-Account-Id": accountA } })).status).toBe(401);
    for (const path of ["/api/sessions", "/api/judges", "/api/agents/unknown/judges",
      "/api/analytics/metrics", "/api/analytics/metric-failed-runs?metric=hallucination"]) {
      expect((await fetch(base + path, { headers: { Authorization: serviceAuthorization() } })).status).toBe(401);
    }
    expect((await fetch(`${base}/api/sessions`, {
      headers: { Authorization: serviceAuthorization(), "X-Account-Id": " " },
    })).status).toBe(401);
  });

  test("session listing uses exact trusted identity and ignores a forged query account", async () => {
    const response = await fetch(`${base}/api/sessions?account_id=${accountA}-different-account`, {
      headers: { Authorization: serviceAuthorization(), "X-Account-Id": accountA },
    });
    expect(response.status).toBe(200);
    const body = await response.json() as { objects: Array<{ session_id: string; account_id: string }> };
    expect(body.objects.map(s => s.session_id)).toEqual([ownSession]);
    expect(body.objects[0]!.account_id).toBe(accountA);
  });
});
