// Compare the three ways of totaling a parent's FY obligations: the single
// matched record (totals.json), the sum of every same-name P/R record, and
// the DUNS-keyed children endpoint (both in totals2.json). Markdown out.
// Run: tsx src/scripts/usaspending/report2.ts
import { CACHE, readJson } from "./common.js";
import type { Match } from "./match.js";
import type { Totals } from "./totals.js";
import type { Totals2 } from "./totals2.js";

const matches = new Map(readJson<Match[]>(`${CACHE}/matches.json`).map((m) => [m.id, m]));
const one = new Map(readJson<Totals[]>(`${CACHE}/totals.json`).map((t) => [t.id, t]));
const all = readJson<Totals2[]>(`${CACHE}/totals2.json`);
const m$ = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`);

const best = (t: Totals2, fy: string) => Math.max(t.byYear[fy]?.total ?? 0, t.childrenByDuns[fy] ?? 0);
const rows = all
  .map((t) => ({ t, m: matches.get(t.id)!, o: one.get(t.id)!, fy25: best(t, "2025") }))
  .sort((a, b) => b.fy25 - a.fy25);

console.log(`Organizations: ${all.length}; with more than one same-name record: ${all.filter((t) => t.records.length > 1).length}; total records: ${all.reduce((a, t) => a + t.records.length, 0)}.`);
const disagree = rows.filter(({ t }) => ["2024", "2025"].some((fy) => { const a = t.byYear[fy]?.total ?? 0, b = t.childrenByDuns[fy] ?? 0; return Math.max(a, b) >= 1e6 && Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b)) > 0.1; }));
console.log(`Hash-sum and children-by-DUNS differ by more than 10% in a year with at least $1M: ${disagree.length}.\n`);

console.log(`| # | Organization | FY2025: one record | all same-name records | children by DUNS | FY2024: one record | all records | children | Records (P/R) |\n|---|---|---|---|---|---|---|---|---|`);
rows.slice(0, 30).forEach(({ t, m, o }, i) => {
  const r = t.records.map((x) => `${x.level}${x.fy2025 || x.fy2024 ? "*" : ""}`).join(" ");
  console.log(`| ${i + 1} | ${m.name} | ${m$(o.byYear["2025"]?.total ?? 0)} | ${m$(t.byYear["2025"]?.total ?? 0)} | ${m$(t.childrenByDuns["2025"] ?? 0)} | ${m$(o.byYear["2024"]?.total ?? 0)} | ${m$(t.byYear["2024"]?.total ?? 0)} | ${m$(t.childrenByDuns["2024"] ?? 0)} | ${t.records.length} (${r}) |`);
});

console.log(`\nDisagreements (>10%, ≥ $1M):\n`);
for (const { t, m } of disagree) {
  console.log(`- ${m.name}: FY2024 records ${m$(t.byYear["2024"]?.total ?? 0)} vs children ${m$(t.childrenByDuns["2024"] ?? 0)}; FY2025 records ${m$(t.byYear["2025"]?.total ?? 0)} vs children ${m$(t.childrenByDuns["2025"] ?? 0)}; records: ${t.records.map((x) => `${x.name} [${x.level}, ${x.uei ?? x.duns ?? "no id"}] ${m$(x.fy2024)}/${m$(x.fy2025)}`).join("; ")}`);
}

const sum = (pick: (t: Totals2) => number) => all.reduce((a, t) => a + pick(t), 0);
console.log(`\nSample FY2025 total: one record ${m$(all.reduce((a, t) => a + (one.get(t.id)!.byYear["2025"]?.total ?? 0), 0))}; all same-name records ${m$(sum((t) => t.byYear["2025"]?.total ?? 0))}; children by DUNS ${m$(sum((t) => t.childrenByDuns["2025"] ?? 0))}; max of the two per org ${m$(rows.reduce((a, r) => a + r.fy25, 0))}.`);
console.log(`Organizations with ≥ $1M in FY2025 by the max: ${rows.filter((r) => r.fy25 >= 1e6).length}; ≥ $100M: ${rows.filter((r) => r.fy25 >= 1e8).length}.`);
