// How much each organization spent on federal lobbying, from quarterly LD-2
// reports on lda.gov.
//
// An organization that lobbies in-house reports its total expenses, which
// already include what it paid outside firms; firms report their income per
// client. So for each quarter, use the self-filed expenses if there are any,
// otherwise the sum of outside firms' income.
import fs from "fs";
import path from "path";
import { getJson } from "../lib/http.js";
import { mapLimit } from "../lib/async.js";
import { normalizeOrg, sameOrg } from "../lib/names.js";
import type { Organization } from "./committees.js";

const LDA_API = "https://lda.gov/api/v1";
const CACHE_FILE = ".cache/enrich/lobbying-spend.json";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LDA = process.env.LDA_API_KEY
  ? { intervalMs: 250, headers: { Authorization: `Token ${process.env.LDA_API_KEY}` } }
  : { intervalMs: 4100 };

interface Filing {
  filing_year: number;
  filing_period: string;
  filing_type: string;
  dt_posted: string;
  income: string | null;
  expenses: string | null;
  registrant: { id: number; name: string };
  client: { name: string };
}

export interface LobbyingSpend {
  total: number;
  byYear: Record<number, number>;
}

async function fetchSpend(client: string, fromYear: number): Promise<LobbyingSpend> {
  const query = normalizeOrg(client)
    .split(" ")
    .filter((t) => !/ADMIN/.test(t))
    .join(" ");

  // Newest first, so we can stop paging once we're past the window.
  const filings: Filing[] = [];
  let url: string | null =
    `${LDA_API}/filings/?` + new URLSearchParams({ client_name: query, ordering: "-dt_posted", page_size: "100" });
  while (url) {
    const res: { results: Filing[]; next: string | null } | null = await getJson(url, LDA);
    const page: Filing[] = res?.results ?? [];
    filings.push(...page.filter((f) => f.filing_year >= fromYear && sameOrg(f.client.name, client)));
    url = page.length && page.at(-1)!.filing_year >= fromYear ? res!.next : null;
  }

  // Latest version of each registrant's report for each quarter (amendments
  // replace the original).
  const latest = new Map<string, Filing>();
  for (const f of filings) {
    if (f.filing_type === "RR" || f.filing_type.startsWith("R")) continue; // registrations
    const key = `${f.registrant.id}:${f.filing_year}:${f.filing_period}`;
    const prev = latest.get(key);
    if (!prev || prev.dt_posted < f.dt_posted) latest.set(key, f);
  }

  const quarters = new Map<string, { self: number; firms: number; year: number }>();
  for (const f of latest.values()) {
    const key = `${f.filing_year}:${f.filing_period}`;
    const q = quarters.get(key) ?? { self: 0, firms: 0, year: f.filing_year };
    if (sameOrg(f.registrant.name, client)) q.self += Number(f.expenses) || 0;
    else q.firms += Number(f.income) || 0;
    quarters.set(key, q);
  }

  const byYear: Record<number, number> = {};
  for (const q of quarters.values()) {
    byYear[q.year] = (byYear[q.year] ?? 0) + (q.self || q.firms);
  }
  return { total: Object.values(byYear).reduce((a, b) => a + b, 0), byYear };
}

export async function fetchLobbyingSpend(
  organizations: Record<string, Organization>,
  cycles: number[],
  /** Biggest PAC givers go first; whatever doesn't fit is fetched next run. */
  options: { budgetMinutes: number; givingById: Map<string, number> }
) {
  const deadline = Date.now() + options.budgetMinutes * 60_000;
  const fromYear = cycles[0]! - 1;
  const cache: Record<string, { fetchedAt: number; value: LobbyingSpend }> = fs.existsSync(CACHE_FILE)
    ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"))
    : {};
  const save = () => {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  };

  // Organizations that lobby for themselves or hire firms (not the firms).
  const lobbying = Object.values(organizations).filter((o) => o.lobbying && !o.lobbying.firm);
  const todo = lobbying
    .filter((o) => {
      const c = cache[o.lobbying!.client];
      return !c || Date.now() - c.fetchedAt > MAX_AGE_MS;
    })
    .sort((a, b) => (options.givingById.get(b.id) ?? 0) - (options.givingById.get(a.id) ?? 0));
  console.log(
    `Lobbying spending for ${lobbying.length} organizations ` +
      `(${todo.length} to fetch, up to ${options.budgetMinutes} min this run)`
  );

  let done = 0;
  let skipped = 0;
  await mapLimit(todo, 4, async (o) => {
    if (Date.now() > deadline) {
      skipped++;
      return;
    }
    try {
      cache[o.lobbying!.client] = { fetchedAt: Date.now(), value: await fetchSpend(o.lobbying!.client, fromYear) };
    } catch (error) {
      console.error(`  ${o.name}: ${(error as Error).message}`);
    }
    if (++done % 50 === 0) {
      console.log(`  ${done}/${todo.length}`);
      save();
    }
  });
  save();
  if (skipped) console.log(`  ${skipped} left for the next run`);

  const result: Record<string, LobbyingSpend> = {};
  for (const o of lobbying) {
    const spend = cache[o.lobbying!.client]?.value;
    if (spend?.total) result[o.id] = spend;
  }
  return result;
}
