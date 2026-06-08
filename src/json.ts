/** Parse a value that may already be parsed: jsonb columns come back from
 *  bun:sql as objects when stored properly, but as a JSON string when a legacy
 *  write double-encoded them. Tolerate both. */
export const parseJson = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);
