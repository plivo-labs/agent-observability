import { expect, test } from "bun:test";

// Sweeper singletons and module mocks must not leak into the shared unit registry.
async function scenario(name: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "tests/fixtures/eval-deadline-sweep.ts", name], {
    cwd: process.cwd(),
    env: { ...process.env, SIM_PERSIST: "false" }, stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  expect({ code, output: code === 0 ? "ok" : out + err }).toEqual({ code: 0, output: "ok" });
}

test("a never-settling provider is aborted and the sweep judges the next session", () => scenario("sweep"));

test("an expired session stops refreshing its heartbeat", () => scenario("heartbeat"));
test("a fan-out row lock acquired after expiry cannot authorize late writes", () => scenario("late-fan-out"));
test("a hung backlog query releases the sweep gate for the next tick", () => scenario("sweep-gate"));
test("statement timeouts stay local to sweeper transactions", () => scenario("transactions"));

test("heartbeat stops even when a database await never settles", () => scenario("heartbeat-db"));
test("an expired fan-out insert rolls back instead of committing", () => scenario("late-insert"));
test("claim tokens reject stale fan-out, completion, failure and heartbeat writes", () => scenario("stale-fence"));
test("a stuck event-kick releases its session slot", () => scenario("kick"));
test("a hung claim query releases the event-kick gate", () => scenario("kick-gate"));
