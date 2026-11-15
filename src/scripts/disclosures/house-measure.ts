// Measure the House sample: text layers, parse rates, owners, asset kinds,
// SEC/sector matching and PTR filing lags.
//
//   tsx src/scripts/disclosures/house-measure.ts
import "dotenv/config";
import fs from "fs";
import { CACHE, currentMembers, writeJson } from "./common.js";
import type { HouseFiling } from "./house-index.js";
import type { Holding, Range, Trade } from "./house-parse.js";
import { matchAsset } from "./match.js";

interface Result {
  filing: HouseFiling & { why: string };
  bytes: number;
  pages: number;
  chars: number;
  text: boolean;
  holdings?: Holding[];
  trades?: Trade[];
  error?: string;
}
const results = JSON.parse(fs.readFileSync(`${CACHE}/house/sample.json`, "utf8")) as Result[];
const names = new Map(currentMembers().map((m) => [m.bioguide, `${m.first} ${m.last} (${m.party[0]}-${m.state})`]));

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "–");
const log = (...a: unknown[]) => console.log(...a);

// --- Text layers -------------------------------------------------------------
log("## Text layer by DocID medium");
for (const medium of ["electronic", "paper"] as const) {
  for (const type of ["O", "A", "P"]) {
    const rs = results.filter((r) => r.filing.medium === medium && r.filing.type === type && !r.error);
    if (!rs.length) continue;
    const text = rs.filter((r) => r.text).length;
    const mb = rs.reduce((s, r) => s + r.bytes, 0) / 1e6;
    log(`  ${medium.padEnd(10)} ${type}: ${rs.length} PDFs, ${text} with text (${pct(text, rs.length)}), ${(mb / rs.length).toFixed(2)} MB avg, ${(rs.reduce((s, r) => s + r.pages, 0) / rs.length).toFixed(1)} pages avg`);
  }
}
log(`  errors: ${results.filter((r) => r.error).map((r) => r.error).join("; ") || "none"}`);

// --- Kinds of asset ------------------------------------------------------------
export const KIND: Record<string, string> = {
  ST: "Individual stock", OP: "Options", RS: "Individual stock", SA: "Options", CS: "Corporate bonds",
  MF: "Funds", EF: "Funds", ET: "Funds", HE: "Private funds", HN: "Private funds", "5F": "Funds",
  RE: "Funds", RF: "Private funds", RN: "Private funds", IC: "Funds",
  BA: "Cash & government", IH: "Cash & government", GS: "Cash & government", FE: "Cash & government",
  "4K": "Retirement & college accounts", IR: "Retirement & college accounts", "5C": "Retirement & college accounts",
  "5P": "Retirement & college accounts", DB: "Retirement & college accounts", PE: "Retirement & college accounts",
  VA: "Insurance & annuities", VI: "Insurance & annuities", WU: "Insurance & annuities", FN: "Insurance & annuities",
  RP: "Real estate & businesses", FA: "Real estate & businesses", OL: "Real estate & businesses",
  OI: "Real estate & businesses", PS: "Real estate & businesses", DS: "Real estate & businesses", MO: "Real estate & businesses",
  CT: "Crypto", EQ: "Blind trust", TR: "Trusts", BK: "Brokerage (unitemized)", MA: "Managed accounts",
  DO: "Debts owed to filer", CO: "Other", IP: "Other", PM: "Other", FU: "Other", AB: "Other", OT: "Other",
};
const kind = (type?: string) => (type ? KIND[type] ?? `Other (${type})` : "No type code");

/** Midpoint of a range, or its floor when open-ended. Only for weighting shares, never shown. */
const mid = (r?: Range) => (!r ? 0 : r.max === null ? r.min : (r.min + r.max) / 2);

