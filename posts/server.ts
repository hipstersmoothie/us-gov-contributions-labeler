// Posts to Bluesky as @contributions.fyi on its own, from the data on `main`.
// See design/posts/README.md.
//
// Every few minutes it reloads the data, asks each series what it wants to
// post, queues anything new (a post's key makes it happen once), and posts
// the next one that's due: at most one per tick, MIN_GAP_MINUTES apart, only
// during POST_HOURS Eastern, and up to each series' daily cap.
//
//   POSTS_APP_PASSWORD   app password for POSTS_IDENTIFIER (default the labeler's DID)
//   POSTS_<SERIES>       on (default), off, or dry (log what it would post): POSTS_MEMBER_ELECT,
//                        POSTS_NEW_ON_BLUESKY
//   DATA_DIR             SQLite database and cached data files (default .cache/posts)
//   DATA_URL             where the data files are (default main on GitHub)
//   SITE_URL             default https://contributions.fyi
//   TICK_MINUTES (5), MIN_GAP_MINUTES (45), SETTLE_MINUTES (30), POST_HOURS (8-21)
//
//   pnpm posts           run
//   pnpm posts --dry     every series dry, no login: what it would queue and post
//   pnpm posts --once    one tick, then exit
import { parseArgs } from "util";
import { RemoteData, type Data } from "./data.js";
import { openDb } from "./db.js";
import { fetchPage, Poster } from "./bsky.js";
import { memberElect } from "./series/member-elect.js";
import { membersOnBluesky, newOnBluesky } from "./series/new-on-bluesky.js";
import { SERIES, type Draft, type SeriesName } from "./series/types.js";

const { values: args } = parseArgs({ options: { dry: { type: "boolean" }, once: { type: "boolean" } } });

const minutes = (name: string, fallback: number) => Number(process.env[name] ?? fallback) * 60 * 1000;
const DATA_DIR = process.env.DATA_DIR ?? ".cache/posts";
const DATA_URL = process.env.DATA_URL ?? "https://raw.githubusercontent.com/hipstersmoothie/us-gov-contributions-labeler/main/data";
const SITE_URL = (process.env.SITE_URL ?? "https://contributions.fyi").replace(/\/$/, "");
const IDENTIFIER = process.env.POSTS_IDENTIFIER ?? "did:plc:ylmdlijvrvgbe4md6v4dyce6";
const TICK_MS = minutes("TICK_MINUTES", 5);
const MIN_GAP_MS = minutes("MIN_GAP_MINUTES", 45);
// Time for the site to deploy the data a new post is about.
const SETTLE_MS = minutes("SETTLE_MINUTES", 30);
const [FIRST_HOUR, LAST_HOUR] = (process.env.POST_HOURS ?? "8-21").split("-").map(Number) as [number, number];
const DAY_MS = 24 * 60 * 60 * 1000;
const RETRY_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 48; // a day of retries, for a page that hasn't deployed
// More new posts than this from one series in one tick looks like bad data, not news: hold them.
const MAX_NEW_PER_TICK = 80;

type Mode = "on" | "off" | "dry";
const modeOf = (s: SeriesName): Mode => {
  if (args.dry) return "dry";
  const v = process.env[`POSTS_${s.toUpperCase().replace(/-/g, "_")}`] ?? "on";
  if (v !== "on" && v !== "off" && v !== "dry") throw new Error(`POSTS_${s}: on, off or dry, not ${v}`);
  return v;
};
const modes = Object.fromEntries((Object.keys(SERIES) as SeriesName[]).map((s) => [s, modeOf(s)])) as Record<SeriesName, Mode>;

const password = process.env.POSTS_APP_PASSWORD;
if (!args.dry && !password) throw new Error("POSTS_APP_PASSWORD is required (or --dry)");
const poster = password ? new Poster(IDENTIFIER, password) : undefined;
const db = openDb(DATA_DIR);
const remote = new RemoteData(DATA_URL, `${DATA_DIR}/data`);
const loggedDry = new Set<string>();

