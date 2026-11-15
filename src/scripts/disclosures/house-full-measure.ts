// Numbers for the write-up, over every current House member's CY2025 annual
// report and 2025-26 PTRs (after house-all.ts and house-build.ts).
//
//   tsx src/scripts/disclosures/house-full-measure.ts
import fs from "fs";
import { CACHE, currentMembers } from "./common.js";
import type { Parsed } from "./house-all.js";

const parsed = JSON.parse(fs.readFileSync(`${CACHE}/house/all.json`, "utf8")) as Parsed[];
const built = JSON.parse(fs.readFileSync("site/src/data/holdings.json", "utf8")) as { members: Record<string, any> };
const house = currentMembers().filter((m) => m.chamber === "house");
const committees = JSON.parse(fs.readFileSync("data/congress-committees.json", "utf8")).committees as {
  id: string;
  parent?: string;
  members: { bioguide: string }[];
}[];

const pct = (a: number, b: number) => (b ? `${((a / b) * 100).toFixed(1)}%` : "–");
const log = console.log;
const mid = (x: { min: number; max: number }) => (x.min + x.max) / 2;
const quant = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * q)];

log("## Coverage (current House members)");
const annual = parsed.filter((p) => p.filing.type !== "P");
const ptr = parsed.filter((p) => p.filing.type === "P");
const mb = (xs: Parsed[]) => (xs.reduce((s, p) => s + p.bytes, 0) / 1e6).toFixed(0);
log(`  annual/amendment PDFs: ${annual.length} (${mb(annual)} MB), with text: ${pct(annual.filter((p) => p.text).length, annual.length)}`);
log(`  PTR PDFs: ${ptr.length} (${mb(ptr)} MB), with text: ${pct(ptr.filter((p) => p.text).length, ptr.length)}`);
log(`  paper PTR pages: ${ptr.filter((p) => !p.text).reduce((s, p) => s + p.pages, 0)} vs e-filed PTR pages ${ptr.filter((p) => p.text).reduce((s, p) => s + p.pages, 0)}`);
log(`  errors: ${parsed.filter((p) => p.error).length}`);
const ms = Object.values(built.members);
const eAnnual = ms.filter((d) => d.annual && !d.annual.paper);
log(`  members with an e-filed 2025 annual: ${eAnnual.length} of ${house.length}; paper annual: ${ms.filter((d) => d.annual?.paper).length}; none: ${house.length - ms.filter((d) => d.annual).length}`);
log(`  amended annuals used: ${ms.filter((d) => d.annual?.amended).length}`);
const paperPtrMembers = ms.filter((d) => d.ptrs.some((p: any) => p.paper)).length;
log(`  members with any paper PTR: ${paperPtrMembers}; with any PTR: ${ms.filter((d) => d.ptrs.length).length}`);

log("\n## Holdings (e-filed annuals)");
const hs = eAnnual.flatMap((d) => d.holdings);
log(`  ${hs.length} assets; median per member ${quant(eAnnual.map((d) => d.holdings.length), 0.5)}; members with none parsed ${eAnnual.filter((d) => !d.holdings.length).length}`);
const byKind: Record<string, [number, number]> = {};
for (const h of hs) {
  byKind[h.kind] ??= [0, 0];
  byKind[h.kind]![0]++;
  byKind[h.kind]![1] += mid(h);
}
const totalMid = hs.reduce((s: number, h: any) => s + mid(h), 0);
for (const [k, [n, v]] of Object.entries(byKind).sort((a, b) => b[1][1] - a[1][1]))
  log(`  ${k.padEnd(14)} ${pct(n, hs.length).padStart(6)} of assets, ${pct(v, totalMid).padStart(6)} of midpoint value`);
const own: Record<string, [number, number]> = {};
for (const h of hs) {
  own[h.owner] ??= [0, 0];
  own[h.owner]![0]++;
  own[h.owner]![1] += mid(h);
}
log(`  owners: ${Object.entries(own).map(([k, [n, v]]) => `${k} ${pct(n, hs.length)} (${pct(v, totalMid)} of value)`).join(", ")}`);
const company = hs.filter((h: any) => ["stock", "options", "bonds"].includes(h.kind));
log(`  single-company holdings: ${company.length}; matched to SEC ${pct(company.filter((h: any) => h.cik).length, company.length)} (${pct(company.filter((h: any) => h.cik).reduce((s: number, h: any) => s + mid(h), 0), company.reduce((s: number, h: any) => s + mid(h), 0))} of their value); to a site organization ${pct(company.filter((h: any) => h.org).length, company.length)}`);
log(`  members with any single-company stock: ${eAnnual.filter((d) => d.holdings.some((h: any) => ["stock", "options"].includes(h.kind))).length}`);
log(`  exact values instead of ranges: ${hs.filter((h: any) => h.exact).length} assets, ${eAnnual.filter((d) => d.holdings.some((h: any) => h.exact)).length} members`);
log(`  open-ended (Over $50M / Spouse-DC over $1M): ${hs.filter((h: any) => h.open).length}`);
log(`  "None"/"Undetermined" values: ${hs.filter((h: any) => /none|undetermined/i.test(h.text)).length}`);
const blind = hs.filter((h: any) => h.kind === "trust" || /blind trust/i.test(h.name + " " + (h.description ?? "")));
log(`  blind or other trusts: ${blind.length} assets, ${new Set(eAnnual.filter((d) => d.holdings.some((h: any) => blind.includes(h))).map((d) => d.annual.url)).size} members; qualified blind (EQ/"blind"): ${hs.filter((h: any) => /blind/i.test(h.name + " " + (h.description ?? ""))).length}`);
const wide = eAnnual.map((d) => d.holdings.reduce((s: number, h: any) => s + h.max, 0) / Math.max(1, d.holdings.reduce((s: number, h: any) => s + h.min, 0)));
log(`  per member, high end of total / low end: median ${quant(wide, 0.5)!.toFixed(1)}x, p90 ${quant(wide, 0.9)!.toFixed(1)}x`);

