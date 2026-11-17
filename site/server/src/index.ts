// The production web server: the static site in dist/ exactly as `serve`
// served it (serve-handler with ETags, behind compression), plus link-preview
// images rendered on request at /og/<version>/<type>/<id>.png, and Plausible's
// script and event endpoint proxied at /v/ (see plausible.ts), the member
// finder's address lookup at /api/district (see geocode.ts), and the MCP server
// for AI assistants at /mcp (see mcp.ts).
//
// Card images aren't built ahead of time: there are ~19K pages and a crawler
// asks for a page's image once or twice, when someone shares the link. Each
// renders in a few tens of milliseconds, is kept in a small in-memory LRU, and
// is sent with a year-long immutable Cache-Control, since the version in the
// URL changes whenever the data or the templates do.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import compression from "compression";
import handler from "serve-handler";
import { createRenderer } from "./render.ts";
import { EVENT_PATH, SCRIPT_PATH, forwardEvent, serveScript } from "./plausible.ts";
import { DISTRICT_PATH, findDistrict } from "./geocode.ts";
import { MCP_PATH, createMcp } from "./mcp.ts";

const SERVER_DIR = path.resolve(import.meta.dirname, "..");
const DIST = path.resolve(process.env.DIST_DIR ?? path.join(SERVER_DIR, "../dist"));
const DATA = path.resolve(process.env.OG_DATA_DIR ?? path.join(SERVER_DIR, "data"));
const PORT = Number(process.env.PORT ?? 3000);
/** Rendered PNGs kept in memory, by total size. */
const CACHE_BYTES = Number(process.env.OG_CACHE_MB ?? 64) * 1024 * 1024;

const renderer = createRenderer(DATA, path.join(DIST, "photos"));
const fallback = fs.readFileSync(path.join(DIST, "og.png"));
const mcp = fs.existsSync(path.join(DATA, "mcp.sqlite")) ? createMcp(DATA) : undefined;
if (!mcp) console.warn(`No ${DATA}/mcp.sqlite: serving without /mcp`);

const YEAR = "public, max-age=31536000, immutable";
const DAY = "public, max-age=86400";
const HOUR = "public, max-age=3600";

// --- the image cache: an LRU by bytes, plus in-flight renders so two crawlers
// asking at once share one render ----------------------------------------------------------

const cache = new Map<string, Buffer>();
let cachedBytes = 0;
const inflight = new Map<string, Promise<Buffer>>();

function remember(key: string, png: Buffer) {
  cache.set(key, png);
  cachedBytes += png.length;
  for (const [k, v] of cache) {
    if (cachedBytes <= CACHE_BYTES) break;
    cache.delete(k);
    cachedBytes -= v.length;
  }
}

async function image(key: string): Promise<Buffer | undefined> {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit); // most recently used last
    return hit;
  }
  const card = renderer.card(key);
  if (!card) return undefined;
  let pending = inflight.get(key);
  if (!pending) {
    pending = renderer.render(card).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const png = await pending;
  if (!cache.has(key)) remember(key, png);
  return png;
}

const OG_PATH = /^\/og\/([0-9a-f]+)\/([a-z]+)\/([^/]+)\.png$/;

async function og(req: http.IncomingMessage, res: http.ServerResponse, match: RegExpMatchArray) {
  const [, version, type, rawId] = match;
  let id: string;
  try {
    id = decodeURIComponent(rawId!);
  } catch {
    id = "";
  }
  const send = (png: Buffer, cacheControl: string, status = 200) => {
    res.writeHead(status, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": cacheControl });
    res.end(req.method === "HEAD" ? undefined : png);
  };
  try {
    const png = await image(`${type}/${id}`);
    // Unknown pages get the site card. An old version's URL still gets an
    // image, of today's data, but only cached briefly.
    if (!png) return send(fallback, DAY);
    send(png, version === renderer.version ? YEAR : HOUR);
  } catch (err) {
    console.error(`og render failed for ${type}/${id}:`, err);
    send(fallback, "no-store");
  }
}

// --- one URL per page ---------------------------------------------------------------------------

/**
 * Where a request for a page under another URL should go: /about and
 * /about/index.html both to /about/, the canonical URL. Only for pages that
 * exist, so files without an extension (/.well-known/atproto-did) are left be.
 */
function canonicalPath(pathname: string) {
  let dir: string;
  if (pathname.endsWith("/index.html")) dir = pathname.slice(0, -"index.html".length);
  else if (!pathname.endsWith("/") && !path.posix.extname(pathname)) dir = `${pathname}/`;
  else return undefined;
  let file: string;
  try {
    file = path.join(DIST, decodeURIComponent(dir), "index.html");
  } catch {
    return undefined;
  }
  return file.startsWith(DIST + path.sep) && fs.existsSync(file) ? dir : undefined;
}

// Pages are indexed; the data files and HTML fragments they load aren't.
const HEADERS = [
  { source: "/_astro/**", headers: [{ key: "Cache-Control", value: YEAR }] },
  { source: "/{data,fragments}/**", headers: [{ key: "X-Robots-Tag", value: "noindex" }] },
  { source: "/*.json", headers: [{ key: "X-Robots-Tag", value: "noindex" }] },
];

// --- the server ---------------------------------------------------------------------------------

const compress = compression();

const server = http.createServer((req, res) => {
  const start = performance.now();
  res.on("finish", () => {
    console.log(`${req.method} ${req.url} ${res.statusCode} ${(performance.now() - start).toFixed(0)}ms`);
  });
  const url = new URL(req.url ?? "/", "http://localhost");
  const read = req.method === "GET" || req.method === "HEAD";
  const match = read && url.pathname.match(OG_PATH);
  if (match) {
    void og(req, res, match);
    return;
  }
  if (read && url.pathname === SCRIPT_PATH) {
    void serveScript(req, res);
    return;
  }
  if (req.method === "POST" && url.pathname === EVENT_PATH) {
    void forwardEvent(req, res);
    return;
  }
  // Logged above by path alone: the address is in the body.
  if (req.method === "POST" && url.pathname === DISTRICT_PATH) {
    void findDistrict(req, res);
    return;
  }
  // MCP clients at /mcp; a browser opening the same URL gets the page about it, /mcp/.
  const browsing = read && !!req.headers.accept?.includes("text/html");
  if ((url.pathname === MCP_PATH || url.pathname === `${MCP_PATH}/`) && mcp && !browsing) {
    void mcp(req, res);
    return;
  }
  const moved = read && canonicalPath(url.pathname);
  if (moved) {
    // Keeps the query, e.g. /members?state=AZ → /members/?state=AZ.
    res.writeHead(301, { Location: moved + url.search });
    res.end();
    return;
  }
  compress(req as never, res as never, () => {
    handler(req, res, { public: DIST, etag: true, headers: HEADERS, directoryListing: false }).catch((err: unknown) => {
      console.error(err);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Serving ${DIST} on port ${PORT}; og images version ${renderer.version}`);
  // satori parses the fonts on its first render (~0.5s); do that now, not on a crawler's request.
  const first = renderer.card("page/search");
  if (first) void renderer.render(first).catch((err: unknown) => console.error("og warm-up failed:", err));
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
