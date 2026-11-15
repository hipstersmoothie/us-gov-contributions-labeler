// Getting members' posts into the database: live from Jetstream, and from the
// AppView for accounts we haven't seen before (or after a long outage).
import { RETENTION_MS, type Db, type Post } from "./db.js";

const JETSTREAM_HOSTS = (
  process.env.JETSTREAM_HOSTS ??
  "jetstream2.us-east.bsky.network,jetstream1.us-east.bsky.network,jetstream1.us-west.bsky.network,jetstream2.us-west.bsky.network"
).split(",");
const COLLECTION = "app.bsky.feed.post";
const CURSOR_KEY = "jetstream_cursor";
// Replay a few seconds on reconnect; inserts are idempotent.
const REPLAY_US = 5_000_000;
// Jetstream keeps about a day; past this, catch up from the AppView instead.
export const MAX_GAP_MS = 12 * 60 * 60 * 1000;
// No events at all for this long probably means a dead connection.
const IDLE_MS = 10 * 60 * 1000;

interface PostRecord {
  createdAt?: string;
  reply?: unknown;
}

function sortAt(createdAt: string | undefined, seenAt: number) {
  const created = createdAt ? Date.parse(createdAt) : NaN;
  return Number.isFinite(created) ? Math.min(created, seenAt) : seenAt;
}

// --- Jetstream ----------------------------------------------------------------

interface JetstreamEvent {
  did: string;
  time_us: number;
  kind: string;
  commit?: {
    operation: "create" | "update" | "delete";
    collection: string;
    rkey: string;
    cid?: string;
    record?: PostRecord;
  };
}

export class Jetstream {
  private ws?: WebSocket;
  private dids: string[] = [];
  private cursor?: number;
  private hostIndex = 0;
  private failures = 0;
  private lastEventAt = Date.now();
  private stopped = false;
  events = 0;

  constructor(private db: Db) {
    const saved = db.getState(CURSOR_KEY);
    if (saved) this.cursor = Number(saved);
    setInterval(() => this.cursor && db.setState(CURSOR_KEY, String(this.cursor)), 5000).unref();
    setInterval(() => {
      if (this.ws && Date.now() - this.lastEventAt > IDLE_MS) {
        console.log("Jetstream: idle, reconnecting");
        this.ws.close();
      }
    }, 60_000).unref();
  }

  /** How far behind live the saved cursor is, in ms (Infinity if none). */
  gap() {
    return this.cursor ? Date.now() - this.cursor / 1000 : Infinity;
  }

  /** Follow these DIDs, connecting if needed. Never subscribes with an empty
   *  list: Jetstream treats that as "everyone". */
  setDids(dids: string[]) {
    this.dids = dids;
    if (!dids.length) return;
    if (this.ws?.readyState === WebSocket.OPEN) this.sendOptions();
    else if (!this.ws) this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.cursor) this.db.setState(CURSOR_KEY, String(this.cursor));
    this.ws?.close();
  }

  private sendOptions() {
    this.ws?.send(
      JSON.stringify({
        type: "options_update",
        payload: { wantedCollections: [COLLECTION], wantedDids: this.dids, maxMessageSizeBytes: 0 },
      })
    );
  }

  private connect() {
    const host = JETSTREAM_HOSTS[this.hostIndex % JETSTREAM_HOSTS.length];
    const qs = new URLSearchParams({ wantedCollections: COLLECTION, requireHello: "true" });
    if (this.cursor) qs.set("cursor", String(this.cursor - REPLAY_US));
    const ws = new WebSocket(`wss://${host}/subscribe?${qs}`);
    this.ws = ws;
    this.lastEventAt = Date.now();

    ws.addEventListener("open", () => {
      console.log(`Jetstream: connected to ${host}, ${this.dids.length} DIDs`);
      this.sendOptions();
    });
    ws.addEventListener("message", (msg) => {
      this.lastEventAt = Date.now();
      this.failures = 0;
      try {
        this.handle(JSON.parse(String(msg.data)) as JetstreamEvent);
      } catch (err) {
        console.error("Jetstream: bad event", err);
      }
    });
    ws.addEventListener("error", (e) => console.error(`Jetstream: ${host} error`, (e as ErrorEvent).message ?? ""));
    ws.addEventListener("close", () => {
      if (this.ws === ws) this.ws = undefined;
      if (this.stopped) return;
      this.failures++;
      // Move to the next host after repeated failures.
      if (this.failures % 3 === 0) this.hostIndex++;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(this.failures, 6));
      console.log(`Jetstream: closed, reconnecting in ${delay / 1000}s`);
      setTimeout(() => this.connect(), delay);
    });
  }

  private handle(e: JetstreamEvent) {
    this.events++;
    this.cursor = e.time_us;
    const c = e.commit;
    if (e.kind !== "commit" || !c || c.collection !== COLLECTION) return;
    const uri = `at://${e.did}/${COLLECTION}/${c.rkey}`;
    if (c.operation === "delete") {
      this.db.remove(uri);
    } else if (c.operation === "create" && c.cid) {
      this.db.insert({
        uri,
        cid: c.cid,
        did: e.did,
        sortAt: sortAt(c.record?.createdAt, e.time_us / 1000),
        reply: !!c.record?.reply,
      });
    }
  }
}

