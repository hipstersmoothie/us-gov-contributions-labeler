// Prototype: members' financial disclosures (House e-filed reports only).
// Values are always ranges; nothing here should ever print a single figure for
// a holding unless the filer reported one.
import fs from "node:fs";
import path from "node:path";
import { memberById, organizationById, congressCommitteeById, partyLetter, type Member } from "./data";
import { money, surname } from "./format";
import type { TradeRow } from "../islands/types";

export type Owner = "self" | "spouse" | "joint" | "child";
export const OWNER_LABEL: Record<Owner, string> = { self: "Member", spouse: "Spouse", joint: "Joint", child: "Dependent child" };

export const KINDS = {
  stock: "Individual stocks",
  options: "Options",
  bonds: "Corporate bonds",
  funds: "Mutual funds & ETFs",
  "private-funds": "Private funds",
  cash: "Cash & government debt",
  retirement: "Retirement & college accounts",
  insurance: "Insurance & annuities",
  business: "Real estate & businesses",
  crypto: "Crypto",
  trust: "Trusts",
  other: "Other",
} as const;
export type Kind = keyof typeof KINDS;
/** Holdings tied to one company: the only ones it's fair to put a company's name or sector on. */
export const COMPANY_KINDS: Kind[] = ["stock", "options", "bonds"];

interface Company {
  cik?: number;
  ticker?: string;
  company?: string;
  sector?: string;
  industry?: string;
  org?: string;
}
export interface Holding extends Company {
  name: string;
  kind: Kind;
  owner: Owner;
  min: number;
  max: number;
  open: boolean;
  exact?: boolean;
  text: string;
  account?: string;
  description?: string;
  scanned?: boolean;
  docUrl?: string;
}
export interface Trade extends Company {
  date: string;
  filed: string;
  lagDays: number;
  name: string;
  kind: Kind;
  owner: Owner;
  tx: string;
  min: number;
  max: number;
  open: boolean;
  text: string;
  status?: string;
  description?: string;
  comments?: string;
  /** The filer noted that an adviser or manager made the trade. */
  adviser?: boolean;
  /** Read by machine from a scanned paper form; docUrl points at the page. */
  scanned?: boolean;
  account?: string;
  docUrl: string;
}
export interface Disclosure {
  annual?: { year: number; filed: string; url: string; amended: boolean; paper: boolean };
  holdings: Holding[];
  trades: Trade[];
  ptrs: { filed: string; url: string; paper: boolean }[];
  /** Later amendments filed on paper, which the holdings here don't reflect. */
  paperAmendments?: { filed: string; url: string }[];
  /** Rows on scanned forms that couldn't be read reliably, so aren't shown. */
  scanUnread?: number;
  /** The annual report was filed on paper and read by machine. */
  annualScanned?: boolean;
  annualUnread?: number;
}

const file = path.resolve(process.cwd(), "src/data/holdings.json");
const raw = fs.existsSync(file)
  ? (JSON.parse(fs.readFileSync(file, "utf8")) as { generatedAt: string; members: Record<string, Disclosure> })
  : { generatedAt: "", members: {} };

export const disclosures = new Map(Object.entries(raw.members));
export const disclosuresAt = raw.generatedAt;

/** "$1,001–$15,000", "Over $50M", or the exact figure a filer chose to give. */
export function rangeText(r: { min: number; max: number; open: boolean; text: string }) {
  if (r.text === "None") return "None";
  if (/undetermined/i.test(r.text)) return "Undetermined";
  if (r.open) return `Over ${money(r.min - 1, true)}`;
  if (r.min === r.max) return money(r.min);
  return `${money(r.min, true)}–${money(r.max, true)}`;
}

export function sumRange<T extends { min: number; max: number; open: boolean }>(xs: T[]) {
  return xs.reduce((s, x) => ({ min: s.min + x.min, max: s.max + x.max, open: s.open || x.open }), { min: 0, max: 0, open: false });
}

export function byKind(holdings: Holding[]) {
  const rows = (Object.keys(KINDS) as Kind[])
    .map((k) => ({ kind: k, label: KINDS[k], items: holdings.filter((h) => h.kind === k) }))
    .filter((r) => r.items.length);
  return rows.map((r) => ({ ...r, ...sumRange(r.items) })).sort((a, b) => b.max - a.max);
}

export function bySector(holdings: Holding[]) {
  const company = holdings.filter((h) => COMPANY_KINDS.includes(h.kind));
  const groups = new Map<string, Holding[]>();
  for (const h of company) {
    const s = h.sector ?? "Not matched to a company";
    groups.set(s, [...(groups.get(s) ?? []), h]);
  }
  return [...groups].map(([sector, items]) => ({ sector, items, ...sumRange(items) })).sort((a, b) => b.max - a.max);
}

// --- committees -----------------------------------------------------------------

/**
 * Committees whose jurisdiction is one or a few industries. Appropriations,
 * Ways and Means, Finance, Budget, Rules, Oversight and Judiciary reach
 * every industry, so overlap with them would mean nothing.
 */
