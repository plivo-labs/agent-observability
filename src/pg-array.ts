/** bun:sql binds JS arrays as strings. Encode a PostgreSQL text[] parameter
 * without changing opaque identifiers containing quotes or backslashes. */
export function textArrayLiteral(values: readonly string[]): string {
  return `{${values.map(value => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}
