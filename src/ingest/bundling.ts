// Lobbyist bundling: contributions that registered lobbyists, lobbying firms
// and lobbyists' PACs collected from others and passed to a campaign or
// leadership PAC. Committees report bundles over an inflation-indexed
// threshold each half-year on FEC Form 3L, one line (SA3L) per bundler. The FEC's API
// doesn't itemize them, so they come from the raw filings.
// https://www.fec.gov/help-candidates-and-committees/lobbyist-bundling-disclosure/
import { titleCase } from "../lib/names.js";
import type { Legislator } from "../lib/legislators.js";
import { download, rows } from "./individuals.js";
import { cachedJson, isoDate, pages, rawFiling } from "./outside.js";

export interface Bundler {
  /** Stable id: the lobbyist PAC's committee id, or a slug of name and employer. */
  id: string;
  name: string;
  type: "lobbyist" | "pac";
  /** For lobbyists: the firm or registrant they work for, as filed. */
  employer?: string;
  occupation?: string;
  /** For lobbyist PACs: their FEC committee id. */
  committee?: string;
  city?: string;
  state?: string;
}

export interface Bundle {
  bundler: string;
  /** The committee that reported it: a campaign or leadership PAC. */
  recipient: string;
  /** Campaign committees: the member it belongs to. Leadership PACs are resolved in the build. */
  member?: string;
  cycle: number;
  amount: number;
  /** The filing it's from, for the link to it on fec.gov. */
  filings: number[];
}

interface Filing {
  committee_id: string;
  file_number: number;
  is_amended: boolean | null;
  most_recent: boolean | null;
  coverage_end_date: string | null;
}

const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function ingestBundling(legislators: Legislator[], cycles: number[]) {
  const byFecId = new Map<string, string>();
  for (const l of legislators) for (const id of l.fec) byFecId.set(id, l.bioguide);

  const bundlers: Record<string, Bundler> = {};
  // bundler|recipient|cycle|half -> semi-annual aggregate seen, period amounts summed
  const halves = new Map<string, { bundler: string; recipient: string; cycle: number; max: number; sum: number; filings: Set<number> }>();
  const campaignOf = new Map<string, string>();

  for (const cycle of cycles) {
    for await (const line of rows(await download(cycle, "ccl"))) {
      const [candId, , , cmteId, , designation] = line.split("|");
      const bioguide = byFecId.get(candId!);
      if (bioguide && (designation === "P" || designation === "A")) campaignOf.set(cmteId!, bioguide);
    }

    const filings = await cachedJson(cycle, "form3l-filings", async () => {
      const out: Filing[] = [];
      for await (const f of pages<Filing>("filings/", { cycle: String(cycle), form_type: "F3L", sort: "beginning_image_number" })) {
        out.push({ committee_id: f.committee_id, file_number: f.file_number, is_amended: f.is_amended, most_recent: f.most_recent, coverage_end_date: f.coverage_end_date });
      }
      return out;
    });
    const latest = [...new Map(filings.filter((f) => !f.is_amended && f.most_recent !== false && f.file_number > 0).map((f) => [f.file_number, f])).values()];
    console.log(`Lobbyist bundling ${cycle}: ${latest.length} Form 3L filings`);

    for (const f of latest) {
      const records = await rawFiling(f.file_number).catch((error: Error) => {
        console.warn(`  ${f.file_number}: ${error.message}`);
        return [];
      });
      const header = records.find((r) => /^F3L[NA]$/.test(r[0] ?? ""));
      // F3L: 16 coverage end. Bundles are reported against half-years.
      const end = isoDate(header?.[16]) ?? isoDate(f.coverage_end_date);
      if (!end) continue;
      const half = Number(end.slice(5, 7)) <= 6 ? "H1" : "H2";
      const year = end.slice(0, 4);

      for (const r of records.filter((x) => x[0] === "SA3L")) {
        // SA3L: 1 recipient, 5 entity, 6 org, 7 last, 8 first, 14 city, 15 state,
        // 20 this period, 21 semi-annual aggregate, 23 employer, 24 occupation,
        // 25 lobbyist PAC id, 26 its name.
        const isPac = r[5] === "PAC" || /^C\d{8}$/i.test(r[25] ?? "");
        const committee = isPac && /^C\d{8}$/i.test(r[25] ?? "") ? r[25]!.toUpperCase() : undefined;
        const person = [r[8], r[7]].filter(Boolean).join(" ");
        const name = isPac ? titleCase(r[26] || r[6] || "") : titleCase(person || r[6] || "");
        if (!name) continue;
        const employer = isPac ? undefined : r[23] ? titleCase(r[23]) : undefined;
        const id = committee ?? slug(`${name} ${employer ?? r[15] ?? ""}`);
        bundlers[id] ??= {
          id,
          name,
          type: isPac ? "pac" : "lobbyist",
          employer,
          occupation: isPac ? undefined : r[24] ? titleCase(r[24]) : undefined,
          committee,
          city: r[14] ? titleCase(r[14]) : undefined,
          state: /^[A-Z]{2}$/.test(r[15] ?? "") ? r[15] : undefined,
        };
        const recipient = (r[1] || header?.[1] || f.committee_id).toUpperCase();
        const key = `${id}|${recipient}|${year}${half}`;
        const h = halves.get(key) ?? { bundler: id, recipient, cycle, max: 0, sum: 0, filings: new Set<number>() };
        h.max = Math.max(h.max, Number(r[21]) || 0);
        h.sum += Number(r[20]) || 0;
        h.filings.add(f.file_number);
        halves.set(key, h);
      }
    }
  }

  // The semi-annual aggregate already adds up the half-year; where a filer
  // left it blank, the period amounts do.
  const bundles = new Map<string, Bundle>();
  for (const h of halves.values()) {
    const amount = Math.max(h.max, h.sum);
    if (amount <= 0) continue;
    const key = `${h.bundler}|${h.recipient}|${h.cycle}`;
    const b = bundles.get(key) ?? { bundler: h.bundler, recipient: h.recipient, member: campaignOf.get(h.recipient), cycle: h.cycle, amount: 0, filings: [] };
    b.amount += amount;
    b.filings = [...new Set([...b.filings, ...h.filings])].sort((x, y) => y - x);
    bundles.set(key, b);
  }
  const list = [...bundles.values()].map((b) => ({ ...b, amount: Math.round(b.amount) }));
  const used = new Set(list.map((b) => b.bundler));
  for (const id of Object.keys(bundlers)) if (!used.has(id)) delete bundlers[id];
  console.log(
    `${Object.keys(bundlers).length} bundlers, $${list.reduce((s, b) => s + b.amount, 0).toLocaleString()} bundled; ` +
      `$${list.filter((b) => b.member).reduce((s, b) => s + b.amount, 0).toLocaleString()} to current members' campaigns`
  );
  return { bundlers, bundles: list };
}
