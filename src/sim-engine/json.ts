// AO Simulation Engine — tiny JSON helpers shared by gen/ and run-engine/.
//
// A pure leaf (imports NOTHING) so it's safe from BOTH the deliberately config-free generator
// (gen/) and the run engine (run-engine/) without dragging in heavy deps.

/** True for a plain (non-array, non-null) object. The single runtime guard behind the gen
 *  `isObj` (re-narrowed to its local `Dict`) and the run-engine `isRecord`. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-clone a plain JSON object the way Go's `deepCopyMap` does (Marshal→Unmarshal): we must
 *  not mutate a node's config in place (the same FlowNode is reused across turns). `structuredClone`
 *  is the native equivalent (JSON-safe values only — all a flow config holds). A nullish source
 *  yields `{}`, matching Go. */
export function deepCopyMap(src: Record<string, unknown> | null | undefined): Record<string, unknown> {
  if (!src) return {};
  return structuredClone(src) as Record<string, unknown>;
}
