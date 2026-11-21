// For every matched recipient, FY2024 and FY2025 obligations by award type
// (one spending_over_time request each), and for the ten largest, the top
// awarding agencies in FY2025. Writes .cache/usaspending/totals.json.
// Run after match.ts: tsx src/scripts/usaspending/totals.ts
import { api, CACHE, FY, readJson, requests, writeJson, type OverTime } from "./common.js";
import type { Match } from "./match.js";

export interface Totals {
  id: string;
  recipientId: string;
  byYear: Record<string, { total: number; contracts: number; idv: number; grants: number; loans: number; direct: number; other: number }>;
  agencies?: { name: string; amount: number }[];
}

const matches = readJson<Match[]>(`${CACHE}/matches.json`).filter((m) => m.recipient);
const totals: Totals[] = [];
for (const m of matches) {
  const res = await api<OverTime>("/search/spending_over_time/", {
    group: "fiscal_year",
    filters: { recipient_id: m.recipient!.id, time_period: [{ start_date: FY[2024].start_date, end_date: FY[2025].end_date }] },
  });
  const byYear: Totals["byYear"] = {};
  for (const r of res.results) {
    byYear[r.time_period.fiscal_year] = {
      total: r.aggregated_amount,
      contracts: r.Contract_Obligations,
      idv: r.Idv_Obligations,
      grants: r.Grant_Obligations,
      loans: r.Loan_Obligations,
      direct: r.Direct_Obligations,
      other: r.Other_Obligations,
    };
  }
  totals.push({ id: m.id, recipientId: m.recipient!.id, byYear });
}
writeJson(`${CACHE}/totals.json`, totals);

const top = [...totals].sort((a, b) => (b.byYear["2025"]?.total ?? 0) - (a.byYear["2025"]?.total ?? 0)).slice(0, 10);
for (const t of top) {
  const res = await api<{ results: { name: string; amount: number }[] }>("/search/spending_by_category/awarding_agency/", {
    filters: { recipient_id: t.recipientId, time_period: [FY[2025]] },
    limit: 5,
  });
  t.agencies = res.results.map((r) => ({ name: r.name, amount: r.amount }));
}
writeJson(`${CACHE}/totals.json`, totals);
console.log(`${totals.length} recipients, ${requests} requests`);
