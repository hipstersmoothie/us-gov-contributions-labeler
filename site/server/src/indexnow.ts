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
// again, which IndexNow tolerates; after that, a restart sends nothing. A batch
// IndexNow turns away for now (a key it hasn't checked yet, too many requests)
// is sent again every 10 minutes for 2 hours.
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
/**
 * How long to wait before sending a batch again, and how many times. IndexNow
 * answers 403 SiteVerificationNotCompleted until it has fetched a new key
 * file (minutes, the first time), 429 when it wants fewer requests, and 5xx
 * when it's having trouble; all of those pass with time.
 */
const RETRY_MS = 10 * 60 * 1000;
const RETRIES = 12;

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
    for (let attempt = 0; ; attempt++) {
      let failure: string;
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ host, key: KEY, keyLocation: new URL(`${KEY}.txt`, site).href, urlList }),
          signal: AbortSignal.timeout(60_000),
        });
        // 200 and 202 are both success; 202 means the key is still being checked.
        if (res.ok) {
          console.log(`indexnow: sent ${urlList.length.toLocaleString()} URLs (HTTP ${res.status})`);
          break;
        }
        failure = `HTTP ${res.status} ${await res.text().catch(() => "")}`.trim();
        // Anything else (400 bad request, 422 URLs not on this host) won't change by asking again.
        if (!(res.status === 403 || res.status === 429 || res.status >= 500)) {
          return console.error(`indexnow: submission refused after ${i.toLocaleString()} URLs: ${failure}`);
        }
      } catch (err) {
        failure = String(err);
      }
      if (attempt === RETRIES) {
        return console.error(`indexnow: gave up after ${i.toLocaleString()} URLs: ${failure}`);
      }
      console.warn(`indexnow: ${failure}; trying again in ${RETRY_MS / 60_000} minutes`);
      await wait(RETRY_MS);
    }
  }
}