// --- backfill -------------------------------------------------------------------

const APPVIEW = process.env.APPVIEW_URL ?? "https://public.api.bsky.app";

interface FeedViewPost {
  post: { uri: string; cid: string; author: { did: string }; record: PostRecord; indexedAt: string };
  reason?: unknown;
}

/** The last RETENTION_MS of one account's own posts, from the AppView. */
async function authorPosts(did: string) {
  const since = Date.now() - RETENTION_MS;
  const posts: Post[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({ actor: did, filter: "posts_no_replies", limit: "100" });
    if (cursor) qs.set("cursor", cursor);
    let res: Response | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      res = await fetch(`${APPVIEW}/xrpc/app.bsky.feed.getAuthorFeed?${qs}`);
      if (res.ok || (res.status < 500 && res.status !== 429)) break;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
    // 400: deactivated, taken down or unknown account; nothing to add.
    if (!res?.ok) {
      if (res?.status === 400) return posts;
      throw new Error(`getAuthorFeed ${did}: ${res?.status}`);
    }
    const body = (await res.json()) as { feed: FeedViewPost[]; cursor?: string };
    let older = false;
    for (const item of body.feed) {
      if (item.reason || item.post.author.did !== did) continue;
      const at = sortAt(item.post.record.createdAt, Date.parse(item.post.indexedAt));
      if (at < since) {
        older = true;
        continue;
      }
      posts.push({ uri: item.post.uri, cid: item.post.cid, did, sortAt: at, reply: !!item.post.record.reply });
    }
    cursor = body.cursor;
    if (older || !cursor || !body.feed.length) break;
  }
  return posts;
}

let backfilling: Promise<void> | undefined;

/** Fetch recent posts for every DID not backfilled yet. One run at a time. */
export function backfill(db: Db, dids: string[]) {
  const run = async () => {
    const todo = dids.filter((d) => !db.isBackfilled(d));
    if (!todo.length) return;
    console.log(`Backfill: ${todo.length} accounts`);
    let added = 0;
    const queue = [...todo];
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let did = queue.shift(); did; did = queue.shift()) {
          try {
            const posts = await authorPosts(did);
            db.insertMany(posts);
            db.markBackfilled(did);
            added += posts.length;
          } catch (err) {
            console.error(`Backfill: ${did} failed, will retry on the next refresh`, err);
          }
        }
      })
    );
    console.log(`Backfill: done, ${added} posts`);
  };
  backfilling = (backfilling ?? Promise.resolve()).then(run, run);
  return backfilling;
}
