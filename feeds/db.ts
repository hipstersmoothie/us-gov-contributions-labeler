// Recent posts by members' accounts, in SQLite.
import fs from "fs";
import path from "path";
import Database from "libsql";

export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface Post {
  uri: string;
  cid: string;
  did: string;
  /** ms; the earlier of the post's createdAt and when the network saw it */
  sortAt: number;
  reply: boolean;
}

export function openDb(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "feeds.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS posts (
      uri TEXT PRIMARY KEY,
      cid TEXT NOT NULL,
      did TEXT NOT NULL,
      sort_at INTEGER NOT NULL,
      reply INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS posts_sort ON posts (sort_at DESC, cid DESC);
    CREATE INDEX IF NOT EXISTS posts_did ON posts (did, sort_at DESC);
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS backfilled (did TEXT PRIMARY KEY, at INTEGER NOT NULL);
  `);

  const insert = db.prepare(
    "INSERT OR IGNORE INTO posts (uri, cid, did, sort_at, reply) VALUES (?, ?, ?, ?, ?)"
  );
  const remove = db.prepare("DELETE FROM posts WHERE uri = ?");
  const getState = db.prepare("SELECT value FROM state WHERE key = ?");
  const setState = db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)");
  const page = db.prepare(`
    SELECT uri, cid, sort_at FROM posts
    WHERE reply = 0
      AND did IN (SELECT value FROM json_each(?))
      AND (sort_at < ? OR (sort_at = ? AND cid < ?))
    ORDER BY sort_at DESC, cid DESC
    LIMIT ?
  `);

  return {
    insert(p: Post) {
      insert.run(p.uri, p.cid, p.did, p.sortAt, p.reply ? 1 : 0);
    },
    insertMany: db.transaction((posts: Post[]) => {
      for (const p of posts) insert.run(p.uri, p.cid, p.did, p.sortAt, p.reply ? 1 : 0);
    }),
    remove(uri: string) {
      remove.run(uri);
    },
    prune() {
      return db.prepare("DELETE FROM posts WHERE sort_at < ?").run(Date.now() - RETENTION_MS).changes;
    },
    getState(key: string) {
      return (getState.get(key) as { value: string } | undefined)?.value;
    },
    setState(key: string, value: string) {
      setState.run(key, value);
    },
    isBackfilled(did: string) {
      return !!db.prepare("SELECT 1 FROM backfilled WHERE did = ?").get(did);
    },
    markBackfilled(did: string) {
      db.prepare("INSERT OR REPLACE INTO backfilled (did, at) VALUES (?, ?)").run(did, Date.now());
    },
    clearBackfilled() {
      db.exec("DELETE FROM backfilled");
    },
    /** Newest top-level posts by these authors, before the cursor. */
    page(dids: string[], limit: number, before?: { sortAt: number; cid: string }) {
      const sortAt = before?.sortAt ?? Number.MAX_SAFE_INTEGER;
      const cid = before?.cid ?? "";
      return page.all(JSON.stringify(dids), sortAt, sortAt, cid, limit) as {
        uri: string;
        cid: string;
        sort_at: number;
      }[];
    },
    stats() {
      return db.prepare("SELECT count(*) AS posts, count(DISTINCT did) AS authors, max(sort_at) AS newest FROM posts").get() as {
        posts: number;
        authors: number;
        newest: number | null;
      };
    },
  };
}

export type Db = ReturnType<typeof openDb>;
