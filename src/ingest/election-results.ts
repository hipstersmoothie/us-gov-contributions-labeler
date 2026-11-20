// The FEC's own election compilations, both "compiled from state election
// offices", both free and in the same layout every cycle:
//
//   <year>congressgecands.xlsx   who is on each state's general-election
//                                ballot, with FEC candidate ids. Published
//                                around the election.
//   federalelections<year>.xlsx  official results: votes, percentages and a
//                                winner flag for every candidate. Published
//                                about a year after the election.
//
// Neither link is predictable (they live under /documents/<n>/), so they're
// found on the FEC's election results page, and cached in .cache/fec/<year>/.
// When a file isn't published yet, the step goes on without it.
import fs from "fs";
import path from "path";
import { USER_AGENT, cachedDownload } from "../lib/download.js";
import { readXlsx } from "../lib/xlsx.js";

const PAGE = "https://www.fec.gov/introduction-campaign-finance/election-results-and-voting-information/";

async function linksOn(url: string) {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } }).catch(() => undefined);
  if (!res?.ok) return [];
  return [...(await res.text()).matchAll(/href="([^"]+)"/g)].map((m) => new URL(m[1]!, url).href);
}

/** The FEC's ballot and results spreadsheets for an election year, where published, downloaded. */
export async function fecElectionFiles(year: number) {
  const links = [...(await linksOn(PAGE)), ...(await linksOn(`${PAGE}federal-elections-${year}/`))];
  const find = (re: RegExp) => links.find((l) => re.test(l));
  const get = async (re: RegExp, name: string) => {
    const url = find(re);
    const dest = path.join(".cache/fec", String(year), name);
    if (!url) return fs.existsSync(dest) ? dest : undefined;
    return cachedDownload(url, dest, 7).catch((e: Error) => {
      console.warn(`  couldn't download ${url}: ${e.message}`);
      return fs.existsSync(dest) ? dest : undefined;
    });
  };
  return {
    ballot: await get(new RegExp(`${year}congressgecands\\.xlsx$`, "i"), "congressgecands.xlsx"),
    results: await get(new RegExp(`federalelections${year}\\.xlsx$`, "i"), "federalelections.xlsx"),
  };
}

/** "S", "S-Unexpired Term", "01", "00", "08-Unexpired Term" -> office, district, special. */
function seat(district: string) {
  const special = /unexpired|special/i.test(district);
  if (/^S\b/i.test(district)) return { office: "S" as const, district: undefined, special };
  const n = /^(\d+)/.exec(district)?.[1];
  return n === undefined ? undefined : { office: "H" as const, district: Number(n), special };
}
const ids = (cell: string) => cell.split(/[,;\s]+/).filter((x) => /^[HS][0-9A-Z]{8}$/.test(x));

/** Rows of every sheet whose header row has these columns, as records keyed by header. */
function records(file: string, must: string[]) {
  const out: Record<string, string>[] = [];
  for (const [, rows] of readXlsx(file)) {
    const h = rows.findIndex((r) => must.every((m) => r.some((c) => c.toUpperCase().startsWith(m))));
    if (h < 0) continue;
    const header = rows[h]!.map((c) => c.toUpperCase());
    for (const r of rows.slice(h + 1)) out.push(Object.fromEntries(header.map((k, i) => [k, r[i] ?? ""])));
  }
  return out;
}
/** A column by its exact header, else the first header starting with it. */
const col = (r: Record<string, string>, prefix: string) => r[prefix] ?? r[Object.keys(r).find((k) => k.startsWith(prefix)) ?? ""] ?? "";

export interface BallotLine {
  state: string;
  office: "H" | "S";
  district?: number;
  /** For the rest of a term (a special on the same ballot). */
  special: boolean;
  /** Usually one; the FEC lists two when a candidate has two records, none for a few. */
  fecIds: string[];
  incumbent: boolean;
  /** "Holmes, Tom" */
  name: string;
  /** As on the ballot: "DEM", "DEM/WF". */
  party: string;
}

