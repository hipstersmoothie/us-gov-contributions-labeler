// Outside spending the committees' processed filings (pas2) don't carry yet,
// or at all:
//
//   24- and 48-hour notices   Independent expenditures a committee made after
//                             its last processed periodic report. Before an
//                             election that's weeks of the heaviest spending.
//   Form 5                    Independent expenditures by groups and people
//                             that aren't political committees: 501(c)(4)s,
//                             unions, trade groups, individuals.
//   Form 9                    Electioneering communications: broadcast ads
//                             that name a candidate shortly before an
//                             election without saying vote for or against.
//
// The same expenditure can show up in a 24/48-hour notice, again in the
// periodic report that covers its date, and again in any amendment. Each
// source below is deduplicated so it's counted once.
// https://www.fec.gov/data/browse-data/?tab=bulk-data
import fs from "fs";
import path from "path";
import { getJson } from "../lib/http.js";
import { fecBulk } from "../lib/download.js";
import { currentCycle, isFresh } from "../lib/cycles.js";

const CACHE_DIR = ".cache/fec";
const FEC_API = "https://api.open.fec.gov/v1";
const API = { intervalMs: 1100, maxWaitMs: 300_000 };
const apiKey = () => process.env.FEC_API_KEY ?? "DEMO_KEY";

/** One line naming a candidate, from any of the sources. */
export interface IeRow {
  committee: string;
  candidate: string;
  side: "support" | "oppose";
  amount: number;
  /** P primary, G general, R runoff, S special, C convention. */
  election: string;
  /** YYYY-MM-DD: when it was paid for or first shown. */
  date: string;
  /** When the filer left out the candidate id: who they named, to look up. */
  named?: { last: string; office: string; state: string; district: number };
}

/** "Evans, Gabe" or "EVANS" -> "EVANS". */
const lastName = (name: string) => name.split(",")[0]!.trim().toUpperCase();

