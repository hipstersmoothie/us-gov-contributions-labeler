// Plausible's script and event endpoint, served from our own origin
// (https://plausible.io/docs/proxy/introduction), so the blocklists that match
// plausible.io don't drop pageviews. The paths are deliberately bland: lists
// also match "plausible", "analytics" and "event" in first-party URLs.
import type http from "node:http";

const SCRIPT_URL = "https://plausible.io/js/pa-FAFicKHPQCo27HOgviHNt.js";
const EVENT_URL = "https://plausible.io/api/event";
export const SCRIPT_PATH = "/v/s.js";
export const EVENT_PATH = "/v/e";

/** How long a fetched copy of the script is served before asking again. */
const SCRIPT_TTL = 60 * 60 * 1000;
/** Events are a few hundred bytes of JSON; anything far bigger isn't one. */
const MAX_EVENT_BYTES = 16 * 1024;

let script: { body: Buffer; fetched: number } | undefined;
let refreshing: Promise<void> | undefined;

async function refresh() {
  const res = await fetch(SCRIPT_URL, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`Plausible script: HTTP ${res.status}`);
  script = { body: Buffer.from(await res.arrayBuffer()), fetched: Date.now() };
}

/** GET /v/s.js: the tracker, kept in memory and refreshed hourly; a stale copy beats none. */
export async function serveScript(req: http.IncomingMessage, res: http.ServerResponse) {
  if (!script || Date.now() - script.fetched > SCRIPT_TTL) {
    refreshing ??= refresh()
      .catch((err: unknown) => console.error("plausible script fetch failed:", err))
      .finally(() => (refreshing = undefined));
    // Only a first request waits; later ones get the old copy while it refreshes.
    if (!script) await refreshing;
  }
  if (!script) {
    res.writeHead(502, { "Cache-Control": "no-store" });
    res.end();
    return;
  }
  res.writeHead(200, {
    "Content-Type": "application/javascript; charset=utf-8",
    "Content-Length": script.body.length,
    "Cache-Control": "public, max-age=3600",
  });
  res.end(req.method === "HEAD" ? undefined : script.body);
}

/** POST /v/e: passed through with the visitor's IP and user agent, which Plausible hashes into a daily visitor id. */
export async function forwardEvent(req: http.IncomingMessage, res: http.ServerResponse) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_EVENT_BYTES) {
      res.writeHead(413);
      res.end();
      return;
    }
    chunks.push(chunk);
  }
  // Railway's edge puts the visitor's address first in X-Forwarded-For.
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() || req.socket.remoteAddress || "";
  try {
    const upstream = await fetch(EVENT_URL, {
      method: "POST",
      headers: {
        "Content-Type": req.headers["content-type"] ?? "text/plain",
        "User-Agent": req.headers["user-agent"] ?? "",
        "X-Forwarded-For": ip,
      },
      body: Buffer.concat(chunks),
      signal: AbortSignal.timeout(5000),
    });
    const body = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      "Content-Type": upstream.headers.get("content-type") ?? "text/plain",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch (err) {
    console.error("plausible event forward failed:", err);
    res.writeHead(502, { "Cache-Control": "no-store" });
    res.end();
  }
}