/** The general-election ballot, every state. */
export function parseBallot(file: string): BallotLine[] {
  return records(file, ["STATE ABBREVIATION", "DISTRICT", "FEC ID", "PARTY"]).flatMap((r) => {
    const state = col(r, "STATE ABBREVIATION");
    const s = seat(col(r, "DISTRICT"));
    const name = col(r, "CANDIDATE NAME") || `${col(r, "CANDIDATE NAME (LAST)")}, ${col(r, "CANDIDATE NAME (FIRST)")}`;
    if (!/^[A-Z]{2}$/.test(state) || !s || !name.replace(/[, ]/g, "")) return [];
    return [{ state, ...s, fecIds: ids(col(r, "FEC ID")), incumbent: /\(I\)/.test(col(r, "(I)")), name, party: col(r, "PARTY") }];
  });
}

export interface ResultLine extends BallotLine {
  votes?: number;
  /** 0..1 */
  pct?: number;
  /** Votes in a general-election runoff (Georgia, Louisiana), where there was one. */
  runoffVotes?: number;
  /** The FEC's general-election winner flag. */
  winner: boolean;
  /** Fusion states (NY, CT, SC): the candidate's total across party lines, on their "Combined Parties" row. */
  combined?: { votes?: number; pct?: number };
}

/** Some years store 0.52, some 52.0%. */
const toShare = (n: number | undefined) => (n === undefined ? undefined : n > 1 ? n / 100 : n);
const num = (s: string) => (s && /^[\d.,]+%?$/.test(s) ? Number(s.replace(/[,%]/g, "")) : undefined);

/** Official results for Senate and House (and delegates), every state. */
export function parseResults(file: string): ResultLine[] {
  return records(file, ["STATE ABBREVIATION", "DISTRICT", "FEC ID", "GENERAL VOTES", "GE WINNER INDICATOR"]).flatMap((r) => {
    const state = col(r, "STATE ABBREVIATION");
    const s = seat(col(r, "DISTRICT"));
    const name = col(r, "CANDIDATE NAME");
    if (!/^[A-Z]{2}$/.test(state) || !s || !name || /^(total|scatter\w*|blank|void|over|under|write-in)s?\b/i.test(name)) return [];
    const pct = num(col(r, "GENERAL %"));
    return [{
      state,
      ...s,
      fecIds: ids(col(r, "FEC ID")),
      incumbent: /\(I\)/.test(col(r, "(I)")),
      name,
      party: col(r, "PARTY"),
      votes: num(col(r, "GENERAL VOTES")),
      // Some years store 0.52, some 52.0%.
      pct: toShare(pct),
      runoffVotes: num(col(r, "GE RUNOFF ELECTION VOTES")),
      winner: /^W/i.test(col(r, "GE WINNER INDICATOR")),
      combined: /combined/i.test(col(r, "PARTY")) ? { votes: num(col(r, "COMBINED GE PARTY TOTALS")), pct: toShare(num(col(r, "COMBINED GE PARTY %"))) } : undefined,
    }];
  });
}

/** One line per candidate: votes across party lines added up, the winner flag kept. */
export function byCandidate(lines: ResultLine[]) {
  const out = new Map<string, { votes?: number; pct?: number; runoffVotes?: number; winner: boolean; line: ResultLine }>();
  for (const l of lines) {
    for (const id of l.fecIds) {
      const prev = out.get(id) ?? { winner: false, line: l };
      prev.winner ||= l.winner;
      if (l.combined) {
        prev.votes = l.combined.votes ?? prev.votes;
        prev.pct = l.combined.pct ?? prev.pct;
        (prev as { fused?: boolean }).fused = true;
      } else if (!(prev as { fused?: boolean }).fused) {
        if (l.votes !== undefined) prev.votes = (prev.votes ?? 0) + l.votes;
        if (l.pct !== undefined) prev.pct = (prev.pct ?? 0) + l.pct;
      }
      if (l.runoffVotes !== undefined) prev.runoffVotes = l.runoffVotes;
      out.set(id, prev);
    }
  }
  return out;
}
