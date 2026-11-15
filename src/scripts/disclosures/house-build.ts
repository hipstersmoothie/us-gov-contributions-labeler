// Shape the parsed House filings into the prototype's data file,
// site/src/data/holdings.json. Prototype only: this file is not part of the
// CC0 open data and publish-records.ts never reads it (see
// design/holdings/README.md for why it can't simply be added).
//
//   tsx src/scripts/disclosures/house-build.ts
import "dotenv/config";
import fs from "fs";
import { CACHE } from "./common.js";
import type { HouseFiling } from "./house-index.js";
import type { Range } from "./house-parse.js";
import type { Parsed } from "./house-all.js";
import { matchAsset, type Match } from "./match.js";

/** What a reader needs to tell apart: one company's stock, a fund, cash, property... */
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

const KIND_BY_CODE: Record<string, Kind> = {
  ST: "stock", RS: "stock", OP: "options", SA: "options", CS: "bonds",
  MF: "funds", EF: "funds", ET: "funds", "5F": "funds", RE: "funds", IC: "funds",
  HE: "private-funds", HN: "private-funds", RF: "private-funds", RN: "private-funds",
  BA: "cash", IH: "cash", GS: "cash", FE: "cash",
  "4K": "retirement", IR: "retirement", "5C": "retirement", "5P": "retirement", DB: "retirement", PE: "retirement",
  VA: "insurance", VI: "insurance", WU: "insurance", FN: "insurance",
  RP: "business", FA: "business", OL: "business", OI: "business", PS: "business", DS: "business", MO: "business",
  CT: "crypto", EQ: "trust", TR: "trust",
};
/**
 * Filers' own type codes, corrected by name where they put a fund or an index
 * product under "stock" or "bonds": SPY coded ST, or a buffered S&P 500
 * annuity coded CS. Neither is one company's stock.
 */
const FUND_NAME = /\b(ETF|SPDR|iShares|Vanguard|Invesco QQQ|Mutual Fund|Index Fund|Select Sector)\b/i;
const INDEX_PRODUCT = /\b(annuity|RILA|buffer(ed)? note|barrier note|structured (note|lending)|auto ?callable|S&P 500|NDX|RTY|INDU|index[- ]linked|market[- ]linked)\b/i;
function kindOf(type: string | undefined, name: string): Kind {
  const kind = (type && KIND_BY_CODE[type]) || "other";
  if (kind === "stock" || kind === "bonds" || kind === "options") {
    if (INDEX_PRODUCT.test(name)) return /annuity|RILA/i.test(name) ? "insurance" : "other";
    if (FUND_NAME.test(name)) return "funds";
  }
  return kind;
}

/** A filer's note that someone else made the trade. */
const ADVISER = /\b(advis[eo]r|discretionary|managed account|no role in|not informed|without (my|the member's) (knowledge|input)|blind trust)\b/i;

const TX: Record<string, string> = { P: "Bought", S: "Sold", "S (partial)": "Sold some", E: "Exchanged" };

const pdfUrl = (f: HouseFiling) =>
  `https://disclosures-clerk.house.gov/public_disc/${f.type === "P" ? "ptr-pdfs" : "financial-pdfs"}/${f.year}/${f.docId}.pdf`;
const iso = (us: string) => us.replace(/^(\d\d)\/(\d\d)\/(\d{4})$/, "$3-$1-$2");
const clean = (asset: string) => asset.replace(/\s*\[[A-Z0-9]{2}\]\s*$/, "").trim();

function bounds(r?: Range) {
  if (!r) return { min: 0, max: 0, open: false, text: "Not given" };
  return { min: r.min, max: r.max ?? r.min, open: r.max === null && r.min > 0, text: r.text, ...(r.exact ? { exact: true } : {}) };
}

function company(m?: Match) {
  return m ? { cik: m.cik, ticker: m.ticker, company: m.company, sector: m.sector, industry: m.industry, org: m.org } : {};
}

const parsed = JSON.parse(fs.readFileSync(`${CACHE}/house/${process.argv[2] ?? "all"}.json`, "utf8")) as Parsed[];

const byMember = new Map<string, Parsed[]>();
for (const p of parsed) byMember.set(p.filing.bioguide!, [...(byMember.get(p.filing.bioguide!) ?? []), p]);

const members: Record<string, unknown> = {};
for (const [bioguide, filings] of byMember) {
  // The latest e-filed annual or amendment for 2025 replaces the original.
  const annuals = filings.filter((p) => p.filing.type !== "P").sort((a, b) => a.filing.filed.localeCompare(b.filing.filed));
  const annual = annuals.at(-1);
  const holdings = [];
  for (const h of annual?.holdings ?? []) {
    const kind = kindOf(h.type, h.asset);
    const m = ["stock", "options", "bonds"].includes(kind) ? await matchAsset(h.asset, h.ticker) : undefined;
    holdings.push({
      name: clean(h.asset),
      kind,
      owner: h.owner,
      ...bounds(h.value),
      ...(h.subholdingOf ? { account: h.subholdingOf } : {}),
      ...(h.description ? { description: h.description } : {}),
      ...(h.comments ? { comments: h.comments } : {}),
      ...company(m),
    });
  }

  const trades = [];
  const ptrs = filings.filter((p) => p.filing.type === "P");
  for (const p of ptrs) {
    for (const t of p.trades ?? []) {
      const kind = kindOf(t.type, t.asset);
      const m = ["stock", "options", "bonds"].includes(kind) ? await matchAsset(t.asset, t.ticker) : undefined;
      const date = iso(t.date);
      const lag = Math.round((Date.parse(p.filing.filed) - Date.parse(date)) / 864e5);
      trades.push({
        date,
        filed: p.filing.filed,
        lagDays: lag,
        name: clean(t.asset),
        kind,
        owner: t.owner,
        tx: TX[t.transaction] ?? t.transaction,
        ...bounds(t.amount),
        ...(t.filingStatus && t.filingStatus !== "New" ? { status: t.filingStatus } : {}),
        ...(t.description ? { description: t.description } : {}),
        ...(t.comments ? { comments: t.comments } : {}),
        ...(ADVISER.test(`${t.comments ?? ""} ${t.description ?? ""}`) ? { adviser: true } : {}),
        docUrl: pdfUrl(p.filing),
        ...company(m),
      });
    }
  }
  trades.sort((a, b) => b.date.localeCompare(a.date));

  members[bioguide] = {
    annual: annual
      ? { year: annual.filing.year, filed: annual.filing.filed, url: pdfUrl(annual.filing), amended: annual.filing.type === "A", paper: !annual.text }
      : undefined,
    holdings,
    trades,
    ptrs: ptrs.map((p) => ({ filed: p.filing.filed, url: pdfUrl(p.filing), paper: !p.text })).sort((a, b) => b.filed.localeCompare(a.filed)),
  };
}

const out = { generatedAt: new Date().toISOString(), source: "U.S. House Clerk financial disclosure reports", members };
fs.mkdirSync("site/src/data", { recursive: true });
fs.writeFileSync("site/src/data/holdings.json", JSON.stringify(out));
console.log(`${Object.keys(members).length} members, ${(fs.statSync("site/src/data/holdings.json").size / 1e6).toFixed(1)} MB`);
