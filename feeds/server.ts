// The feed generator: ingests members' posts and serves
// app.bsky.feed.getFeedSkeleton for the feeds in feeds.ts.
//
//   PORT              default 3000
//   DATA_DIR          SQLite database and cached members.json (default .cache/feeds)
//   FEEDGEN_HOSTNAME  public host; the service DID is did:web:<host>
//   MEMBERS_URL       members.json to load at startup and every REFRESH_MINUTES
import fs from "fs";
import http from "http";
import path from "path";
import { openDb } from "./db.js";
import { FEEDS, PUBLISHER_DID, feedMembership, type Member } from "./feeds.js";
import { Jetstream, MAX_GAP_MS, backfill } from "./ingest.js";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? ".cache/feeds";
const HOSTNAME = process.env.FEEDGEN_HOSTNAME ?? "feeds.contributions.fyi";
const SERVICE_DID = `did:web:${HOSTNAME}`;
const MEMBERS_URL =
  process.env.MEMBERS_URL ??
  "https://raw.githubusercontent.com/hipstersmoothie/us-gov-contributions-labeler/main/data/members.json";
const REFRESH_MS = Number(process.env.REFRESH_MINUTES ?? 60) * 60 * 1000;

const db = openDb(DATA_DIR);
const jetstream = new Jetstream(db);

// After a long outage Jetstream can't replay everything; refetch from the AppView.
if (jetstream.gap() > MAX_GAP_MS) db.clearBackfilled();

// --- members ------------------------------------------------------------------

const MEMBERS_CACHE = path.join(DATA_DIR, "members.json");
let membership = feedMembership([]);
let membersLoadedAt: string | undefined;

function applyMembers(text: string, source: string) {
  const { members, generatedAt } = JSON.parse(text) as { members: Member[]; generatedAt?: string };
  const next = feedMembership(members);
  if (!next.all.size) throw new Error(`${source}: no member accounts`);
  membership = next;
  membersLoadedAt = generatedAt;
  console.log(
    `Members from ${source} (${generatedAt ?? "?"}): ${next.all.size} accounts; ` +
      FEEDS.map((f) => `${f.rkey} ${next.byFeed.get(f.rkey)!.length}`).join(", ")
  );
  const dids = [...next.all];
  jetstream.setDids(dids);
  void backfill(db, dids);
}

async function refreshMembers() {
  try {
    const etag = db.getState("members_etag");
    const res = await fetch(MEMBERS_URL, {
      headers: etag && fs.existsSync(MEMBERS_CACHE) ? { "if-none-match": etag } : {},
    });
    if (res.status === 304) {
      if (!membership.all.size) applyMembers(fs.readFileSync(MEMBERS_CACHE, "utf8"), "cache");
      // Unchanged, but retry any accounts whose backfill failed.
      else void backfill(db, [...membership.all]);
      return;
    }
    if (!res.ok) throw new Error(`${MEMBERS_URL}: ${res.status}`);
    const text = await res.text();
    applyMembers(text, MEMBERS_URL);
    fs.writeFileSync(MEMBERS_CACHE, text);
    const newEtag = res.headers.get("etag");
    if (newEtag) db.setState("members_etag", newEtag);
  } catch (err) {
    console.error("Members refresh failed:", err);
    if (!membership.all.size && fs.existsSync(MEMBERS_CACHE)) {
      try {
        applyMembers(fs.readFileSync(MEMBERS_CACHE, "utf8"), "cache");
      } catch (err) {
        console.error("Members cache unusable:", err);
      }
    }
  }
}

await refreshMembers();
setInterval(refreshMembers, REFRESH_MS);
setInterval(() => {
  try {
    const removed = db.prune();
    if (removed) console.log(`Pruned ${removed} posts older than 30 days`);
  } catch (err) {
    console.error("Prune failed:", err);
  }
}, 60 * 60 * 1000);

// --- HTTP -----------------------------------------------------------------------

const feedUri = (rkey: string) => `at://${PUBLISHER_DID}/app.bsky.feed.generator/${rkey}`;
const feedsByUri = new Map(FEEDS.map((f) => [feedUri(f.rkey), f]));

function json(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

function getFeedSkeleton(params: URLSearchParams) {
  const feed = feedsByUri.get(params.get("feed") ?? "");
  if (!feed) return { status: 400, body: { error: "UnknownFeed", message: "Unknown feed" } };

  const limit = Math.min(100, Math.max(1, Number(params.get("limit")) || 50));
  const rawCursor = params.get("cursor");
  let before: { sortAt: number; cid: string } | undefined;
  if (rawCursor) {
    const [sortAt, cid] = rawCursor.split("::");
    if (!sortAt || !cid || !Number.isFinite(Number(sortAt))) {
      return { status: 400, body: { error: "BadCursor", message: "Malformed cursor" } };
    }
    before = { sortAt: Number(sortAt), cid };
  }

  const rows = db.page(membership.byFeed.get(feed.rkey) ?? [], limit, before);
  const last = rows.at(-1);
  return {
    status: 200,
    body: {
      feed: rows.map((r) => ({ post: r.uri })),
      ...(last && rows.length === limit ? { cursor: `${last.sort_at}::${last.cid}` } : {}),
    },
  };
}

const server = http.createServer((req, res) => {
  // Not new URL: it throws on paths like "//", which would take the server down.
  const url = URL.parse(req.url ?? "/", "http://localhost");
  if (!url) return json(res, 400, { error: "InvalidRequest" });
  try {
    switch (url.pathname) {
      case "/.well-known/did.json":
        return json(res, 200, {
          "@context": ["https://www.w3.org/ns/did/v1"],
          id: SERVICE_DID,
          service: [{ id: "#bsky_fg", type: "BskyFeedGenerator", serviceEndpoint: `https://${HOSTNAME}` }],
        });
      case "/xrpc/app.bsky.feed.describeFeedGenerator":
        return json(res, 200, { did: SERVICE_DID, feeds: FEEDS.map((f) => ({ uri: feedUri(f.rkey) })) });
      case "/xrpc/app.bsky.feed.getFeedSkeleton": {
        const { status, body } = getFeedSkeleton(url.searchParams);
        return json(res, status, body);
      }
      case "/":
      case "/health": {
        const stats = db.stats();
        return json(res, 200, {
          service: SERVICE_DID,
          membersGeneratedAt: membersLoadedAt,
          accounts: membership.all.size,
          feeds: Object.fromEntries(FEEDS.map((f) => [f.rkey, membership.byFeed.get(f.rkey)!.length])),
          posts: stats.posts,
          authors: stats.authors,
          newestPost: stats.newest ? new Date(stats.newest).toISOString() : null,
          jetstreamLagSeconds: Math.round(jetstream.gap() / 1000),
          jetstreamEvents: jetstream.events,
        });
      }
      default:
        return json(res, 404, { error: "NotFound" });
    }
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: "InternalServerError" });
  }
});

server.listen(PORT, () => console.log(`Feed generator ${SERVICE_DID} on :${PORT}`));

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    jetstream.stop();
    server.close();
    process.exit(0);
  });
}
