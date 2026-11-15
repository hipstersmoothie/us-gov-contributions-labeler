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
import type { ScannedTrade } from "./scan/ptr.js";
import type { ScannedHolding } from "./scan/annual.js";
import { rangeOf, type StatementHolding } from "./scan/statements.js";

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

/** Municipal and other government bonds, by the words their names use. */
const MUNI = /\b(MUN|MUNI|GO|REV|REVS|BDS|SCH DIST|AUTH|TREAS(URY|RY)?|T-BILL|BILXX|ST\s+(GO|REV|HSG))\b/i;

const scanned = new Map(
  (fs.existsSync(`${CACHE}/scan/ptrs.json`)
    ? (JSON.parse(fs.readFileSync(`${CACHE}/scan/ptrs.json`, "utf8")) as { filing: HouseFiling; trades: ScannedTrade[] }[])
    : []
  ).map((d) => [d.filing.docId, d])
);

const scannedAnnuals = new Map(
  (fs.existsSync(`${CACHE}/scan/annuals.json`)
    ? (JSON.parse(fs.readFileSync(`${CACHE}/scan/annuals.json`, "utf8")) as { filing: HouseFiling; holdings: ScannedHolding[] }[])
    : []
  ).map((d) => [d.filing.docId, d])
);

/** Brokerage statements attached to paper reports in place of a list (scan/statements.ts). */
const statements = new Map(
  (fs.existsSync(`${CACHE}/scan/statements.json`)
    ? (JSON.parse(fs.readFileSync(`${CACHE}/scan/statements.json`, "utf8")) as { docId: string; holdings: StatementHolding[] }[])
    : []
  ).map((d) => [d.docId, d.holdings])
);

/** Kind from a name alone, for paper forms that carry no type codes. */
function kindFromName(asset: string): Kind {
  if (MUNI.test(asset) || /\b(BANK|CHECKING|SAVINGS|MONEY MARKET|MMDA|CASH)\b/i.test(asset)) return "cash";
  if (/\b(IRA|401\s?\(?K\)?|ROTH|SEP|529|PENSION|RETIREMENT|TSP)\b/i.test(asset)) return "retirement";
  if (FUND_NAME.test(asset) || /\b(FUND|FD|LP|L\.P\.|PARTNERS)\b/i.test(asset)) return "funds";
  if (INDEX_PRODUCT.test(asset) || /\bannuity\b/i.test(asset)) return "other";
  // Corporate bonds: "CITIGROUP INC 4 125 / 07/25/2028 USD SUB LIEN".
  if (/\b(LIEN|NOTES?|DEBS?|BONDS?|CPN)\b|\d\s*%|\d{1,2}\/\d{2}\/\d{2,4}/i.test(asset)) return "bonds";
  if (/\b(PROPERTY|FARM|LLC|LAND|RENTAL|BUILDING|REAL ESTATE|NOTE RECEIVABLE)\b/i.test(asset)) return "business";
  return "stock";
}

const byMember = new Map<string, Parsed[]>();
for (const p of parsed) byMember.set(p.filing.bioguide!, [...(byMember.get(p.filing.bioguide!) ?? []), p]);