const hourEastern = (t: number) =>
  Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(t));

const SEEN_KEY = "bsky_seen";
/** Members already on Bluesky. The first run records them without posting. */
async function blueskyDrafts(data: Data): Promise<Draft[]> {
  const on = membersOnBluesky(data).map((m) => m.bioguide);
  const stored = db.getState(SEEN_KEY);
  if (!stored) {
    db.setState(SEEN_KEY, JSON.stringify(on));
    console.log(`new-on-bluesky: recorded the ${on.length} members already on Bluesky`);
    return [];
  }
  return newOnBluesky(data, new Set(JSON.parse(stored) as string[]));
}
function markSeen(bioguides: string[]) {
  const seen = new Set(JSON.parse(db.getState(SEEN_KEY) ?? "[]") as string[]);
  for (const b of bioguides) seen.add(b);
  db.setState(SEEN_KEY, JSON.stringify([...seen]));
}

function enqueue(drafts: Draft[]) {
  const bySeries = new Map<SeriesName, Draft[]>();
  for (const d of drafts) bySeries.set(d.series, [...(bySeries.get(d.series) ?? []), d]);
  for (const [series, list] of bySeries) {
    const mode = modes[series];
    const fresh = list.filter((d) => !db.has(d.key));
    if (mode === "off" || !fresh.length) continue;
    if (mode === "dry") {
      for (const d of fresh.filter((d) => !loggedDry.has(d.key))) {
        loggedDry.add(d.key);
        console.log(`[dry] would queue ${d.key} → ${SITE_URL}${d.link}\n${d.text}\n`);
      }
      continue;
    }
    if (fresh.length > MAX_NEW_PER_TICK) {
      console.error(`${series}: ${fresh.length} new posts at once; holding them all. Check the data, then raise MAX_NEW_PER_TICK or post in batches.`);
      continue;
    }
    for (const d of fresh) if (db.queue(d, Date.now() + SETTLE_MS)) console.log(`Queued ${d.key}`);
    if (series === "new-on-bluesky") markSeen(fresh.map((d) => d.key.replace(/^bsky:/, "")));
  }
}

async function postNext(now = Date.now()) {
  if (!poster) return;
  const hour = hourEastern(now);
  if (hour < FIRST_HOUR || hour >= LAST_HOUR) return;
  if (now - db.lastPostedAt() < MIN_GAP_MS) return;
  for (const row of db.due(now)) {
    if (modes[row.series] !== "on") continue;
    if (db.postedSince(row.series, now - DAY_MS) >= SERIES[row.series].dailyCap) continue;
    try {
      const page = await fetchPage(`${SITE_URL}${row.link}`, row.expect ?? undefined);
      const card = { ...page, title: row.title ?? page.title, description: row.description ?? page.description };
      const uri = await poster.post(row.text, card, row.mentions ? JSON.parse(row.mentions) : undefined);
      db.posted(row.key, uri);
      console.log(`Posted ${row.key}: ${uri}`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      db.failed(row.key, message, MAX_ATTEMPTS, RETRY_MS);
      console.error(`${row.key} not posted: ${message}`);
    }
  }
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const data = await remote.load();
    const { drafts, skipped } = memberElect(data);
    for (const s of skipped.filter((s) => !loggedDry.has(s))) {
      loggedDry.add(s);
      console.log(`Not yet: ${s}`);
    }
    enqueue([...drafts, ...(modes["new-on-bluesky"] === "off" ? [] : await blueskyDrafts(data))]);
    await postNext();
  } catch (err) {
    console.error("Tick failed:", err);
  } finally {
    running = false;
  }
}

console.log(`Posts as ${IDENTIFIER}: ${Object.entries(modes).map(([s, m]) => `${s} ${m}`).join(", ")}`);
console.log(db.counts().map((c) => `${c.series} ${c.status}: ${c.n}`).join("\n") || "No posts yet");
await tick();
if (!args.once) setInterval(tick, TICK_MS);
