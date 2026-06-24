// AO Simulation Engine — text helpers for the generator (pure leaf, no imports).
//
// Lives here (not in planner.ts) so the config-free allocator can import `slug` without pulling
// planner → completeJSON → config; and not in combos.ts, which is verbatim-ported DATA.

/** snake_case slug: lowercase, non-alphanumeric → "_", collapse repeats, trim "_".
 *  Ported from aiassist; used by the planner (capability ids) + the allocator (outcomes). */
export function slug(s: string): string {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}