// --- Annual reports: Schedule A ----------------------------------------------
log("\n## Annual reports (CY2025), e-filed");
const annual = results.filter((r) => r.filing.type === "O" && r.holdings);
const holdings = annual.flatMap((r) => r.holdings!.map((h) => ({ ...h, bioguide: r.filing.bioguide! })));
log(`  ${annual.length} reports, ${holdings.length} assets; median ${median(annual.map((r) => r.holdings!.length))} per report; ${annual.filter((r) => !r.holdings!.length).length} with no assets parsed`);
log(`  value parsed: ${pct(holdings.filter((h) => h.value).length, holdings.length)}, type code: ${pct(holdings.filter((h) => h.type).length, holdings.length)}, ticker in name: ${pct(holdings.filter((h) => h.ticker).length, holdings.length)}`);
const valueTexts = count(holdings.map((h) => h.value?.text ?? "(none)"));
log(`  value ranges seen: ${Object.entries(valueTexts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ×${v}`).join("; ")}`);
log(`  owners: ${fmtCount(count(holdings.map((h) => h.owner)))}`);
log(`  owners by value: ${fmtShare(holdings, (h) => h.owner)}`);
log(`  subholdings (inside an account): ${pct(holdings.filter((h) => h.subholdingOf).length, holdings.length)}`);
log(`  kinds by count: ${fmtCount(count(holdings.map((h) => kind(h.type))))}`);
log(`  kinds by value: ${fmtShare(holdings, (h) => kind(h.type))}`);
log(`  open-ended or "Spouse/DC Over $1,000,000" values: ${holdings.filter((h) => h.value?.max === null).length}`);

// --- Matching ------------------------------------------------------------------
log("\n## Matching annual holdings to SEC companies");
const matched = [] as { h: (typeof holdings)[number]; m: Awaited<ReturnType<typeof matchAsset>> }[];
for (const h of holdings) matched.push({ h, m: await matchAsset(h.asset, h.ticker) });
const company = matched.filter(({ h }) => ["Individual stock", "Options", "Corporate bonds"].includes(kind(h.type)));
const hit = company.filter((x) => x.m);
log(`  individual stocks/options/bonds: ${company.length}; matched ${hit.length} (${pct(hit.length, company.length)}): by ticker ${hit.filter((x) => x.m!.how === "ticker").length}, by name ${hit.filter((x) => x.m!.how === "name").length}`);
const cv = company.reduce((s, x) => s + mid(x.h.value), 0);
const hv = hit.reduce((s, x) => s + mid(x.h.value), 0);
log(`  share of individual-company value matched: ${pct(hv, cv)}`);
log(`  ...with an organization page on the site: ${hit.filter((x) => x.m!.org).length} holdings (${pct(hit.filter((x) => x.m!.org).reduce((s, x) => s + mid(x.h.value), 0), cv)} of value)`);
log(`  sectors (by value): ${fmtShare(hit.map((x) => ({ ...x.h, s: x.m!.sector })), (h: any) => h.s)}`);
const totalValue = holdings.reduce((s, h) => s + mid(h.value), 0);
log(`  share of ALL disclosed value that is a matched company: ${pct(hv, totalValue)}`);
const funds = matched.filter(({ h }) => kind(h.type) === "Funds");
log(`  funds that a name/ticker hits in company_tickers (would be wrongly sectored if trusted): ${funds.filter((x) => x.m).length} of ${funds.length}`);
log(`  unmatched individual stocks (sample): ${company.filter((x) => !x.m).slice(0, 25).map((x) => x.h.asset).join(" | ")}`);

// --- PTRs -----------------------------------------------------------------------
log("\n## Periodic transaction reports, e-filed");
const ptrs = results.filter((r) => r.filing.type === "P" && r.trades);
const trades = ptrs.flatMap((r) => r.trades!.map((t) => ({ ...t, filing: r.filing })));
log(`  ${ptrs.length} PTRs, ${trades.length} transactions; ${ptrs.filter((r) => !r.trades!.length).length} PTRs with none parsed`);
log(`  amount parsed: ${pct(trades.filter((t) => t.amount && t.amount.min > 0).length, trades.length)}; type code: ${pct(trades.filter((t) => t.type).length, trades.length)}; ticker: ${pct(trades.filter((t) => t.ticker).length, trades.length)}`);
log(`  transaction types: ${fmtCount(count(trades.map((t) => t.transaction)))}`);
log(`  owners: ${fmtCount(count(trades.map((t) => t.owner)))}`);
log(`  kinds: ${fmtCount(count(trades.map((t) => kind(t.type))))}`);
log(`  amounts: ${fmtCount(count(trades.map((t) => t.amount?.text ?? "(none)")))}`);
const toDate = (s: string) => new Date(s.replace(/(\d\d)\/(\d\d)\/(\d{4})/, "$3-$1-$2")).getTime();
const lags = trades
  .filter((t) => /\d\d\/\d\d\/\d{4}/.test(t.date))
  .map((t) => (new Date(t.filing.filed).getTime() - toDate(t.date)) / 864e5);
lags.sort((a, b) => a - b);
log(`  days from trade to filing: median ${lags[Math.floor(lags.length / 2)]}, p90 ${lags[Math.floor(lags.length * 0.9)]}, max ${lags.at(-1)}; over 45 days: ${pct(lags.filter((l) => l > 45).length, lags.length)}`);
log(`  filing status "New" vs amended: ${fmtCount(count(trades.map((t) => t.filingStatus ?? "(none)")))}`);
const tmatched = [] as boolean[];
for (const t of trades.filter((t) => ["Individual stock", "Options"].includes(kind(t.type)))) tmatched.push(!!(await matchAsset(t.asset, t.ticker)));
log(`  stock/option trades matched to an SEC company: ${pct(tmatched.filter(Boolean).length, tmatched.length)}`);

// --- Named members ----------------------------------------------------------------
log("\n## Named members");
for (const id of new Set(results.filter((r) => r.filing.why === "named").map((r) => r.filing.bioguide!))) {
  const rs = results.filter((r) => r.filing.bioguide === id);
  const a = rs.find((r) => r.filing.type === "O");
  const hs = a?.holdings ?? [];
  const ts = rs.flatMap((r) => r.trades ?? []);
  const paper = rs.filter((r) => !r.text).length;
  const stockShare = pct(hs.filter((h) => ["Individual stock", "Options"].includes(kind(h.type))).reduce((s, h) => s + mid(h.value), 0), hs.reduce((s, h) => s + mid(h.value), 0));
  log(`  ${names.get(id)}: ${rs.length} PDFs (${paper} without text); annual ${a ? (a.text ? `${hs.length} assets, individual stocks ${stockShare} of value, spouse/joint ${pct(hs.filter((h) => h.owner !== "self").length, hs.length)}` : "scanned") : "not in sample"}; ${ts.length} trades parsed`);
}

writeJson("house/holdings-sample.json", { holdings: matched.map(({ h, m }) => ({ ...h, match: m })), trades });

function count(xs: string[]) {
  const c: Record<string, number> = {};
  for (const x of xs) c[x] = (c[x] ?? 0) + 1;
  return c;
}
function fmtCount(c: Record<string, number>) {
  const n = Object.values(c).reduce((a, b) => a + b, 0);
  return Object.entries(c).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v, n)}`).join(", ");
}
function fmtShare<T extends { value?: Range }>(xs: T[], key: (x: T) => string) {
  const c: Record<string, number> = {};
  for (const x of xs) c[key(x)] = (c[key(x)] ?? 0) + mid(x.value);
  return fmtCount(c);
}
function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
