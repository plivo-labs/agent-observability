/* ws.ts — WebSocket proxy for the live in-call experience.
 *
 * The browser talks only to AO; AO bridges to Truman's per-run WebSockets,
 * injecting the TRUMAN_API_TOKEN server-side (never exposed to the client):
 *   GET /api/calls/:runId/stream         ↔ Truman /v1/runs/{id}/stream         (live transcript/status/takeover events, text)
 *   GET /api/calls/:runId/audio          ↔ Truman /v1/runs/{id}/audio          (listen-in audio, binary)
 *   GET /api/calls/:runId/takeover/audio ↔ Truman /v1/runs/{id}/takeover/audio (director mic in, binary)
 *
 * One upstream client socket per browser socket, created on open and torn down
 * together. Frames are piped both directions (upstream→client for transcript +
 * listen audio; client→upstream for the director mic).
 */
import type { Hono } from "hono";
import { createBunWebSocket } from "hono/bun";
import { config, trumanEnabled } from "../config.js";

const { upgradeWebSocket, websocket } = createBunWebSocket();
// Mounted on the Bun server default export so upgrades are handled.
export { websocket };

const wsBase = () => (config.TRUMAN_API_URL ?? "").replace(/\/$/, "").replace(/^http/, "ws");
const tok = () => encodeURIComponent(config.TRUMAN_API_TOKEN ?? "");

/** Bridge a browser socket to Truman's `/v1/runs/{id}{trumanPath}`. */
function bridge(trumanPath: string, binary: boolean) {
  return upgradeWebSocket((c: any) => {
    const runId = c.req.param("runId");
    let upstream: WebSocket | null = null;
    const pending: any[] = []; // client→upstream frames buffered until upstream opens
    return {
      onOpen(_evt: any, ws: any) {
        if (!trumanEnabled) { try { ws.close(1011, "real calling disabled"); } catch {} return; }
        try {
          upstream = new WebSocket(`${wsBase()}/v1/runs/${runId}${trumanPath}?token=${tok()}`);
          if (binary) upstream.binaryType = "arraybuffer";
        } catch { try { ws.close(); } catch {} return; }
        upstream.onmessage = (e: MessageEvent) => { try { ws.send(e.data); } catch {} };
        upstream.onopen = () => { for (const m of pending) { try { upstream!.send(m); } catch {} } pending.length = 0; };
        upstream.onclose = () => { try { ws.close(); } catch {} };
        upstream.onerror = () => { try { ws.close(); } catch {} };
      },
      onMessage(evt: any, _ws: any) {
        const data = evt.data;
        if (!upstream || upstream.readyState !== 1 /* OPEN */) { pending.push(data); return; }
        try { upstream.send(data); } catch {}
      },
      onClose() { try { upstream?.close(); } catch {} upstream = null; },
      onError() { try { upstream?.close(); } catch {} upstream = null; },
    };
  });
}

export function registerLiveWsRoutes(app: Hono) {
  app.get("/api/calls/:runId/stream", bridge("/stream", false));
  app.get("/api/calls/:runId/audio", bridge("/audio", true));
  app.get("/api/calls/:runId/takeover/audio", bridge("/takeover/audio", true));
}
