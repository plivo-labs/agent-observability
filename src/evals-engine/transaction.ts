import { config } from "../config.js";
import { sql } from "../db.js";
import { currentDeadlineSignal } from "../deadline.js";

export async function evalTransaction<T>(work: (tx: typeof sql) => Promise<T>): Promise<T> {
  const signal = currentDeadlineSignal();
  signal?.throwIfAborted();
  return sql.begin(async (tx: typeof sql) => {
    signal?.throwIfAborted();
    // Pool connections also serve requests; a session-level SET would leak into them.
    await tx`SELECT set_config('statement_timeout', ${String(config.EVAL_STATEMENT_TIMEOUT_MS ?? 30_000)}, true)`;
    const guarded = new Proxy(tx, {
      apply(query, thisArg, args) {
        signal?.throwIfAborted();
        return Promise.resolve(Reflect.apply(query, thisArg, args)).then((rows) => {
          signal?.throwIfAborted();
          return rows;
        });
      },
    });
    const result = await work(guarded);
    // Abandoned work may finish a write after expiry; throwing rolls it back.
    signal?.throwIfAborted();
    return result;
  });
}

export const evalSql = new Proxy(sql, {
  apply(_query, _thisArg, args) {
    if (!currentDeadlineSignal()) return Reflect.apply(sql, sql, args);
    return evalTransaction((tx) => Reflect.apply(tx, tx, args));
  },
});
