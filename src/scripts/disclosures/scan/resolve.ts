// Combine our reading of a scanned row with the second reader's
// (scan/second-reader.ts). Two independent readers that agree confirm a row;
// a row we flagged is filled in only where the second reader supplies what we
// couldn't read and agrees with everything we could. Any disagreement goes to
// .cache/disclosures/scan/review.json for a person, not to the site.
import fs from "fs";
import { CACHE } from "../common.js";
import { VALUES, type ScannedHolding } from "./annual.js";
import { AMOUNTS, isoDate, type ScannedTrade } from "./ptr.js";

const DIR = `${CACHE}/scan/second-reader`;
type Owner = ScannedTrade["owner"];

interface PtrReading { n: number; owner: string; transaction: string; trade_date: string; notified_date: string; amount_column: string }
interface AnnualReading { n: number; asset: string; owner: string; value_column: string }
interface Job { id: string; names: string[] }

const readings: Record<string, { rows: (PtrReading | AnnualReading)[] }> = fs.existsSync(`${DIR}/readings.json`)
  ? JSON.parse(fs.readFileSync(`${DIR}/readings.json`, "utf8"))
  : {};
const jobs = new Map<string, Job>(
  fs.existsSync(`${DIR}/jobs.json`) ? (JSON.parse(fs.readFileSync(`${DIR}/jobs.json`, "utf8")) as Job[]).map((j) => [j.id, j]) : []
);

const OWNERS: Record<string, Owner | undefined> = { SP: "spouse", DC: "child", JT: "joint", blank: "self" };
const TX: Record<string, string | undefined> = { purchase: "Bought", sale: "Sold", partial_sale: "Sold some", exchange: "Exchanged" };
const column = (c: string, table: [number, number | null][]) => (/^[A-M]$/.test(c) ? table[c.charCodeAt(0) - 65] : undefined);

export const stats = { confirmed: 0, filled: 0, disagreed: 0, unreadBoth: 0, noReading: 0 };
const review: unknown[] = [];

/** A row's name without owner tags, which later parses may move out of it. */
const sameRow = (a: string, b: string) => {
  const norm = (s: string) => s.replace(/\b(?:[S5$]P|D[CO0]|J[T1])\b/g, "").replace(/\s+/g, "");
  return norm(a) === norm(b);
};

/** The second reader's row for the i-th row we read on a page, if the page was read and still lines up. */
function readingFor<T>(id: string, index: number, name: string): T | undefined {
  const job = jobs.get(id);
  // Our parse has to be the one the second reader was shown.
  if (!job || !sameRow(job.names[index] ?? "", name || "(no name read)")) return undefined;
  return readings[id]?.rows.find((r) => r.n === index + 1) as T | undefined;
}

/**
 * Resolve one machine-read trade. Returns the trade to show (doubts cleared and
 * `confirmedBy` set), or undefined to leave it out.
 */
export function resolveTrade(docId: string, t: ScannedTrade, index: number): (ScannedTrade & { confirmedBy?: string }) | undefined {
  const r = readingFor<PtrReading>(`p-${docId}-${t.page}`, index, t.asset);
  if (!r) {
    stats.noReading++;
    return t.doubts.length ? undefined : t;
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
  ].filter(Boolean);
  if (conflicts.length) {
    stats.disagreed++;
    review.push({ kind: "trade", docId, page: t.page, row: index + 1, asset: t.asset, ours: t, theirs: r, conflicts });
    return undefined;
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
    return undefined;
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

/** Resolve one machine-read Schedule A row the same way. */
export function resolveHolding(docId: string, h: ScannedHolding, index: number): (ScannedHolding & { confirmedBy?: string }) | undefined {
  const r = readingFor<AnnualReading>(`a-${docId}-${h.page}`, index, h.asset);
  if (!r) {
    stats.noReading++;
    return h.doubts.length ? undefined : h;
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
  ].filter(Boolean);
  if (conflicts.length) {
    stats.disagreed++;
    review.push({ kind: "holding", docId, page: h.page, row: index + 1, asset: h.asset, ours: h, theirs: r, conflicts });
    return undefined;
  }
  if (!h.doubts.length) {
    stats.confirmed++;
    return { ...h, confirmedBy: "second reader" };
  }
  if ((doubted.value && !range) || (doubted.owner && !owner) || (doubted.name && !r.asset.trim())) {
    stats.unreadBoth++;
    return undefined;
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

export const hasReadings = () => Object.keys(readings).length > 0;

export function saveReview() {
  fs.writeFileSync(`${CACHE}/scan/review.json`, JSON.stringify(review, null, 1));
}
