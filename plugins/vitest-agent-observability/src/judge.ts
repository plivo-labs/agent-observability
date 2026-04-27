import { recordJudgment } from "./collector.js";
import type { Logger } from "./uploader.js";

const PATCH_FLAG = Symbol.for("agent_observability.judge_patched");

/**
 * Best-effort monkey-patch of LiveKit's ChatMessageAssert.judge() method so
 * we can record (intent, verdict, reasoning) for every call.
 *
 * LiveKit's Node SDK isn't a hard dependency — if it's not importable (or the
 * shape changed), this silently no-ops. Returns a restorer callable or null.
 */
export async function installJudgeWrapper(logger?: Logger): Promise<(() => void) | null> {
  const target = await findJudgeTarget();
  if (!target) return null;
  const { proto, original } = target;

  // Idempotent.
  if ((proto.judge as any)?.[PATCH_FLAG]) return null;

  const wrapped = async function (this: any, llm: unknown, opts: { intent?: string } | unknown) {
    const intent = (opts as { intent?: string })?.intent ?? "";
    try {
      const result = await original.call(this, llm, opts);
      recordJudgment({ intent, verdict: "pass", reasoning: "" });
      return result;
    } catch (e) {
      const msg = (e as Error)?.message ?? "";
      const prefix = "Judgement failed:";
      const reasoning = msg.includes(prefix)
        ? msg.split(prefix)[1]?.trim() ?? msg
        : msg;
      recordJudgment({ intent, verdict: "fail", reasoning });
      throw e;
    }
  };
  (wrapped as any)[PATCH_FLAG] = true;
  proto.judge = wrapped;
  logger?.warn?.("[agent-observability] judge() wrapper installed");

  return () => {
    proto.judge = original;
  };
}

/**
 * Try known export paths for LiveKit's Node `ChatMessageAssert` class.
 * Returns the prototype object plus the original judge method, or null.
 */
async function findJudgeTarget(): Promise<{ proto: any; original: Function } | null> {
  const candidates = [
    "@livekit/agents",
    "@livekit/agents/voice",
    "@livekit/agents/voice/run_result",
    "@livekit/agents/dist/voice/run_result",
  ];
  for (const spec of candidates) {
    try {
      const mod = await import(spec);
      const cls = findChatMessageAssert(mod);
      const proto = cls?.prototype;
      if (proto && typeof proto.judge === "function") {
        return { proto, original: proto.judge };
      }
    } catch {
      // Keep trying other import paths.
    }
  }
  return null;
}

function findChatMessageAssert(mod: any): any | null {
  if (!mod) return null;
  // The class was named `ChatMessageAssert` on older LiveKit snapshots and
  // `MessageAssert` on current releases (1.2.x Node). Probe both names at
  // each plausible namespace depth.
  const NAMES = ["ChatMessageAssert", "MessageAssert"];
  const hit = (obj: any): any | null => {
    if (!obj) return null;
    for (const n of NAMES) if (obj[n]) return obj[n];
    return null;
  };
  return (
    hit(mod)
    ?? hit(mod.voice)
    ?? hit(mod.voice?.testing)
    ?? hit(mod.voice?.testing?.runResult)
    ?? hit(mod.voice?.expect)
    ?? hit(mod.default)
    ?? hit(mod.default?.voice)
    ?? hit(mod.default?.voice?.testing)
  );
}
