// Find a USAspending recipient for each organization in the study's sample:
// the top 200 organizations by contribution total (committees of parties and
// candidates left out) plus the top 100 by lobbying spend. Writes
// .cache/usaspending/matches.json. Run: tsx src/scripts/usaspending/match.ts
import { normalizeOrg, sameOrg, nameSimilarity } from "../../lib/names.js";
import { api, CACHE, readJson, requests, writeJson, type RecipientProfile, type RecipientRow } from "./common.js";

interface Org {
  id: string;
  name: string;
  sector: string;
  industry?: string;
  total: number;
  lobbyingSpend?: { total: number };
  lobbying?: { client: string };
  sec?: { name: string; ticker?: string };
}

export interface Match {
  id: string;
  name: string;
  sector: string;
  industry?: string;
  contributions: number;
  lobbying: number;
  inSample: ("contributions" | "lobbying")[];
  recipient?: {
    id: string;
    name: string;
    level: "P" | "C" | "R";
    uei: string | null;
    duns: string | null;
    matchedOn: string; // which of our names matched
    via: "parent-of-child" | "direct";
    trailing12m: number;
  };
  candidates: number; // rows the keyword search returned
  note?: string;
}

const { organizations } = readJson<{ organizations: Org[] }>("data/organizations.json");

const byContrib = organizations
  .filter((o) => o.sector !== "Party & Candidate Committees")
  .sort((a, b) => b.total - a.total)
  .slice(0, 200);
const byLobby = organizations
  .filter((o) => o.lobbyingSpend?.total)
  .sort((a, b) => b.lobbyingSpend!.total - a.lobbyingSpend!.total)
  .slice(0, 100);
const sample = new Map<string, Match>();
for (const o of byContrib) sample.set(o.id, base(o, "contributions"));
for (const o of byLobby) {
  const m = sample.get(o.id);
  if (m) m.inSample.push("lobbying");
  else sample.set(o.id, base(o, "lobbying"));
}
function base(o: Org, why: "contributions" | "lobbying"): Match {
  return {
    id: o.id,
    name: o.name,
    sector: o.sector,
    industry: o.industry,
    contributions: o.total,
    lobbying: o.lobbyingSpend?.total ?? 0,
    inSample: [why],
    candidates: 0,
  };
}

/** The names we know an organization by: the site's, its LDA client name, its SEC name, and an acronym in parentheses. */
function namesOf(o: Org) {
  const names = [o.name, o.lobbying?.client, o.sec?.name].filter((n): n is string => !!n);
  const acronym = o.name.match(/\(([A-Z]{2,8})\)/)?.[1];
  if (acronym) names.push(acronym);
  return [...new Set(names)];
}

/** Keyword for USAspending's recipient search: the normalized name minus the noise words it strips anyway. */
function keyword(name: string) {
  return normalizeOrg(name).split(" ").slice(0, 6).join(" ");
}

async function search(kw: string): Promise<RecipientRow[]> {
  if (!kw) return [];
  const res = await api<{ results: RecipientRow[] }>("/recipient/", { keyword: kw, limit: 50, sort: "amount", order: "desc" });
  return res.results.filter((r) => typeof r.name === "string" && r.name);
}

async function findRecipient(o: Org): Promise<{ recipient: Match["recipient"]; candidates: number; note?: string }> {
  const names = namesOf(o);
  const seen = new Map<string, RecipientRow>();
  for (const n of names) {
    for (const r of await search(keyword(n))) seen.set(r.id, r);
    if (seen.size) break; // the site's name found something; don't widen
  }
  const rows = [...seen.values()];
  const matching = rows.filter((r) => names.some((n) => sameOrg(n, r.name)));
  const rank = { P: 0, R: 1, C: 2 } as const;
  matching.sort((a, b) => rank[a.recipient_level] - rank[b.recipient_level] || b.amount - a.amount);
  const best = matching[0];
  if (!best) {
    // Close but not equal names, for the hand-review list.
    const near = rows
      .map((r) => ({ r, s: Math.max(...names.map((n) => nameSimilarity(n, r.name))) }))
      .sort((a, b) => b.s - a.s)[0];
    return { recipient: undefined, candidates: rows.length, note: near && near.s >= 0.5 ? `near miss: ${near.r.name} (${near.s.toFixed(2)})` : undefined };
  }
  const matchedOn = names.find((n) => sameOrg(n, best.name))!;
  if (best.recipient_level === "C") {
    // A child whose parent didn't match by name (or wasn't returned): take the parent, since award totals roll up there.
    const prof = await api<RecipientProfile>(`/recipient/duns/${best.id}/?year=latest`);
    if (prof.parent_id && prof.parent_name) {
      return {
        recipient: { id: prof.parent_id, name: prof.parent_name, level: "P", uei: best.uei, duns: best.duns, matchedOn, via: "parent-of-child", trailing12m: best.amount },
        candidates: rows.length,
        note: `child "${best.name}" rolled up to parent "${prof.parent_name}"`,
      };
    }
  }
  return {
    recipient: { id: best.id, name: best.name, level: best.recipient_level, uei: best.uei, duns: best.duns, matchedOn, via: "direct", trailing12m: best.amount },
    candidates: rows.length,
  };
}

const out = `${CACHE}/matches.json`;
const matches: Match[] = [];
let i = 0;
for (const m of sample.values()) {
  const o = organizations.find((x) => x.id === m.id)!;
  const found = await findRecipient(o);
  matches.push({ ...m, ...found });
  i++;
  if (i % 25 === 0) {
    console.log(`${i}/${sample.size} (${requests} requests)`);
    writeJson(out, matches);
  }
}
writeJson(out, matches);
const matched = matches.filter((m) => m.recipient).length;
console.log(`${matched}/${matches.length} matched, ${requests} requests`);
