/**
 * Reasoning-effort config → wire-parameter translation, shared by every role
 * that exposes an effort knob (judge, planner, writer, user simulator).
 *
 * Every effort env var is an enum of `inherit | none | low | medium | high`.
 * `"inherit"` is NOT a provider value — it means OMIT the parameter entirely,
 * which is the operator's only way to express "let the deployment's own default
 * decide". That escape hatch exists because an explicit value can be REJECTED by
 * a deployment ("none" is not universally valid across gpt-5.x deployments) and a
 * rejected enum 400s every call on that path. Keeping the translation in one
 * place means a new role can't accidentally send `"inherit"` on the wire.
 */

/** The values a provider will actually accept for `reasoning.effort`. */
export type WireReasoningEffort = "none" | "low" | "medium" | "high";

/** Everything an operator can set, including the omit-the-parameter sentinel. */
export type ConfiguredReasoningEffort = "inherit" | WireReasoningEffort;

/**
 * Translate a configured effort into the wire parameter.
 *
 * @param value    the raw config value. May be `undefined`: tests and embedders
 *                 replace the config module with a partial object, and an
 *                 undefined slipping through would silently drop the parameter
 *                 for a role whose default is meant to be explicit.
 * @param fallback used when `value` is undefined. Defaults to `"inherit"` so a
 *                 role that forgets to plumb its default keeps today's wire shape
 *                 rather than inventing an effort nobody configured.
 * @returns the effort to send, or `undefined` to omit the parameter.
 */
export function resolveReasoningEffort(
  value: ConfiguredReasoningEffort | undefined,
  fallback: ConfiguredReasoningEffort = "inherit",
): WireReasoningEffort | undefined {
  const effort = value ?? fallback;
  return effort === "inherit" ? undefined : effort;
}
