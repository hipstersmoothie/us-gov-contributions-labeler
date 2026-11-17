// The queue and log of posts, in SQLite. A post's key is its primary key, so
// queueing the same post twice does nothing.
import fs from "fs";
import path from "path";
import Database from "libsql";
import type { Draft, SeriesName } from "./series/types.js";

export type Status = "queued" | "posted" | "failed";

export interface Row {
  key: string;
  series: SeriesName;
  text: string;
  link: string;
  title: string | null;
  description: string | null;
  expect: string | null;
  mentions: string | null;
  priority: number;
  status: Status;
  not_before: number;
  attempts: number;
  error: string | null;
  uri: string | null;
  created_at: number;
  posted_at: number | null;
}

export function openDb(dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, "posts.db"));
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS posts (
      key TEXT PRIMARY KEY,
      series TEXT NOT NULL,
      text TEXT NOT NULL,
      link TEXT NOT NULL,
      title TEXT,
      description TEXT,
      expect TEXT,
      mentions TEXT,
      priority INTEGER NOT NULL,
      status TEXT NOT NULL,
      not_before INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      uri TEXT,
      created_at INTEGER NOT NULL,
      posted_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS posts_queue ON posts (status, priority, created_at);
    CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const insert = db.prepare(`
    INSERT OR IGNORE INTO posts (key, series, text, link, title, description, expect, mentions, priority, status, not_before, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
  `);
  const getState = db.prepare("SELECT value FROM state WHERE key = ?");
  const setState = db.prepare("INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)");

  return {
    has(key: string) {
      return !!db.prepare("SELECT 1 FROM posts WHERE key = ?").get(key);
    },
    /** Queue a draft to go out no sooner than `notBefore`. False if it was already known. */
    queue(d: Draft, notBefore: number) {
      const now = Date.now();
      return (
        insert.run(d.key, d.series, d.text, d.link, d.title ?? null, d.description ?? null, d.expect ?? null, d.mentions ? JSON.stringify(d.mentions) : null, d.priority, notBefore, now)
          .changes > 0
      );
    },
    /** Queued posts that are due, in order. */
    due(now = Date.now()) {
      return db.prepare("SELECT * FROM posts WHERE status = 'queued' AND not_before <= ? ORDER BY priority, created_at, key").all(now) as Row[];
    },
    posted(key: string, uri: string) {
      db.prepare("UPDATE posts SET status = 'posted', uri = ?, posted_at = ?, error = NULL WHERE key = ?").run(uri, Date.now(), key);
    },
    /** A failed attempt; after `maxAttempts` the post is given up on. Retries wait `retryMs`. */
    failed(key: string, error: string, maxAttempts: number, retryMs: number) {
      db.prepare(
        `UPDATE posts SET attempts = attempts + 1, error = ?, not_before = ?,
           status = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE status END
         WHERE key = ?`
      ).run(error, Date.now() + retryMs, maxAttempts, key);
    },
    /** When the last post went out, of any series or of one. */
    lastPostedAt(series?: SeriesName) {
      const row = (
        series
          ? db.prepare("SELECT max(posted_at) AS at FROM posts WHERE status = 'posted' AND series = ?").get(series)
          : db.prepare("SELECT max(posted_at) AS at FROM posts WHERE status = 'posted'").get()
      ) as { at: number | null };
      return row.at ?? 0;
    },
    /** Posts made since `since`, of any series or of one. */
    postedSince(since: number, series?: SeriesName) {
      const row = (
        series
          ? db.prepare("SELECT count(*) AS n FROM posts WHERE status = 'posted' AND posted_at >= ? AND series = ?").get(since, series)
          : db.prepare("SELECT count(*) AS n FROM posts WHERE status = 'posted' AND posted_at >= ?").get(since)
      ) as { n: number };
      return row.n;
    },
    counts() {
      return db.prepare("SELECT series, status, count(*) AS n FROM posts GROUP BY series, status ORDER BY series, status").all() as {
        series: string;
        status: Status;
        n: number;
      }[];
    },
    getState(key: string) {
      return (getState.get(key) as { value: string } | undefined)?.value;
    },
    setState(key: string, value: string) {
      setState.run(key, value);
    },
  };
}

export type Db = ReturnType<typeof openDb>;