const members: Record<string, unknown> = {};
for (const [bioguide, filings] of byMember) {
  // The latest e-filed annual or amendment for 2025 replaces the original. A
  // later amendment on paper can't be read, so it's linked instead.
  const annuals = filings.filter((p) => p.filing.type !== "P").sort((a, b) => a.filing.filed.localeCompare(b.filing.filed));
  const annual = annuals.filter((p) => p.text).at(-1) ?? annuals.at(-1);
  const paperAmendments = annual?.text ? annuals.filter((p) => !p.text && p.filing.filed >= annual.filing.filed) : [];
  const holdings: Record<string, unknown>[] = [];
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

  // A paper-only annual report, read by machine from the scan (scan/run-annuals.ts).
  let annualUnread = 0;
  const scan = annual && !annual.text ? scannedAnnuals.get(annual.filing.docId) : undefined;
  for (const h of scan?.holdings ?? []) {
    if (h.doubts.length || h.min === undefined || !h.asset) {
      annualUnread++;
      continue;
    }
    const kind = kindFromName(h.asset);
    const name = h.asset.replace(/\s+(CMN|COM)\b.*$/i, "").replace(/^[A-Z]{2,5}\s+(?=\()/, "").trim();
    // A bond's issuer is the name before its coupon and maturity.
    const issuer = kind === "bonds" ? name.replace(/\s+\d.*$/, "").trim() : name;
    const m = kind === "stock" || kind === "bonds" ? await matchAsset(issuer, h.ticker, true) : undefined;
    holdings.push({
      name: h.asset,
      // A name that doesn't match an SEC company isn't called a stock.
      kind: kind === "stock" && !m ? "other" : kind,
      owner: h.owner,
      min: h.min,
      max: h.max ?? h.min,
      open: h.max === null,
      text: h.min === 0 ? "None" : "",
      scanned: true,
      docUrl: `${pdfUrl(annual!.filing)}#page=${h.page + 1}`,
      ...company(m),
    });
  }

  // Attached statements: exact values become the range a filer would report.
  for (const h of (annual && statements.get(annual.filing.docId)) ?? []) {
    if (h.doubts.length || h.value < 1) continue;
    const m = h.section === "stock" ? await matchAsset(h.asset, undefined, true) : undefined;
    const [min, max] = rangeOf(h.value);
    holdings.push({
      name: h.asset,
      kind: h.section === "stock" && !m ? "other" : h.section,
      owner: "self",
      min,
      max: max ?? min,
      open: max === null,
      text: "",
      account: `Edward Jones: ${h.account.toLowerCase().replace(/^ira$/, "IRA")}`,
      scanned: true,
      fromStatement: true,
      docUrl: `${pdfUrl(annual!.filing)}#page=${h.page + 1}`,
      ...company(m),
    });
  }

  const trades: Record<string, unknown>[] = [];
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
        ...(t.subholdingOf ? { account: t.subholdingOf } : {}),
        docUrl: pdfUrl(p.filing),
        ...company(m),
      });
    }
  }
  // Paper PTRs, read by machine from the scans (scan/run-ptrs.ts). Only rows
  // with no doubts are used; the rest are counted and linked.
  let scanUnread = 0;
  for (const p of ptrs.filter((p) => !p.text)) {
    const scan = scanned.get(p.filing.docId);
    if (!scan) continue;
    for (const t of scan.trades) {
      if (t.doubts.length || !t.date || !t.tx || t.min === undefined) {
        scanUnread++;
        continue;
      }
      // A trust's heading sometimes reads into the first asset under it:
      // "Monte and Usha Ahuja 2010 Irrev Trust FBO INTEL CORP COM".
      let asset = t.asset;
      let account = t.account;
      const split = asset.match(/^(.*\b(?:Trust|Partnership|Account)\b(?:\s+FBO(?:\s+[A-Z][a-z]+)+)?)\s+([A-Z0-9][A-Z0-9 .,&'\/()-]{3,})$/);
      if (split && /[a-z]/.test(split[1]!)) [account, asset] = [split[1]!, split[2]!];
      // Garbled form text ("se ame, no el vbo") isn't an account; real headings name one.
      if (account && !/\b(trust|partnership|account|IRA|LLC|L\.?P\.?|FBO|family|investments|estate|portfolio|fund)\b/i.test(account)) account = undefined;
      const name = asset.replace(/\s+(CMN|COM)\b.*$/i, "").trim() || asset;
      const kind: Kind = MUNI.test(asset)
        ? "cash"
        : FUND_NAME.test(asset) || /\b(FUND|FD|LP|L\.P\.|PARTNERS)\b/i.test(asset)
          ? "funds"
          : INDEX_PRODUCT.test(asset)
            ? "other"
            : "stock";
      const m = kind === "stock" ? await matchAsset(name, undefined, true) : undefined;
      trades.push({
        date: t.date,
        filed: p.filing.filed,
        lagDays: Math.round((Date.parse(p.filing.filed) - Date.parse(t.date)) / 864e5),
        name: asset,
        // No type code on paper forms: a name that matches an SEC company is called a stock.
        kind: m ? kind : kind === "stock" ? "other" : kind,
        owner: t.owner,
        tx: t.tx,
        min: t.min,
        max: t.max ?? t.min,
        open: t.max === null,
        text: "",
        ...(account ? { account } : {}),
        scanned: true,
        docUrl: `${pdfUrl(p.filing)}#page=${t.page + 1}`,
        ...company(m),
      });
    }
  }
  trades.sort((a, b) => String(b.date).localeCompare(String(a.date)));

  members[bioguide] = {
    annual: annual
      ? { year: annual.filing.year, filed: annual.filing.filed, url: pdfUrl(annual.filing), amended: annual.filing.type === "A", paper: !annual.text }
      : undefined,
    ...(paperAmendments.length ? { paperAmendments: paperAmendments.map((p) => ({ filed: p.filing.filed, url: pdfUrl(p.filing) })) } : {}),
    ...(scanUnread ? { scanUnread } : {}),
    ...(scan ? { annualScanned: true, annualUnread } : {}),
    holdings,
    trades,
    ptrs: ptrs.map((p) => ({ filed: p.filing.filed, url: pdfUrl(p.filing), paper: !p.text })).sort((a, b) => b.filed.localeCompare(a.filed)),
  };
}

const out = { generatedAt: new Date().toISOString(), source: "U.S. House Clerk financial disclosure reports", members };
fs.mkdirSync("site/src/data", { recursive: true });
fs.writeFileSync("site/src/data/holdings.json", JSON.stringify(out));
console.log(`${Object.keys(members).length} members, ${(fs.statSync("site/src/data/holdings.json").size / 1e6).toFixed(1)} MB`);
