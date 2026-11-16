// Combine our reading of a scanned row with the second reader's
// (scan/second-reader.ts). Two independent readers that agree confirm a row;
// a row we flagged is filled in only where the second reader supplies what we
// couldn't read and agrees with everything we could. Everything else goes to
// a review queue (.cache/disclosures/scan/review.json) for a person, and the
// person's decisions (.holdings-review/decisions.json, gitignored, written by
// scan/review-server.ts) are applied here on the next build.
import fs from "fs";
import { CACHE } from "../common.js";
import { VALUES, type ScannedHolding } from "./annual.js";
import { AMOUNTS, isoDate, type ScannedTrade } from "./ptr.js";

const DIR = `${CACHE}/scan/second-reader`;
export const QUEUE = `${CACHE}/scan/review.json`;
/**
 * The user's review decisions: real work once reviewing starts, so never
 * delete them. Tests set REVIEW_DIR to a scratch directory instead.
 */
export const DECISIONS = `${process.env.REVIEW_DIR ?? ".holdings-review"}/decisions.json`;
type Owner = ScannedTrade["owner"];

interface PtrReading { n: number; owner: string; transaction: string; trade_date: string; notified_date: string; amount_column: string }
interface AnnualReading { n: number; asset: string; owner: string; value_column: string }
interface Job { id: string; names: string[] }

const read = <T>(file: string, empty: T): T => (fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : empty);
const readings = read<Record<string, { rows: (PtrReading | AnnualReading)[]; missed?: { asset: string; trade_date: string }[] }>>(`${DIR}/readings.json`, {});
const jobs = new Map(read<Job[]>(`${DIR}/jobs.json`, []).map((j) => [j.id, j]));

/** One reading of a row, in the review tool's terms. Amounts and values are the form's column letters. */
export interface Fields {
  asset?: string;
  owner?: Owner;
  tx?: "purchase" | "sale" | "exchange";
  partial?: boolean;
  date?: string;
  notified?: string;
  column?: string;
}

export interface ReviewItem {
  key: string;
  /** disputed: the readers disagree; second-only: only the second reader found the row; unread: neither could read it. */
  kind: "disputed" | "second-only" | "unread";
  form: "ptr" | "annual";
  docId: string;
  page: number;
  bioguide: string;
  member: string;
  docUrl: string;
  y0?: number;
  y1?: number;
  a?: Fields;
  b?: Fields;
  why: string[];
}

export interface Decision {
  action: "a" | "b" | "edit" | "unreadable";
  fields?: Fields;
  at: string;
}

export interface Context {
  bioguide: string;
  member: string;
  docUrl: string;
}

const OWNERS: Record<string, Owner | undefined> = { SP: "spouse", DC: "child", JT: "joint", blank: "self" };
const TX: Record<string, string | undefined> = { purchase: "Bought", sale: "Sold", partial_sale: "Sold some", exchange: "Exchanged" };
const column = (c: string, table: [number, number | null][]) => (/^[A-M]$/.test(c) ? table[c.charCodeAt(0) - 65] : undefined);
const letterOf = (min: number | undefined, max: number | null | undefined, table: [number, number | null][]) => {
  const i = table.findIndex(([a, b]) => a === min && b === (max ?? null));
  return i < 0 ? undefined : String.fromCharCode(65 + i);
};
const txFields = (tx?: string): Pick<Fields, "tx" | "partial"> =>
  tx === "Bought" ? { tx: "purchase" } : tx === "Sold" ? { tx: "sale", partial: false } : tx === "Sold some" ? { tx: "sale", partial: true } : tx === "Exchanged" ? { tx: "exchange" } : {};
const txName = (f: Fields) => (f.tx === "purchase" ? "Bought" : f.tx === "exchange" ? "Exchanged" : f.tx === "sale" ? (f.partial ? "Sold some" : "Sold") : undefined);

const ourTrade = (t: ScannedTrade): Fields => ({
  asset: t.asset,
  owner: t.owner,
  ...txFields(t.tx),
  date: t.date,
  notified: t.notified,
  column: letterOf(t.min, t.max, AMOUNTS),
});
const theirTrade = (r: PtrReading): Fields => ({
  owner: OWNERS[r.owner],
  ...txFields(TX[r.transaction]),
  date: isoDate(r.trade_date),
  notified: isoDate(r.notified_date),
  column: /^[A-K]$/.test(r.amount_column) ? r.amount_column : undefined,
});
const ourHolding = (h: ScannedHolding): Fields => ({ asset: h.asset, owner: h.owner, column: letterOf(h.min, h.max, VALUES) });
const theirHolding = (r: AnnualReading): Fields => ({
  asset: r.asset.trim() || undefined,
  owner: OWNERS[r.owner],
  column: /^[A-M]$/.test(r.value_column) ? r.value_column : undefined,
});

