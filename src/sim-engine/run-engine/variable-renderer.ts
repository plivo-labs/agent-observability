// AO Simulation Engine — variable rendering ({{Node.var}} / {{var}}).
//
// Port of the reference worker `usecases/simulation_eval/variable_renderer.go`. The VariableStore
// holds node-execution outputs, dual-keyed by node config name AND node id, so a
// `{{NodeConfigName.var}}` reference in flow instructions resolves regardless of which
// identifier the flow author used. `render()` replaces those references in a template
// string; UNRESOLVED references are left exactly as written (the Go contract). A second
// pass resolves bare `{{var}}` references by scanning every node.
//
// Stringification matches Go's `fmt.Sprintf("%v", val)`: see `goSprintfV` below — this is
// the one place TS↔Go differ and the parity tests pin it (numbers, bools, null, objects).

// Matches {{NodeName.variable_name}} — node name can contain word chars, spaces, hyphens.
// Mirrors Go's `\{\{(\w[\w\s-]*)\.([\w.]+)\}\}`. The `g` flag drives replace-all.
const VARIABLE_PATTERN = /\{\{(\w[\w\s-]*)\.([\w.]+)\}\}/g;

// Matches simple {{variable_name}} without a node prefix. Mirrors Go's `\{\{(\w+)\}\}`.
const SIMPLE_VARIABLE_PATTERN = /\{\{(\w+)\}\}/g;

/**
 * Render a Go `fmt.Sprintf("%v", val)` of an arbitrary value. The Go renderer
 * stringifies stored variable values with `%v`, so to stay byte-identical with the
 * worker we reproduce its default formatting verb here rather than using JS coercion:
 *   - string  → the string itself
 *   - number  → `42`, `3.14` (Go prints integral floats without a decimal: 42, not 42.0)
 *   - boolean → `true` / `false`
 *   - null/undefined → `<nil>` (Go prints `<nil>` for a nil interface)
 *   - array   → `[a b c]` (space-separated, bracketed)
 *   - object  → `map[k:v ...]` with keys sorted (Go sorts map keys under %v)
 */
function goSprintfV(val: unknown): string {
  if (val === null || val === undefined) return "<nil>";
  if (typeof val === "string") return val;
  if (typeof val === "boolean") return val ? "true" : "false";
  if (typeof val === "number") {
    if (Number.isInteger(val)) return String(val);
    return String(val);
  }
  if (Array.isArray(val)) {
    return "[" + val.map((v) => goSprintfV(v)).join(" ") + "]";
  }
  if (typeof val === "object") {
    const obj = val as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return "map[" + keys.map((k) => `${k}:${goSprintfV(obj[k])}`).join(" ") + "]";
  }
  return String(val);
}

/**
 * Holds node execution outputs, indexed for template rendering. Dual-keyed by config
 * name and node id so `{{NodeConfigName.var}}` patterns resolve regardless of which
 * identifier is used. Mirrors the Go `VariableStore` (two inner maps, name + id).
 */
export class VariableStore {
  private readonly byName = new Map<string, Map<string, unknown>>();
  private readonly byId = new Map<string, Map<string, unknown>>();

  /**
   * Merge `variables` into BOTH the name-keyed and id-keyed indexes (whichever key is
   * non-empty). No-op when `variables` is empty — matches Go's `len(variables) == 0`
   * early return so an empty extraction never creates an empty inner map.
   */
  set(nodeConfigName: string, nodeId: string, variables: Record<string, unknown>): void {
    if (!variables || Object.keys(variables).length === 0) return;

    if (nodeConfigName) {
      let inner = this.byName.get(nodeConfigName);
      if (!inner) {
        inner = new Map<string, unknown>();
        this.byName.set(nodeConfigName, inner);
      }
      for (const [k, v] of Object.entries(variables)) inner.set(k, v);
    }
    if (nodeId) {
      let inner = this.byId.get(nodeId);
      if (!inner) {
        inner = new Map<string, unknown>();
        this.byId.set(nodeId, inner);
      }
      for (const [k, v] of Object.entries(variables)) inner.set(k, v);
    }
  }

  /**
   * Replace `{{NodeName.variable_name}}` patterns in `template`. Unresolved patterns are
   * left as-is. Two passes, matching Go: first the node-qualified form (try name index
   * then id index), then the bare `{{var}}` form (scan every node, name index first).
   */
  render(template: string): string {
    // First pass: {{NodeName.variable_name}}
    let result = template.replace(VARIABLE_PATTERN, (match, nodeName: string, varName: string) => {
      const byName = this.byName.get(nodeName);
      if (byName && byName.has(varName)) return goSprintfV(byName.get(varName));
      const byId = this.byId.get(nodeName);
      if (byId && byId.has(varName)) return goSprintfV(byId.get(varName));
      return match;
    });

    // Second pass: simple {{variable_name}} — search all nodes (name index, then id index).
    // Anything already resolved in pass 1 is gone, so this only sees still-bare refs.
    result = result.replace(SIMPLE_VARIABLE_PATTERN, (match, varName: string) => {
      for (const inner of this.byName.values()) {
        if (inner.has(varName)) return goSprintfV(inner.get(varName));
      }
      for (const inner of this.byId.values()) {
        if (inner.has(varName)) return goSprintfV(inner.get(varName));
      }
      return match;
    });

    return result;
  }

  /** Retrieve a specific variable value from the store (name index first, then id). */
  get(nodeName: string, varName: string): { value: unknown; ok: true } | { value: undefined; ok: false } {
    const byName = this.byName.get(nodeName);
    if (byName && byName.has(varName)) return { value: byName.get(varName), ok: true };
    const byId = this.byId.get(nodeName);
    if (byId && byId.has(varName)) return { value: byId.get(varName), ok: true };
    return { value: undefined, ok: false };
  }

  /**
   * Return all stored variables as `"NodeName.varName" -> stringified value`. Used to
   * populate `agent_config.all_node_vars` for the agent's Nunjucks template context.
   * Only the name index is flattened (mirrors Go's `FlattenToStringMap`).
   */
  flattenToStringMap(): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [nodeName, inner] of this.byName.entries()) {
      for (const [varName, val] of inner.entries()) {
        result[`${nodeName}.${varName}`] = goSprintfV(val);
      }
    }
    return result;
  }
}
