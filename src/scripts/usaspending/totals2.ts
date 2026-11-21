// Second pass: USAspending splits a parent's history across several "P"
// records when its SAM name or UEI changes (RTX, Honeywell). For each matched
// organization, sum spending_over_time over every same-name P or R record the
// (cached) keyword searches returned, and cross-check against the DUNS-keyed
// children endpoint, which follows the DUNS rather than the name+UEI hash.
// Writes .cache/usaspending/totals2.json. Run: tsx src/scripts/usaspending/totals2.ts
import { normalizeOrg, sameOrg } from "../../lib/names.js";
import { api, CACHE, FY, readJson, requests, writeJson, type OverTime, type RecipientRow } from "./common.js";
import type { Match } from "./match.js";

interface Org { id: string; name: string; lobbying?: { client: string }; sec?: { name: string } }
const orgs = new Map(readJson<{ organizations: Org[] }>("data/organizations.json").organizations.map((o) => [o.id, o]));
const matches = readJson<Match[]>(`${CACHE}/matches.json`).filter((m) => m.recipient);

export interface Totals2 {
  id: string;
  records: { id: string; name: string; level: string; uei: string | null; duns: string | null; fy2024: number; fy2025: number }[];
  byYear: Record<string, { total: number; contracts: number; idv: number; grants: number; loans: number; direct: number; other: number }>;
  childrenByDuns: Record<string, number>; // FY → sum over /recipient/children/<duns>/ for each distinct parent DUNS
}

function namesOf(o: Org) {
  const names = [o.name, o.lobbying?.client, o.sec?.name].filter((n): n is string => !!n);
  const acronym = o.name.match(/\(([A-Z]{2,8})\)/)?.[1];
  if (acronym) names.push(acronym);
  return [...new Set(names)];
}
const keyword = (name: string) => normalizeOrg(name).split(" ").slice(0, 6).join(" ");

const out: Totals2[] = [];
const notParent = new Set<string>();
for (const m of matches) {
  const o = orgs.get(m.id)!;
  const names = namesOf(o);
  const seen = new Map<string, RecipientRow>();
  for (const n of names) {
    const kw = keyword(n);
    if (!kw) continue;
    const res = await api<{ results: RecipientRow[] }>("/recipient/", { keyword: kw, limit: 50, sort: "amount", order: "desc" });
    for (const r of res.results) if (typeof r.name === "string" && r.name) seen.set(r.id, r);
    if (seen.size) break;
  }
  const records = [...seen.values()].filter((r) => r.recipient_level !== "C" && names.some((n) => sameOrg(n, r.name)));
  if (!records.some((r) => r.id === m.recipient!.id)) {
    records.push({ id: m.recipient!.id, name: m.recipient!.name, recipient_level: m.recipient!.level, uei: m.recipient!.uei, duns: m.recipient!.duns, amount: m.recipient!.trailing12m });
  }
  const t: Totals2 = { id: m.id, records: [], byYear: {}, childrenByDuns: {} };
  for (const r of records) {
    const res = await api<OverTime>("/search/spending_over_time/", {
      group: "fiscal_year",
      filters: { recipient_id: r.id, time_period: [{ start_date: FY[2024].start_date, end_date: FY[2025].end_date }] },
    });
    const rec = { id: r.id, name: r.name, level: r.recipient_level, uei: r.uei, duns: r.duns, fy2024: 0, fy2025: 0 };
    for (const y of res.results) {
      const fy = y.time_period.fiscal_year;
      if (fy === "2024") rec.fy2024 = y.aggregated_amount;
      if (fy === "2025") rec.fy2025 = y.aggregated_amount;
      const b = (t.byYear[fy] ??= { total: 0, contracts: 0, idv: 0, grants: 0, loans: 0, direct: 0, other: 0 });
      b.total += y.aggregated_amount;
      b.contracts += y.Contract_Obligations;
      b.idv += y.Idv_Obligations;
      b.grants += y.Grant_Obligations;
      b.loans += y.Loan_Obligations;
      b.direct += y.Direct_Obligations;
      b.other += y.Other_Obligations;
    }
    t.records.push(rec);
  }
  const dunses = [...new Set(records.filter((r) => r.recipient_level === "P" && r.duns).map((r) => r.duns!))];
  for (const fy of ["2024", "2025"]) {
    let sum = 0;
    for (const d of dunses) {
      // Some P records' DUNS are "not listed as a parent" (400): a parent by hash, not by DUNS.
      const kids = await api<{ amount: number }[]>(`/recipient/children/${d}/?year=${fy}`).catch((e: Error) => {
        if (!/^400 /.test(e.message)) throw e;
        notParent.add(d);
        return [];
      });
      sum += kids.reduce((a, k) => a + (k.amount ?? 0), 0);
    }
    t.childrenByDuns[fy] = sum;
  }
  out.push(t);
  if (out.length % 25 === 0) {
    console.log(`${out.length}/${matches.length} (${requests} requests)`);
    writeJson(`${CACHE}/totals2.json`, out);
  }
}
writeJson(`${CACHE}/totals2.json`, out);
console.log(`${out.length} organizations, ${requests} requests; P records whose DUNS the children endpoint rejects: ${[...notParent].join(", ")}`);