export const stats = { confirmed: 0, filled: 0, disagreed: 0, unreadBoth: 0, noReading: 0, secondOnly: 0, byHand: 0, handUnreadable: 0 };
const queue: ReviewItem[] = [];
const decisions = read<Record<string, Decision>>(DECISIONS, {});

/** A row's name without owner tags, which later parses may move out of it. */
export const sameRow = (a: string, b: string) => {
  const norm = (s: string) => s.replace(/\b(?:[S5$]P|D[CO0]|J[T1])\b/g, "").replace(/\s+/g, "");
  return norm(a) === norm(b);
};

/** A key that survives rebuilds: the page, the name as read and the date, numbered if repeated. */
const seen = new Map<string, number>();
function keyOf(...parts: (string | number | undefined)[]) {
  const base = parts.map((p) => String(p ?? "").toUpperCase().replace(/[^A-Z0-9/-]+/g, "").slice(0, 40)).join(":");
  const n = (seen.get(base) ?? 0) + 1;
  seen.set(base, n);
  return n === 1 ? base : `${base}#${n}`;
}

/** The second reader's row for the i-th row we read on a page, if the page was read and still lines up. */
function readingFor<T>(id: string, index: number, name: string): T | undefined {
  const job = jobs.get(id);
  // Our parse has to be the one the second reader was shown.
  if (!job || !sameRow(job.names[index] ?? "", name || "(no name read)")) return undefined;
  return readings[id]?.rows.find((r) => r.n === index + 1) as T | undefined;
}

type Checked<T> = T & { confirmedBy?: string; checkedByHand?: boolean };

/** A row a person has decided on: their fields, or null when they marked it unreadable. */
function decided(key: string): Fields | null | undefined {
  const d = decisions[key];
  if (!d) return undefined;
  if (d.action === "unreadable" || !d.fields) {
    stats.handUnreadable++;
    return null;
  }
  stats.byHand++;
  return d.fields;
}

function tradeFrom(f: Fields, page: number, base?: ScannedTrade): Checked<ScannedTrade> | undefined {
  const range = f.column ? column(f.column, AMOUNTS) : undefined;
  if (!f.asset || !f.date || !txName(f) || !range) return undefined;
  return {
    ...base,
    page,
    asset: f.asset,
    owner: f.owner ?? "self",
    tx: txName(f),
    date: f.date,
    notified: f.notified,
    min: range[0],
    max: range[1],
    doubts: [],
    checkedByHand: true,
  };
}

/**
 * Resolve one machine-read trade. Returns the trade to show (doubts cleared and
 * `confirmedBy` or `checkedByHand` set), or undefined to leave it out.
 */
export function resolveTrade(docId: string, t: ScannedTrade, index: number, ctx: Context): Checked<ScannedTrade> | undefined {
  const key = keyOf(docId, t.page, t.asset, t.date);
  const r = readingFor<PtrReading>(`p-${docId}-${t.page}`, index, t.asset);
  const hand = (kind: ReviewItem["kind"], why: string[]) => {
    queue.push({ key, kind, form: "ptr", docId, page: t.page, ...ctx, docUrl: `${ctx.docUrl}#page=${t.page + 1}`, y0: t.y0, y1: t.y1, a: ourTrade(t), b: r && theirTrade(r), why });
    const f = decided(key);
    return f ? tradeFrom(f, t.page, t) : undefined;
  };
  if (!r) {
    stats.noReading++;
    return t.doubts.length ? hand("unread", t.doubts) : t;
  }
  const theirs = {
    owner: OWNERS[r.owner],
    tx: TX[r.transaction],
    date: isoDate(r.trade_date),
    range: column(r.amount_column, AMOUNTS),
  };
  const doubted = {
    tx: t.doubts.some((d) => d.startsWith("type")),
    amount: t.doubts.some((d) => d.startsWith("amount") || d.includes("amount columns")),
    date: t.doubts.some((d) => /trade date|weekend|90 days|notified before/.test(d)),
    owner: t.doubts.includes("owner unclear"),
    name: t.doubts.some((d) => d.includes("asset name")),
  };
  // Where we read a field without doubt, the second reader must agree.
  const conflicts = [
    !doubted.tx && t.tx && theirs.tx && theirs.tx !== t.tx && "type",
    !doubted.amount && t.min !== undefined && theirs.range && theirs.range[0] !== t.min && "amount",
    !doubted.date && t.date && theirs.date && theirs.date !== t.date && "trade date",
    !doubted.owner && theirs.owner && theirs.owner !== t.owner && "owner",
  ].filter((c): c is string => !!c);
  if (conflicts.length) {
    stats.disagreed++;
    return hand("disputed", conflicts.map((c) => `readers disagree on ${c}`));
  }
  if (!t.doubts.length) {
    stats.confirmed++;
    return { ...t, confirmedBy: "second reader" };
  }
  // Flagged: the second reader has to supply every doubted field.
  const missing =
    (doubted.tx && !theirs.tx) || (doubted.amount && !theirs.range) || (doubted.date && !theirs.date) || (doubted.owner && !theirs.owner) || doubted.name;
  // A date it supplies has to make sense: a weekday, on or before notification.
  const date = doubted.date ? theirs.date : t.date;
  const notified = isoDate(r.notified_date) ?? t.notified;
  const plausible = date && [1, 2, 3, 4, 5].includes(new Date(`${date}T12:00:00Z`).getUTCDay()) && (!notified || notified >= date);
  if (missing || !plausible) {
    stats.unreadBoth++;
    return hand("unread", t.doubts);
  }
  stats.filled++;
  return {
    ...t,
    tx: doubted.tx ? theirs.tx : t.tx,
    min: doubted.amount ? theirs.range![0] : t.min,
    max: doubted.amount ? theirs.range![1] : t.max,
    date,
    notified,
    owner: doubted.owner ? theirs.owner! : t.owner,
    doubts: [],
    confirmedBy: "second reader",
  };
}

