// Tells search engines which pages changed, through IndexNow
// (https://www.indexnow.org/documentation): Bing, Yandex, Naver, Seznam and
// the others share one submission. Google doesn't take part; it reads the
// sitemap's lastmod dates instead.
//
// The build lists what changed in dist/data/pages.json (see
// scripts/sitemap.ts), but a URL is only worth sending once it serves the new
// page. So after starting, the server waits until the site's own
// data/pages.json is this build's (Railway moves traffic over once the new
// deployment is healthy), then sends the list once. A local preview's build is
// never the live one, so it never sends. Nothing is remembered across
// restarts: a restart within a few hours of the build sends the same list
// again, which IndexNow tolerates; after that, a restart sends nothing.
import fs from "node:fs";
import path from "node:path";

/** Served from public/ at /<key>.txt, which is how IndexNow checks the site is ours. */
const KEY = "50b9fca5989042c2abba24b06254f86a";
const ENDPOINT = "https://api.indexnow.org/indexnow";
/** IndexNow's limit per request. */
const BATCH = 10_000;
/** A build older than this when the server starts has had its list sent already. */
const FRESH_MS = 6 * 60 * 60 * 1000;
/** How often, and how many times, to check whether this build is live yet. */
const POLL_MS = 60 * 1000;
const POLLS = 30;

interface Manifest {
  builtAt: string;
  changed: string[];
  removed: string[];
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function submitChanges(dist: string, site = process.env.SITE_URL ?? "https://contributions.fyi") {
  if (process.env.INDEXNOW === "off") return;
  let manifest: Manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(dist, "data/pages.json"), "utf8"));
  } catch {
    return console.warn("indexnow: no data/pages.json in this build; nothing to send");
  }
  if (Date.now() - Date.parse(manifest.builtAt) > FRESH_MS) return;
  const paths = [...manifest.changed, ...manifest.removed];
  if (!paths.length) return console.log("indexnow: no pages changed in this build");

  const live = new URL("data/pages.json", site).href;
  for (let i = 0; ; i++) {
    if (i === POLLS) return console.warn(`indexnow: ${live} never became this build's; not sending`);
    await wait(POLL_MS);
    try {
      const res = await fetch(live, { signal: AbortSignal.timeout(30_000), headers: { "Cache-Control": "no-cache" } });
      const { builtAt } = (await res.json()) as Manifest;
      if (builtAt === manifest.builtAt) break;
      // A newer build is live: its own server sends its list.
      if (builtAt > manifest.builtAt) return;
    } catch {
      // Not answering yet, or mid-switch; ask again.
    }
  }

  const host = new URL(site).host;
  for (let i = 0; i < paths.length; i += BATCH) {
    const urlList = paths.slice(i, i + BATCH).map((p) => new URL(p, site).href);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ host, key: KEY, keyLocation: new URL(`${KEY}.txt`, site).href, urlList }),
        signal: AbortSignal.timeout(60_000),
      });
      // 200 and 202 are both success; 202 means the key is still being checked.
      if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => "")}`.trim());
      console.log(`indexnow: sent ${urlList.length.toLocaleString()} URLs (HTTP ${res.status})`);
    } catch (err) {
      return console.error(`indexnow: submission failed after ${i.toLocaleString()} URLs:`, err);
    }
  }
}
