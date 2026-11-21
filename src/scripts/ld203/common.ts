// Shared types and helpers for the LD-203 study (design/ld203/README.md).
import fs from "fs";
import path from "path";

export const CACHE = ".cache/ld203/api";
export const LDA_API = "https://lda.gov/api/v1";
export const USER_AGENT = "contributions.fyi research (https://contributions.fyi)";
/** The item types that aren't FECA contributions (those are already in FEC data). */
export const TYPES = ["he", "me", "ple", "pic"] as const;
export type ItemType = "feca" | (typeof TYPES)[number];
export const TYPE_NAMES: Record<ItemType, string> = {
  feca: "FECA contributions",
  he: "Honorary expenses",
  me: "Meeting expenses",
  ple: "Presidential library",
  pic: "Presidential inaugural committee",
};

export interface ContributionItem {
  contribution_type: ItemType;
  contribution_type_display: string;
  contributor_name: string | null;
  payee_name: string | null;
  honoree_name: string | null;
  amount: string | null;
  date: string | null;
}
export interface ContributionReport {
  filing_uuid: string;
  filing_type: "MM" | "MA" | "YY" | "YA";
  filing_year: number;
  filing_period: "mid_year" | "year_end";
  filing_document_url: string;
  filer_type: "lobbyist" | "organization";
  dt_posted: string;
  comments: string | null;
  registrant: { id: number; name: string; house_registrant_id: number | null; description: string | null };
  lobbyist: { id: number; first_name: string; last_name: string } | null;
  no_contributions: boolean;
  pacs: string[];
  contribution_items: ContributionItem[];
}
export interface Page {
  count: number;
  next: string | null;
  results: ContributionReport[];
}

/** Every cached filing, once each (a filing with both honorary and meeting
 *  items is in both pulls). */
export function loadFilings(): Map<string, ContributionReport> {
  const filings = new Map<string, ContributionReport>();
  for (const f of fs.readdirSync(CACHE)) {
    if (!/^\d{4}_(he|me|ple|pic)_p\d+\.json$/.test(f)) continue;
    const page: Page = JSON.parse(fs.readFileSync(path.join(CACHE, f), "utf8"));
    for (const r of page.results) filings.set(r.filing_uuid, r);
  }
  return filings;
}

/** The filer and period a report covers: an amendment (MA/YA) replaces the
 *  original (MM/YY) with the same key, so keep the latest posted. */
export function filerPeriodKey(r: ContributionReport) {
  return `${r.registrant.id}|${r.lobbyist?.id ?? ""}|${r.filing_year}|${r.filing_period}`;
}
export function dedupeAmendments(filings: Iterable<ContributionReport>) {
  const latest = new Map<string, ContributionReport>();
  let superseded = 0;
  for (const r of filings) {
    const key = filerPeriodKey(r);
    const prev = latest.get(key);
    if (!prev) latest.set(key, r);
    else {
      superseded++;
      if (prev.dt_posted < r.dt_posted) latest.set(key, r);
    }
  }
  return { latest, superseded };
}

export const money = (n: number) =>
  n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${Math.round(n / 1e3).toLocaleString()}K` : `$${Math.round(n)}`;
export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