/**
 * Trade rows on a report's pages that only the second reader found. They
 * aren't shown on one reader's word: each goes to the review queue, and only
 * a person's decision puts it on the site.
 */
export function secondReaderOnly(docId: string, ctx: Context): Checked<ScannedTrade>[] {
  const out: Checked<ScannedTrade>[] = [];
  for (const [id, reading] of Object.entries(readings)) {
    if (!id.startsWith(`p-${docId}-`)) continue;
    const page = Number(id.split("-")[2]);
    for (const m of reading.missed ?? []) {
      stats.secondOnly++;
      const date = isoDate(m.trade_date);
      const key = keyOf(docId, page, "missed", m.asset, date);
      queue.push({ key, kind: "second-only", form: "ptr", docId, page, ...ctx, docUrl: `${ctx.docUrl}#page=${page + 1}`, b: { asset: m.asset, date }, why: ["only the second reader found this row"] });
      const f = decided(key);
      const t = f && tradeFrom(f, page);
      if (t) out.push(t);
    }
  }
  return out;
}

/** Resolve one machine-read Schedule A row the same way. */
export function resolveHolding(docId: string, h: ScannedHolding, index: number, ctx: Context): Checked<ScannedHolding> | undefined {
  const key = keyOf(docId, h.page, "a", h.asset);
  const r = readingFor<AnnualReading>(`a-${docId}-${h.page}`, index, h.asset);
  const hand = (kind: ReviewItem["kind"], why: string[]): Checked<ScannedHolding> | undefined => {
    queue.push({ key, kind, form: "annual", docId, page: h.page, ...ctx, docUrl: `${ctx.docUrl}#page=${h.page + 1}`, y0: h.y0, y1: h.y1, a: ourHolding(h), b: r && theirHolding(r), why });
    const f = decided(key);
    const range = f?.column ? column(f.column, VALUES) : undefined;
    if (!f || !range || !f.asset) return undefined;
    return { ...h, asset: f.asset, owner: f.owner ?? "self", min: range[0], max: range[1], doubts: [], checkedByHand: true };
  };
  if (!r) {
    stats.noReading++;
    return h.doubts.length ? hand("unread", h.doubts) : h;
  }
  const range = column(r.value_column, VALUES);
  const owner = OWNERS[r.owner];
  const doubted = {
    value: h.doubts.some((d) => d.startsWith("value")),
    owner: h.doubts.includes("owner unclear"),
    name: h.doubts.some((d) => d.includes("asset name")),
  };
  const conflicts = [
    !doubted.value && h.min !== undefined && range && range[0] !== h.min && "value",
    !doubted.owner && owner && owner !== h.owner && "owner",
  ].filter((c): c is string => !!c);
  if (conflicts.length) {
    stats.disagreed++;
    return hand("disputed", conflicts.map((c) => `readers disagree on ${c}`));
  }
  if (!h.doubts.length) {
    stats.confirmed++;
    return { ...h, confirmedBy: "second reader" };
  }
  if ((doubted.value && !range) || (doubted.owner && !owner) || (doubted.name && !r.asset.trim())) {
    stats.unreadBoth++;
    return hand("unread", h.doubts);
  }
  stats.filled++;
  return {
    ...h,
    // A low-confidence or missing name (handwriting, mostly): use the second reader's.
    asset: doubted.name ? r.asset.trim() : h.asset,
    min: doubted.value ? range![0] : h.min,
    max: doubted.value ? range![1] : h.max,
    owner: doubted.owner ? owner! : h.owner,
    doubts: [],
    confirmedBy: "second reader",
  };
}

export function saveReview() {
  fs.writeFileSync(QUEUE, JSON.stringify(queue));
  const keys = new Set(queue.map((q) => q.key));
  const orphaned = Object.keys(decisions).filter((k) => !keys.has(k));
  if (orphaned.length) console.log(`${orphaned.length} review decisions no longer match a row (the reader changed); kept, not applied`);
}