/** RFC 4180 CSV: quoted fields may hold commas, quotes ("") and newlines. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") row.push(field), (field = "");
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  const [header, ...body] = rows;
  const keys = (header ?? []).map((h) => h.replace(/^﻿/, "").trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

async function bulkCsv(cycle: number, name: string) {
  return parseCsv(fs.readFileSync(await fecBulk(cycle, `${name}_${cycle}.csv`), "latin1"));
}

const MONTHS: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
/** "05-NOV-24", "20261014", "2024-11-05T00:00:00" or "11/05/2024" -> "2024-11-05". */
export function isoDate(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  let m = /^(\d{2})-([A-Z]{3})-(\d{2})$/.exec(raw);
  if (m && MONTHS[m[2]!]) return `20${m[3]}-${MONTHS[m[2]!]}-${m[1]}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  return undefined;
}

/**
 * Lines listed more than once across filings (a notice, then the periodic
 * report, then an amendment) count once. Within a single filing, identical
 * lines are separate purchases, so a line counts as many times as the filing
 * that lists it most often does.
 */
function dedupe<T>(rows: T[], key: (r: T) => string, filing: (r: T) => string) {
  const counts = new Map<string, { row: T; byFiling: Map<string, number> }>();
  for (const r of rows) {
    const k = key(r);
    let entry = counts.get(k);
    if (!entry) counts.set(k, (entry = { row: r, byFiling: new Map() }));
    const f = filing(r);
    entry.byFiling.set(f, (entry.byFiling.get(f) ?? 0) + 1);
  }
  return [...counts.values()].flatMap(({ row, byFiling }) => Array<T>(Math.max(...byFiling.values())).fill(row));
}

// --- committee summaries ------------------------------------------------------------

export interface CommitteeSummary {
  itemized: number;
  unitemized: number;
}

/** Each committee's individual contributions for the cycle, as processed from its periodic reports. */
export async function committeeSummaries(cycle: number) {
  const out = new Map<string, CommitteeSummary>();
  for (const r of await bulkCsv(cycle, "committee_summary")) {
    if (!r.CMTE_ID) continue;
    out.set(r.CMTE_ID, {
      itemized: Number(r.INDV_ITEM_CONTB) || 0,
      unitemized: Number(r.INDV_UNITEM_CONTB) || 0,
    });
  }
  return out;
}

// --- 24- and 48-hour notices ------------------------------------------------------

/** No single line in a real notice comes near this; prank filings claim billions. */
const IMPLAUSIBLE = 50_000_000;

/**
 * Committees' independent expenditures from 24/48-hour notices, keeping only
 * those dated after the latest one pas2 has for the committee. Form 5 filers
 * are handled in form5.
 */
export async function lateNotices(cycle: number, coverageEnd: (committee: string) => string | undefined, registered: (committee: string) => boolean) {
  const raw = await bulkCsv(cycle, "independent_expenditure");
  // An amendment replaces the whole filing it amends.
  const superseded = new Set(raw.map((r) => r.prev_file_num).filter(Boolean));
  const rows = raw.filter((r) => r.spe_id?.startsWith("C0") && !superseded.has(r.file_num!) && (r.sup_opp === "S" || r.sup_opp === "O"));
  const unique = dedupe(
    rows,
    (r) => [r.spe_id, r.cand_id || r.cand_name, r.sup_opp, r.exp_amo, r.exp_date || r.dissem_dt].join("|"),
    (r) => r.file_num!
  );
  const out: IeRow[] = [];
  let skipped = 0;
  for (const r of unique) {
    const amount = Number(r.exp_amo) || 0;
    const date = isoDate(r.dissem_dt) ?? isoDate(r.exp_date);
    if (!date || !amount) continue;
    const named = r.cand_id ? undefined : r.cand_name && r.can_office ? { last: lastName(r.cand_name), office: r.can_office, state: r.can_office_state ?? "", district: Number(r.can_office_dis) || 0 } : undefined;
    if (!r.cand_id && !named) continue;
    if (Math.abs(amount) >= IMPLAUSIBLE || !registered(r.spe_id!)) {
      skipped++;
      continue;
    }
    const covered = coverageEnd(r.spe_id!);
    if (covered && date <= covered) continue;
    // A finished cycle's real spenders have all filed periodic reports; a
    // committee with notices and nothing processed is a prank or never
    // followed through.
    if (!covered && cycle < currentCycle()) {
      skipped++;
      continue;
    }
    out.push({ committee: r.spe_id!, candidate: r.cand_id ?? "", side: r.sup_opp === "S" ? "support" : "oppose", amount, election: (r.ele_type ?? "")[0] ?? "", date, named });
  }
  if (skipped) console.log(`  skipped ${skipped} implausible or unregistered notice lines`);
  return out;
}

// --- Form 5: groups and people that aren't political committees ------------------

type Page<T> = { results: T[]; pagination: { page?: number; pages: number; count: number; last_indexes?: Record<string, string> | null } };

/**
 * Every page of an FEC API listing (keyset or numbered pages). The API key
 * allows few calls an hour, so only short listings go through the API; the
 * itemized lines come from the raw filings on docquery, which don't count.
 * Numbered pages need a unique sort: on a tied one, rows shift between pages
 * and come back twice or not at all.
 */
export async function* pages<T>(endpoint: string, params: Record<string, string>) {
  let last: Record<string, string> = {};
  for (let page = 1; ; page++) {
    const qs = new URLSearchParams({ ...params, ...last, page: String(page), per_page: "100", api_key: apiKey() });
    const res = await getJson<Page<T>>(`${FEC_API}/${endpoint}?${qs}`, API);
    if (!res?.results.length) return;
    yield* res.results;
    if (res.pagination.last_indexes) last = res.pagination.last_indexes;
    else if (page >= res.pagination.pages) return;
  }
}

export async function cachedJson<T>(cycle: number, name: string, fetcher: () => Promise<T>): Promise<T> {
  const file = path.join(CACHE_DIR, String(cycle), `${name}.json`);
  if (fs.existsSync(file) && isFresh(fs.statSync(file).mtime, cycle, 7)) return JSON.parse(fs.readFileSync(file, "utf8"));
  const value = await fetcher();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
  return value;
}

/** A raw electronic filing's records, split on the FEC's field separator. */
export async function rawFiling(fileNumber: number | string): Promise<string[][]> {
  const file = path.join(CACHE_DIR, "filings", `${fileNumber}.fec`);
  if (!fs.existsSync(file)) {
    const res = await fetch(`https://docquery.fec.gov/dcdev/posted/${fileNumber}.fec`);
    if (!res.ok) throw new Error(`docquery ${res.status} for filing ${fileNumber}`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  const text = fs.readFileSync(file, "latin1");
  // Version 6+ filings separate fields with ASCII 28; older ones are CSV.
  if (text.includes("\x1c")) return text.split(/\r?\n/).filter(Boolean).map((l) => l.split("\x1c").map((f) => f.trim()));
  return text.split(/\r?\n/).filter(Boolean).map((l) => parseCsv(`x\n${l}`).map((r) => Object.values(r))[0] ?? []);
}

/** A Form 5 periodic report, as the API lists it. */
interface Form5Report {
  committee_id: string;
  report_type: string;
  report_year: number;
  coverage_end_date: string | null;
  fec_url: string | null;
  independent_contributions_period: number | null;
  independent_expenditures_period: number | null;
}
const fileNumberOf = (url: string | null) => url && /\/(\d+)\.fec$/.exec(url)?.[1];

export interface Form5 {
  rows: IeRow[];
  /** filer -> what its periodic reports list as received to fund the spending. */
  contributions: Map<string, number>;
  /** Filers who report as an individual rather than an organization. */
  people: Set<string>;
}

/**
 * Form 5 independent expenditures. The periodic reports (quarterly, year-end)
 * are the record; a 24/48-hour notice counts only if it's dated after the
 * last day the filer's latest periodic report covers, until that report is
 * filed. Notices come from the bulk file, deduplicated like committees' ones.
 */
export async function form5(cycle: number): Promise<Form5> {
  // Only reports that haven't since been amended: the latest version of each.
  const reports = await cachedJson(cycle, "form5-reports", async () => {
    const out: Form5Report[] = [];
    for await (const r of pages<Form5Report>("reports/ie-only/", { cycle: String(cycle), is_amended: "false", sort: "beginning_image_number" })) out.push(r);
    return out;
  });
  const contributions = new Map<string, number>();
  const people = new Set<string>();
  const coveredThrough = new Map<string, string>();
  const rows: IeRow[] = [];
  let unreadable = 0;
  let missing = 0;
  // Each filing once, even if a listing repeats it.
  const seenFiles = new Set<string>();
  for (const report of reports) {
    const fileNumber = fileNumberOf(report.fec_url);
    if (fileNumber && seenFiles.has(fileNumber)) continue;
    if (fileNumber) seenFiles.add(fileNumber);
    contributions.set(report.committee_id, (contributions.get(report.committee_id) ?? 0) + (report.independent_contributions_period ?? 0));
    if (!fileNumber || !report.independent_expenditures_period) continue;
    // Paper filings have no electronic version; notices fill in for them.
    const records = await rawFiling(fileNumber).catch(() => undefined);
    if (!records) {
      missing++;
      continue;
    }
    // Header F5N/F5A: 2 entity type, 3 organization name, 4-5 last and first
    // name. Some groups file as "IND" with their name in the last-name field.
    const header = records.find((f) => /^F5[NA]$/.test(f[0] ?? ""));
    const [, , entity, org = "", last = "", first = ""] = header ?? [];
    if (entity === "IND" && !org && /^[A-Za-z][A-Za-z.' -]+$/.test(first) && !/\b(INC|LLC|CORP|FUND|ACTION|COMMITTEE|ASSOCIATION|ALLIANCE|PAC|UNION|COUNCIL|PROJECT|NETWORK|FOUNDATION)\b/i.test(`${last} ${first}`)) {
      people.add(report.committee_id);
    }
    const end = isoDate(report.coverage_end_date);
    if (end && end > (coveredThrough.get(report.committee_id) ?? "")) coveredThrough.set(report.committee_id, end);
    for (const f of records.filter((f) => f[0] === "F57")) {
      // F57: 15 election code ("G2024"), 17 date, 18 amount (negative for a
      // correction), 23 S/O, 24 candidate id, 25 last name, 30-32 office,
      // state, district.
      const amount = Number(f[18]) || 0;
      const date = isoDate(f[17]);
      const so = f[23];
      const candidate = /^[HSP][0-9A-Z]{8}$/.test(f[24] ?? "") ? f[24]! : "";
      const named = candidate || !f[25] || !f[30] ? undefined : { last: lastName(f[25]), office: f[30], state: f[31] ?? "", district: Number(f[32]) || 0 };
      if (!date || !amount || (so !== "S" && so !== "O") || (!candidate && !named)) {
        unreadable++;
        continue;
      }
      if (Math.abs(amount) >= IMPLAUSIBLE) continue;
      rows.push({ committee: report.committee_id, candidate, side: so === "S" ? "support" : "oppose", amount, election: (f[15] ?? "")[0] ?? "", date, named });
    }
  }

  const raw = await bulkCsv(cycle, "independent_expenditure");
  const superseded = new Set(raw.map((r) => r.prev_file_num).filter(Boolean));
  const notices = dedupe(
    raw.filter((r) => r.spe_id?.startsWith("C9") && !superseded.has(r.file_num!) && (r.sup_opp === "S" || r.sup_opp === "O")),
    (r) => [r.spe_id, r.cand_id || r.cand_name, r.sup_opp, r.exp_amo, r.exp_date || r.dissem_dt].join("|"),
    (r) => r.file_num!
  );
  let pending = 0;
  for (const r of notices) {
    const amount = Number(r.exp_amo) || 0;
    const date = isoDate(r.exp_date) ?? isoDate(r.dissem_dt);
    const named = r.cand_id ? undefined : r.cand_name && r.can_office ? { last: lastName(r.cand_name), office: r.can_office, state: r.can_office_state ?? "", district: Number(r.can_office_dis) || 0 } : undefined;
    if ((!r.cand_id && !named) || !date || !amount || Math.abs(amount) >= IMPLAUSIBLE) continue;
    if (date <= (coveredThrough.get(r.spe_id!) ?? "")) continue;
    rows.push({ committee: r.spe_id!, candidate: r.cand_id ?? "", side: r.sup_opp === "S" ? "support" : "oppose", amount, election: (r.ele_type ?? "")[0] ?? "", date, named });
    pending += amount;
  }
  const total = rows.reduce((s, r) => s + r.amount, 0);
  console.log(
    `  Form 5 ${cycle}: ${reports.length} periodic reports, $${Math.round(total).toLocaleString()} ` +
      `($${Math.round(pending).toLocaleString()} from notices not yet in a periodic report)` +
      (unreadable ? `; ${unreadable} unreadable lines` : "") +
      (missing ? `; ${missing} reports with no electronic filing` : "")
  );
  return { rows, contributions, people };
}

// --- Form 9: electioneering communications ------------------------------------------

export interface EcRow {
  committee: string;
  candidate: string;
  /** The candidate's share of the ad's cost, as the FEC calculates it. */
  amount: number;
  date: string;
}

export async function electioneering(cycle: number) {
  const raw = await bulkCsv(cycle, "ElectioneeringComm");
  const unique = new Map<string, EcRow>();
  for (const r of raw) {
    const amount = Number(r.CALCULATED_CANDIDATE_SHARE) || 0;
    const date = isoDate(r.PUBLIC_DISBURSEMENT_DATE) ?? isoDate(r.COMMUNICATION_DATE) ?? isoDate(r.DISBURSEMENT_DATE);
    if (!r.CANDIDATE_ID || !r.COMMITTEE_ID || amount <= 0 || !date) continue;
    // The file repeats a disbursement when a filing is resubmitted.
    unique.set([r.COMMITTEE_ID, r.CANDIDATE_ID, r.SB_IMAGE_NUM, r.REPORTED_DISBURSEMENT_AMOUNT, amount].join("|"), {
      committee: r.COMMITTEE_ID,
      candidate: r.CANDIDATE_ID,
      amount,
      date,
    });
  }
  return [...unique.values()];
}

// --- Form 9 donations -----------------------------------------------------------------

/**
 * What each Form 9 filer's reports list as donations received to pay for its
 * electioneering communications, over the cycle. Zero means its filings name
 * no donors.
 */
export async function form9Donations(cycle: number) {
  const filings = await cachedJson(cycle, "form9-filings", async () => {
    const out: { committee_id: string; file_number: number; total_receipts: number | null; most_recent: boolean | null; is_amended: boolean | null }[] = [];
    for await (const r of pages<(typeof out)[number] & { file_number: number }>("filings/", { cycle: String(cycle), form_type: "F9", sort: "beginning_image_number" })) {
      out.push({ committee_id: r.committee_id, file_number: r.file_number, total_receipts: r.total_receipts, most_recent: r.most_recent, is_amended: r.is_amended });
    }
    return out;
  });
  const out = new Map<string, number>();
  const seen = new Set<number>();
  for (const f of filings) {
    if (f.is_amended || f.most_recent === false || seen.has(f.file_number)) continue;
    seen.add(f.file_number);
    out.set(f.committee_id, (out.get(f.committee_id) ?? 0) + (f.total_receipts ?? 0));
  }
  return out;
}