log("\n## Trades (e-filed PTRs, trade dates 2025-01-01 on)");
const ts = Object.entries(built.members).flatMap(([id, d]: any) => d.trades.filter((t: any) => t.date >= "2025-01-01").map((t: any) => ({ ...t, id })));
log(`  ${ts.length} trades by ${new Set(ts.map((t) => t.id)).size} members`);
const lags = ts.map((t) => t.lagDays);
log(`  days to report: median ${quant(lags, 0.5)}, p90 ${quant(lags, 0.9)}, p99 ${quant(lags, 0.99)}; over 45 days ${pct(lags.filter((l) => l > 45).length, lags.length)}; negative (date typos) ${lags.filter((l) => l < 0).length}`);
log(`  amended/deleted lines: ${ts.filter((t) => t.status).length}`);
const kinds: Record<string, number> = {};
for (const t of ts) kinds[t.kind] = (kinds[t.kind] ?? 0) + 1;
log(`  kinds: ${Object.entries(kinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${pct(n, ts.length)}`).join(", ")}`);
const owners: Record<string, number> = {};
for (const t of ts) owners[t.owner] = (owners[t.owner] ?? 0) + 1;
log(`  owners: ${Object.entries(owners).map(([k, n]) => `${k} ${pct(n, ts.length)}`).join(", ")}`);
log(`  amount $1,001-$15,000: ${pct(ts.filter((t) => t.max === 15000).length, ts.length)}; over $1M: ${pct(ts.filter((t) => t.min > 1_000_000).length, ts.length)}`);
const per = new Map<string, number>();
for (const t of ts) per.set(t.id, (per.get(t.id) ?? 0) + 1);
const top = [...per.values()].sort((a, b) => b - a);
log(`  top 5 traders account for ${pct(top.slice(0, 5).reduce((a, b) => a + b, 0), ts.length)} of trades; top 1 ${pct(top[0]!, ts.length)}`);
const ct = ts.filter((t) => ["stock", "options", "bonds"].includes(t.kind));
log(`  single-company trades matched to SEC: ${pct(ct.filter((t) => t.cik).length, ct.length)}`);

log("\n## Committee overlap: how often the naive framing fires");
const SECTORS: Record<string, string[]> = {
  HSAG: ["Agribusiness"], HSAS: ["Defense"], HSBA: ["Finance, Insurance & Real Estate"],
  HSIF: ["Energy & Natural Resources", "Health", "Communications & Technology"], HSII: ["Energy & Natural Resources"],
  HSPW: ["Transportation", "Construction"], HSED: ["Education"],
};
const pooled = eAnnual.flatMap((d) => d.holdings).filter((h: any) => ["stock", "options", "bonds"].includes(h.kind) && h.sector);
const share = (xs: any[], sectors: string[]) => {
  const tot = xs.reduce((s, h) => s + mid(h), 0);
  return tot ? xs.filter((h) => sectors.includes(h.sector)).reduce((s, h) => s + mid(h), 0) / tot : 0;
};
for (const [cid, sectors] of Object.entries(SECTORS)) {
  const seats = new Set(committees.find((c) => c.id === cid)?.members.map((m) => m.bioguide) ?? []);
  const rows = Object.entries(built.members)
    .filter(([, d]: any) => d.annual && !d.annual.paper)
    .map(([id, d]: any) => ({ id, on: seats.has(id), co: d.holdings.filter((h: any) => ["stock", "options", "bonds"].includes(h.kind) && h.sector) }))
    .filter((r) => r.co.length);
  const on = rows.filter((r) => r.on);
  const off = rows.filter((r) => !r.on);
  const anyIn = (rs: typeof rows) => rs.filter((r) => r.co.some((h: any) => sectors.includes(h.sector))).length;
  const base = share(pooled, sectors);
  const over = on.filter((r) => share(r.co, sectors) >= Math.max(2 * base, base + 0.1)).length;
  log(
    `  ${cid} (${sectors.join(", ")}): ${on.length} members with company stock; ${pct(anyIn(on), on.length)} hold at least one in the sector vs ${pct(anyIn(off), off.length)} of non-members. Baseline share ${pct(base, 1)}; members at 2x+ baseline (and +10 pts): ${over}`
  );
}
