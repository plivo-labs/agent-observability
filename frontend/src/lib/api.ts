/* api.ts — shared fetch+unwrap helper used across the app's data calls.
 * Sets a JSON content-type, throws a useful Error on non-2xx (unwrapping the
 * backend's { error: { message } } envelope when present), and returns the
 * parsed JSON body typed as T. */
export async function api<T>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { headers: { 'content-type': 'application/json' }, ...opts })
  if (!res.ok) {
    let m = `Request failed (${res.status})`
    try { m = (await res.json())?.error?.message ?? m } catch { /* ignore */ }
    throw new Error(m)
  }
  return res.json()
}