export const COMMITTEE_SECTORS: Record<string, string[]> = {
  HSAG: ["Agribusiness"],
  SSAF: ["Agribusiness"],
  HSAS: ["Defense"],
  SSAS: ["Defense"],
  HSBA: ["Finance, Insurance & Real Estate"],
  SSBK: ["Finance, Insurance & Real Estate"],
  HSIF: ["Energy & Natural Resources", "Health", "Communications & Technology"],
  HSII: ["Energy & Natural Resources"],
  SSEG: ["Energy & Natural Resources"],
  HSPW: ["Transportation", "Construction"],
  SSCM: ["Communications & Technology", "Transportation"],
  SSEV: ["Energy & Natural Resources", "Construction"],
  HSED: ["Education"],
  SSHR: ["Health", "Education"],
};

export function committeeSectors(m: Member) {
  const out = new Map<string, string[]>();
  for (const a of m.assignments) {
    const c = congressCommitteeById.get(a.id);
    const top = c?.parent ?? a.id;
    for (const s of COMMITTEE_SECTORS[top] ?? []) {
      const name = congressCommitteeById.get(top)?.name.replace(/^(House|Senate) Committee on (the )?/, "") ?? top;
      out.set(s, [...new Set([...(out.get(s) ?? []), name])]);
    }
  }
  return out;
}

/** Midpoints, for comparing shares only. Never displayed as a value. */
const mid = (x: { min: number; max: number }) => (x.min + x.max) / 2;

/**
 * Share of a member's individual-company holdings in the given sectors, next
 * to the same share for every House member's individual stocks pooled: the
 * market's own tilt (tech is a big slice of everyone's stocks).
 */
export function overlapShare(holdings: Holding[], sectors: string[]) {
  const company = holdings.filter((h) => COMPANY_KINDS.includes(h.kind) && h.sector);
  const total = company.reduce((s, h) => s + mid(h), 0);
  const inside = company.filter((h) => sectors.includes(h.sector!)).reduce((s, h) => s + mid(h), 0);
  return total ? inside / total : 0;
}

const pooled = [...disclosures.values()].flatMap((d) => d.holdings);
export function baselineShare(sectors: string[]) {
  return overlapShare(pooled, sectors);
}

// --- companies --------------------------------------------------------------------

export interface CompanyEntry {
  cik: number;
  name: string;
  ticker?: string;
  sector?: string;
  industry?: string;
  org?: string;
  holders: { member: Member; holdings: Holding[] }[];
  traders: { member: Member; trades: Trade[] }[];
}

export const companies = new Map<number, CompanyEntry>();
for (const [bioguide, d] of disclosures) {
  const member = memberById.get(bioguide);
  if (!member) continue;
  const add = (c: Company) => {
    if (!c.cik) return undefined;
    let e = companies.get(c.cik);
    if (!e) {
      e = { cik: c.cik, name: c.company ?? "", ticker: c.ticker, sector: c.sector, industry: c.industry, org: c.org, holders: [], traders: [] };
      companies.set(c.cik, e);
    }
    return e;
  };
  for (const h of d.holdings.filter((h) => COMPANY_KINDS.includes(h.kind))) {
    const e = add(h);
    if (!e) continue;
    const row = e.holders.find((x) => x.member === member) ?? e.holders[e.holders.push({ member, holdings: [] }) - 1]!;
    row.holdings.push(h);
  }
  for (const t of d.trades.filter((t) => COMPANY_KINDS.includes(t.kind) && t.date >= "2025-01-01")) {
    const e = add(t);
    if (!e) continue;
    const row = e.traders.find((x) => x.member === member) ?? e.traders[e.traders.push({ member, trades: [] }) - 1]!;
    row.trades.push(t);
  }
}

export const companyOrg = (c: CompanyEntry) => (c.org ? organizationById.get(c.org) : undefined);

/** "Apple Inc." from SEC's "APPLE INC." style names. */
export function companyName(name: string) {
  if (name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(Inc|Corp|Co|Ltd|Plc|Llc|Lp|Nv|Sa|Ag)\b\.?/g, (w) => (w.length <= 3 ? w.toUpperCase().replace("INC", "Inc").replace("CORP", "Corp").replace("LTD", "Ltd") : w))
    .replace(/\/[A-Za-z]{2}\/?$/, "");
}

// --- list rows -------------------------------------------------------------------

export function tradeRows(): TradeRow[] {
  const rows: TradeRow[] = [];
  for (const [bioguide, d] of disclosures) {
    const m = memberById.get(bioguide);
    if (!m) continue;
    d.trades.forEach((t, i) => {
      if (t.date < "2025-01-01") return;
      rows.push({
        id: `${bioguide}-${i}`,
        member: m.name,
        bioguide,
        sortName: surname(m.name),
        party: partyLetter(m.party) as TradeRow["party"],
        date: t.date,
        asset: t.company ? companyName(t.company) : t.name,
        company: COMPANY_KINDS.includes(t.kind),
        tx: t.tx,
        owner: t.owner === "self" ? "Member" : OWNER_LABEL[t.owner],
        amount: rangeText(t),
        scanned: !!t.scanned,
        min: t.min,
        lagDays: t.lagDays,
        docUrl: t.docUrl,
      });
    });
  }
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}
