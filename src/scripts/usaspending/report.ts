// Markdown tables for design/usaspending/README.md from matches.json and
// totals.json. Run: tsx src/scripts/usaspending/report.ts
import { CACHE, readJson } from "./common.js";
import type { Match } from "./match.js";
import type { Totals } from "./totals.js";

const matches = readJson<Match[]>(`${CACHE}/matches.json`);
const totals = new Map(readJson<Totals[]>(`${CACHE}/totals.json`).map((t) => [t.id, t]));
const m$ = (n: number) => (Math.abs(n) >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : Math.abs(n) >= 1e3 ? `$${(n / 1e3).toFixed(0)}K` : `$${n.toFixed(0)}`);
const pct = (a: number, b: number) => (b ? `${Math.round((100 * a) / b)}%` : "–");

const matched = matches.filter((m) => m.recipient);
const fy = (m: Match, y: string) => totals.get(m.id)?.byYear[y];
const withMoney = (y: string, min = 1) => matched.filter((m) => (fy(m, y)?.total ?? 0) >= min);

console.log(`## Sample\n`);
console.log(`Organizations in the sample: ${matches.length} (${matches.filter((m) => m.inSample.includes("contributions")).length} from the top 200 by contributions, ${matches.filter((m) => m.inSample.includes("lobbying")).length} from the top 100 by lobbying spend, ${matches.filter((m) => m.inSample.length === 2).length} in both).`);
console.log(`Matched to a USAspending recipient: ${matched.length} (${pct(matched.length, matches.length)}). Of those, ${matched.filter((m) => m.recipient!.level === "P").length} parent recipients, ${matched.filter((m) => m.recipient!.level === "R").length} standalone, ${matched.filter((m) => m.recipient!.level === "C").length} child-only; ${matched.filter((m) => m.recipient!.via === "parent-of-child").length} reached through a child.`);
console.log(`With any FY2025 obligations: ${withMoney("2025").length}; with at least $1M: ${withMoney("2025", 1e6).length}; at least $100M: ${withMoney("2025", 1e8).length}.\n`);

console.log(`### Match rate by sector\n`);
console.log(`| Sector | In sample | Matched | With FY2025 awards ≥ $1M | FY2025 obligations |\n|---|---|---|---|---|`);
const sectors = [...new Set(matches.map((m) => m.sector))];
const rows = sectors.map((s) => {
  const all = matches.filter((m) => m.sector === s);
  const mt = all.filter((m) => m.recipient);
  const money = mt.filter((m) => (fy(m, "2025")?.total ?? 0) >= 1e6);
  const sum = mt.reduce((a, m) => a + (fy(m, "2025")?.total ?? 0), 0);
  return { s, n: all.length, mt: mt.length, money: money.length, sum };
});
rows.sort((a, b) => b.n - a.n);
for (const r of rows) console.log(`| ${r.s} | ${r.n} | ${r.mt} (${pct(r.mt, r.n)}) | ${r.money} | ${m$(r.sum)} |`);
const tot = rows.reduce((a, r) => ({ n: a.n + r.n, mt: a.mt + r.mt, money: a.money + r.money, sum: a.sum + r.sum }), { n: 0, mt: 0, money: 0, sum: 0 });
console.log(`| **All** | ${tot.n} | ${tot.mt} (${pct(tot.mt, tot.n)}) | ${tot.money} | ${m$(tot.sum)} |\n`);

console.log(`### Top 25 by FY2025 obligations\n`);
console.log(`| # | Organization | Sector | Contributions 2022–26 | Lobbying 2021–26 | Federal awards FY2025 | FY2024 | Contracts | Grants | Loans | Other | USAspending recipient |\n|---|---|---|---|---|---|---|---|---|---|---|---|`);
const top = [...matched].sort((a, b) => (fy(b, "2025")?.total ?? 0) - (fy(a, "2025")?.total ?? 0)).slice(0, 25);
top.forEach((m, i) => {
  const y = fy(m, "2025")!;
  const y4 = fy(m, "2024");
  console.log(
    `| ${i + 1} | ${m.name} | ${m.sector} | ${m$(m.contributions)} | ${m.lobbying ? m$(m.lobbying) : "–"} | **${m$(y.total)}** | ${y4 ? m$(y4.total) : "–"} | ${pct(y.contracts + y.idv, y.total)} | ${pct(y.grants, y.total)} | ${pct(y.loans, y.total)} | ${pct(y.direct + y.other, y.total)} | ${m.recipient!.name} (${m.recipient!.level}) |`
  );
});

console.log(`\n### Top awarding agencies, FY2025, for the ten largest\n`);
console.log(`| Organization | Agencies (share of its FY2025 obligations) |\n|---|---|`);
for (const m of top.slice(0, 10)) {
  const t = totals.get(m.id)!;
  const total = t.byYear["2025"]!.total;
  console.log(`| ${m.name} | ${(t.agencies ?? []).map((a) => `${a.name} ${pct(a.amount, total)}`).join("; ")} |`);
}

console.log(`\n### Sector totals, FY2025 (matched organizations in the sample)\n`);
console.log(`| Sector | Orgs with awards | Contracts | Grants | Loans | Direct/other | Total |\n|---|---|---|---|---|---|---|`);
for (const s of sectors) {
  const ms = matched.filter((m) => m.sector === s && fy(m, "2025"));
  if (!ms.length) continue;
  const sum = (k: keyof NonNullable<ReturnType<typeof fy>>) => ms.reduce((a, m) => a + (fy(m, "2025")![k] ?? 0), 0);
  console.log(`| ${s} | ${ms.filter((m) => fy(m, "2025")!.total >= 1e6).length} | ${m$(sum("contracts") + sum("idv"))} | ${m$(sum("grants"))} | ${m$(sum("loans"))} | ${m$(sum("direct") + sum("other"))} | ${m$(sum("total"))} |`);
}

console.log(`\n### Unmatched organizations (${matches.length - matched.length})\n`);
for (const m of matches.filter((m) => !m.recipient)) console.log(`- ${m.name} (${m.sector}; ${m$(m.contributions)} contributions, ${m.lobbying ? m$(m.lobbying) + " lobbying" : "no lobbying spend"}; ${m.candidates} search rows${m.note ? "; " + m.note : ""})`);

console.log(`\n### Matched through a child, or on a different name\n`);
for (const m of matched.filter((m) => m.note || m.recipient!.matchedOn !== m.name)) console.log(`- ${m.name} → ${m.recipient!.name} [${m.recipient!.level}] (matched on "${m.recipient!.matchedOn}"${m.note ? "; " + m.note : ""})`);

console.log(`\n### Matched, but no FY2025 or FY2024 awards\n`);
for (const m of matched.filter((m) => !(fy(m, "2025")?.total || fy(m, "2024")?.total))) console.log(`- ${m.name} (${m.sector}) → ${m.recipient!.name} [${m.recipient!.level}]`);

console.log(`\n### Negative FY totals (de-obligations)\n`);
for (const m of matched.filter((m) => (fy(m, "2025")?.total ?? 0) < 0 || (fy(m, "2024")?.total ?? 0) < 0)) console.log(`- ${m.name}: FY2024 ${m$(fy(m, "2024")?.total ?? 0)}, FY2025 ${m$(fy(m, "2025")?.total ?? 0)}`);
