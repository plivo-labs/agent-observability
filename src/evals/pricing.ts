// Model pricing service.
//
// Strategy: in-memory price map seeded with a small static table for
// offline / first-request use. On startup (or first ingest after
// 6h), fetch the full pricing catalogue from models.dev/api.json and
// replace the in-memory map. Failures keep the existing map and
// trigger a 5-min back-off before the next attempt — so a transient
// network blip doesn't hammer the upstream service.
//
// Lookup is synchronous: callers `await ensurePricesLoaded()` before
// entering a tight loop of `priceFor(provider, model)` calls. This
// keeps the per-event walk in metrics.ts non-async.
//
// Prices are denominated in USD per 1M tokens. `cache_read` is
// optional — when absent for a model, cached prompt tokens fall
// back to the regular input rate (conservative: no cache savings
// reflected in the cost).

export interface ModelPrice {
  /** USD per 1M input (prompt) tokens. */
  input: number;
  /** USD per 1M output (completion) tokens. */
  output: number;
  /** Optional USD per 1M cached-input tokens (OpenAI: ~50% of input;
   *  Anthropic: ~10%). Falls back to `input` when absent. */
  cache_read?: number;
}

// Static seed. Kept small — just enough so cost is non-null for the
// most common providers when we have no network. Real prices come
// from models.dev once the fetch lands.
//
// Last refreshed against provider docs: 2026-05.
let prices: Record<string, ModelPrice> = {
  "openai:gpt-4o":         { input: 2.5,  output: 10,   cache_read: 1.25 },
  "openai:gpt-4o-mini":    { input: 0.15, output: 0.6,  cache_read: 0.075 },
  "openai:gpt-4.1":        { input: 2,    output: 8 },
  "openai:gpt-4.1-mini":   { input: 0.4,  output: 1.6 },
  "openai:o3-mini":        { input: 1.1,  output: 4.4 },
  "openai:o4-mini":        { input: 1.1,  output: 4.4 },
  "anthropic:claude-sonnet-4":   { input: 3,  output: 15, cache_read: 0.3 },
  "anthropic:claude-sonnet-4-5": { input: 3,  output: 15, cache_read: 0.3 },
  "anthropic:claude-sonnet-4-6": { input: 3,  output: 15, cache_read: 0.3 },
  "anthropic:claude-sonnet-4-7": { input: 3,  output: 15, cache_read: 0.3 },
  "anthropic:claude-opus-4":     { input: 15, output: 75, cache_read: 1.5 },
  "anthropic:claude-opus-4-7":   { input: 15, output: 75, cache_read: 1.5 },
  "anthropic:claude-haiku-4-5":  { input: 1,  output: 5,  cache_read: 0.1 },
  "google:gemini-2.5-flash":     { input: 0.3,  output: 2.5 },
  "google:gemini-2.5-pro":       { input: 1.25, output: 10 },
};

const MODELS_DEV_URL = "https://models.dev/api.json";
const REFRESH_MS = 6 * 60 * 60 * 1000;     // refetch every 6h
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;   // wait 5min before retry on failure

let lastAttempt = 0;
let lastSuccess = 0;
let loading: Promise<void> | null = null;

/** Ensure prices are loaded into memory. Cheap on subsequent calls —
 * only triggers a fetch when the cache is older than 6h (or when a
 * prior fetch failed long enough ago that we should retry). */
export function ensurePricesLoaded(): Promise<void> {
  if (loading) return loading;
  const now = Date.now();
  const fresh = lastSuccess > 0 && now - lastSuccess < REFRESH_MS;
  const cooling = lastAttempt > lastSuccess && now - lastAttempt < FAILURE_BACKOFF_MS;
  if (fresh || cooling) return Promise.resolve();
  return reloadPrices();
}

/** Force a refresh from models.dev. Caller is responsible for awaiting
 * if they need fresh prices before reading. */
export function reloadPrices(): Promise<void> {
  if (loading) return loading;
  loading = (async () => {
    lastAttempt = Date.now();
    try {
      const res = await fetch(MODELS_DEV_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as Record<
        string,
        {
          models?: Record<
            string,
            { cost?: { input?: number; output?: number; cache_read?: number } }
          >;
        }
      >;
      const next: Record<string, ModelPrice> = {};
      for (const [provider, providerData] of Object.entries(data)) {
        const providerKey = normalizeProvider(provider);
        for (const [modelId, model] of Object.entries(providerData.models ?? {})) {
          const cost = model.cost;
          if (typeof cost?.input !== "number" || typeof cost?.output !== "number") continue;
          next[`${providerKey}:${normalizeModel(modelId)}`] = {
            input: cost.input,
            output: cost.output,
            cache_read:
              typeof cost.cache_read === "number" ? cost.cache_read : undefined,
          };
        }
      }
      if (Object.keys(next).length === 0) {
        throw new Error("no prices parsed");
      }
      prices = next;
      lastSuccess = Date.now();
      console.log(
        `[evals] loaded ${Object.keys(next).length} model prices from models.dev`,
      );
    } catch (e) {
      console.warn(
        `[evals] models.dev pricing fetch failed: ${(e as Error).message}` +
          " (using cached/seed prices)",
      );
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** Synchronous price lookup. Returns null when the provider/model
 * pair isn't in the current price map (and callers treat this as
 * "we don't know the cost"). */
export function priceFor(
  provider: string | null | undefined,
  model: string | null | undefined,
): ModelPrice | null {
  if (!provider || !model) return null;
  const key = `${normalizeProvider(provider)}:${normalizeModel(model)}`;
  return prices[key] ?? null;
}

/** Lower-case + strip the noisy parts of provider strings so
 * "OpenAI" / "openai.com" / "api.openai.com" / "@openai" all match. */
export function normalizeProvider(provider: string): string {
  return provider
    .toLowerCase()
    .replace(/^@/, "")
    .replace(/^https?:\/\//, "")
    .replace(/^api\./, "")
    .replace(/\.(com|ai|io|net|cloud)$/, "")
    .replace(/[-_ ]/g, "");
}

/** Strip dated / "-latest" suffixes from model ids so "gpt-4o-2024-08-06"
 * matches "gpt-4o" and "claude-sonnet-4-5-20241022" matches
 * "claude-sonnet-4-5". Case-insensitive. */
export function normalizeModel(model: string): string {
  return model
    .toLowerCase()
    .replace(/-20\d{2}-\d{2}-\d{2}$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
}

// ── Test helpers ───────────────────────────────────────────────────────────

/** Inject a price map for tests. Doesn't touch network. Reset between
 * tests by passing the original seed (export `__getPricesForTesting`
 * to grab a snapshot first). */
export function __setPricesForTesting(next: Record<string, ModelPrice>): void {
  prices = next;
  lastSuccess = Date.now();
}

/** Snapshot the current price map. Used in tests to save-and-restore
 * around `__setPricesForTesting`. */
export function __getPricesForTesting(): Record<string, ModelPrice> {
  return { ...prices };
}

/** Reset the module's state — call between tests to ensure no leaked
 * cache from a prior fetch. */
export function __resetPricingForTesting(): void {
  lastAttempt = 0;
  lastSuccess = 0;
  loading = null;
}
