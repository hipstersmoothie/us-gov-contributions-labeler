// Pull LD-203 contribution reports from lda.gov for the feasibility study in
// design/ld203/README.md.
//
// There is no bulk file for LD-203 any more (the Senate's soprweb zips stopped
// in 2022 and the host is gone), so this uses the REST API, filtered to the
// filings that have at least one item of each non-FECA type (he, me, ple,
// pic): a few hundred filings a year instead of ~40,000. Counts for the other
// categories (all filings, FECA, amendments) are one request each.
//
// One request at a time, 4.1 s apart without LDA_API_KEY (anonymous limit is
// 15/minute), 250 ms with one. Every page is cached under .cache/ld203/api/.
//
//   tsx src/scripts/ld203/fetch.ts [--years=2023,2024,2025,2026]
import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import { getJson } from "../../lib/http.js";

import { CACHE, LDA_API, USER_AGENT, TYPES, type Page } from "./common.js";
const LDA: { intervalMs: number; headers: Record<string, string> } = process.env.LDA_API_KEY
  ? { intervalMs: 250, headers: { "User-Agent": USER_AGENT, Authorization: `Token ${process.env.LDA_API_KEY}` } }
  : { intervalMs: 4100, headers: { "User-Agent": USER_AGENT } };


const { values } = parseArgs({ options: { years: { type: "string", default: "2023,2024,2025,2026" } } });
const years = values.years.split(",").map(Number);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);
let requests = 0;

async function cached(name: string, url: string): Promise<Page> {
  const file = path.join(CACHE, name);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  requests++;
  const page = await getJson<Page>(url, LDA);
  if (!page) throw new Error(`404 ${url}`);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(page));
  return page;
}

/** Just the count for a query. */
async function count(name: string, params: Record<string, string>) {
  const qs = new URLSearchParams({ ...params, page_size: "1" });
  const page = await cached(`count_${name}.json`, `${LDA_API}/contributions/?${qs}`);
  log(`count ${name}: ${page.count}`);
  return page.count;
}

const counts: Record<string, number> = {};
for (const year of years) {
  const y = String(year);
  counts[`${y}_all`] = await count(`${y}_all`, { filing_year: y });
  counts[`${y}_mid_year`] = await count(`${y}_mid_year`, { filing_year: y, filing_period: "mid_year" });
  counts[`${y}_year_end`] = await count(`${y}_year_end`, { filing_year: y, filing_period: "year_end" });
  counts[`${y}_feca`] = await count(`${y}_feca`, { filing_year: y, contribution_type: "feca" });
  counts[`${y}_organization`] = await count(`${y}_organization`, { filing_year: y, lobbyist_exclude: "true" });
  counts[`${y}_MA`] = await count(`${y}_MA`, { filing_year: y, filing_type: "MA" });
  counts[`${y}_YA`] = await count(`${y}_YA`, { filing_year: y, filing_type: "YA" });

  for (const type of TYPES) {
    let url: string | null =
      `${LDA_API}/contributions/?` +
      new URLSearchParams({ filing_year: y, contribution_type: type, page_size: "100", ordering: "dt_posted" });
    let n = 1;
    while (url) {
      const page: Page = await cached(`${y}_${type}_p${n}.json`, url);
      if (n === 1) {
        counts[`${y}_${type}`] = page.count;
        log(`${y} ${type}: ${page.count} filings, ${Math.ceil(page.count / page.results.length)} pages of ${page.results.length} (page_size is capped at 25)`);
      }
      url = page.next;
      n++;
    }
  }
}
fs.writeFileSync(path.join(CACHE, "counts.json"), JSON.stringify(counts, null, 2));
log(`done, ${requests} requests this run`);
