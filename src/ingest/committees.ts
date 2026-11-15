// Figure out who is behind each committee that gives to members, what
// industry they're in, and what they lobby for.
//
// Sources, in order of trust:
//   data/committee-overrides.json  manual fixes
//   FEC committee API              leadership PAC sponsors, affiliations
//   SEC EDGAR                      industry (SIC code) for public companies
//   Lobbying disclosures (lda.gov) issues lobbied on, self-description
//   name keywords                  last resort for associations
//
// Lookups are cached in .cache/enrich for 90 days.
import fs from "fs";
import path from "path";
import { getJson } from "../lib/http.js";
import { mapLimit } from "../lib/async.js";
import { looksLikePac, normalizeOrg, sameOrg, slugify, titleCase } from "../lib/names.js";
import {
  industryIssue,
  sectorForIssues,
  sectorForName,
  sectorForSic,
  type Sector,
} from "../lib/sectors.js";
import type { Legislator } from "../lib/legislators.js";
import type { FecCommittee, FecData } from "./fec.js";

const CACHE_DIR = ".cache/enrich";
const OVERRIDES_FILE = "data/committee-overrides.json";
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

const FEC_API = "https://api.open.fec.gov/v1";
const LDA_API = "https://lda.gov/api/v1";
const SEC_HEADERS = { "User-Agent": process.env.SEC_USER_AGENT ?? "" };
// lda.gov allows ~15 requests/minute anonymously, far more with a free key.
const LDA = process.env.LDA_API_KEY
  ? { intervalMs: 250, headers: { Authorization: `Token ${process.env.LDA_API_KEY}` } }
  : { intervalMs: 4100 };

export interface Lobbying {
  client: string;
  description?: string;
  issues: { code: string; name: string; count: number }[];
  filings: number;
  /** Registered as a lobbying/law firm rather than lobbying for itself. */
  firm?: boolean;
}

export interface SecCompany {
  cik: number;
  name: string;
  ticker?: string;
  sic?: number;
  sicDescription?: string;
}

export type ClassifiedBy =
  | "override"
  | "fec-type"
  | "sec"
  | "name"
  | "lobbying"
  | "none";

export interface Committee extends FecCommittee {
  organization: string;
  sector: Sector;
  industry?: string;
  /** Leadership PACs: the members of Congress who run them. */
  sponsors?: { fecId: string; bioguide?: string }[];
}

export interface Organization {
  id: string;
  name: string;
  sector: Sector;
  industry?: string;
  classifiedBy: ClassifiedBy;
  committees: string[];
  sec?: SecCompany;
  lobbying?: Lobbying;
}

interface Override {
  sector?: Sector;
  industry?: string;
  /** Group this committee under another organization id. */
  organization?: string;
  name?: string;
}

/** A JSON file of key -> { fetchedAt, value } entries. */
class Cache<T> {
  private file: string;
  private entries: Record<string, { fetchedAt: number; value: T }>;

  constructor(name: string) {
    this.file = path.join(CACHE_DIR, `${name}.json`);
    this.entries = fs.existsSync(this.file)
      ? JSON.parse(fs.readFileSync(this.file, "utf8"))
      : {};
  }

  has(key: string) {
    const entry = this.entries[key];
    return !!entry && Date.now() - entry.fetchedAt < MAX_AGE_MS;
  }

  get(key: string) {
    return this.entries[key]?.value;
  }

  set(key: string, value: T) {
    this.entries[key] = { fetchedAt: Date.now(), value };
  }

  save() {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(this.entries));
  }
}

// --- FEC -------------------------------------------------------------------

async function fetchSponsors(ids: string[], cache: Cache<string[]>) {
  const missing = ids.filter((id) => !cache.has(id));
  for (let i = 0; i < missing.length; i += 100) {
    const batch = missing.slice(i, i + 100);
    const qs = new URLSearchParams({
      api_key: process.env.FEC_API_KEY ?? "DEMO_KEY",
      per_page: "100",
    });
    for (const id of batch) qs.append("committee_id", id);

    const res = await getJson<{
      results: { committee_id: string; sponsor_candidate_ids: string[] | null }[];
    }>(`${FEC_API}/committees/?${qs}`, { intervalMs: 1100 });

    for (const id of batch) cache.set(id, []);
    for (const r of res?.results ?? []) {
      cache.set(r.committee_id, r.sponsor_candidate_ids ?? []);
    }
    cache.save();
  }
}

// --- SEC -------------------------------------------------------------------

async function loadSecTickers() {
  const file = path.join(CACHE_DIR, "sec-tickers.json");
  let tickers: Record<string, { cik_str: number; ticker: string; title: string }>;

  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < MAX_AGE_MS) {
    tickers = JSON.parse(fs.readFileSync(file, "utf8"));
  } else {
    tickers =
      (await getJson<typeof tickers>("https://www.sec.gov/files/company_tickers.json", {
        headers: SEC_HEADERS,
      })) ?? {};
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(tickers));
  }

  // The first listing per company is its primary ticker.
  const byName = new Map<string, { cik: number; ticker: string; title: string }>();
  for (const t of Object.values(tickers)) {
    const key = normalizeOrg(t.title);
    if (key && !byName.has(key)) byName.set(key, { cik: t.cik_str, ticker: t.ticker, title: t.title });
  }
  return byName;
}

function findTicker(
  name: string,
  tickers: Map<string, { cik: number; ticker: string; title: string }>,
  allowPrefix: boolean
) {
  // FEC names often trail off into subsidiary noise ("AMAZON COM SERVICES
  // SEPARATE SEGREGATED"), so corporations can match on a leading prefix.
  const tokens = normalizeOrg(name).split(" ");
  const shortest = allowPrefix ? Math.min(2, tokens.length) : tokens.length;
  for (let k = tokens.length; k >= shortest; k--) {
    const match = tickers.get(tokens.slice(0, k).join(" "));
    if (match) return match;
  }
}

async function lookupSec(
  names: string[],
  tickers: Map<string, { cik: number; ticker: string; title: string }>,
  cache: Cache<SecCompany>,
  allowPrefix: boolean
) {
  const match = names.map((n) => findTicker(n, tickers, allowPrefix)).find(Boolean);
  if (!match) return undefined;

  const key = String(match.cik);
  if (!cache.has(key)) {
    const cik = String(match.cik).padStart(10, "0");
    const res = await getJson<{ name: string; sic: string; sicDescription: string }>(
      `https://data.sec.gov/submissions/CIK${cik}.json`,
      { intervalMs: 150, headers: SEC_HEADERS }
    );
    cache.set(key, {
      cik: match.cik,
      name: res?.name ?? match.title,
      ticker: match.ticker,
      sic: res?.sic ? Number(res.sic) : undefined,
      sicDescription: res?.sicDescription || undefined,
    });
  }
  return cache.get(key);
}

// --- Lobbying disclosures --------------------------------------------------

interface LdaFiling {
  client: { name: string; general_description: string | null };
  registrant: { name: string };
  lobbying_activities: { general_issue_code: string; general_issue_code_display: string }[];
}

interface LdaContribution {
  registrant: { name: string };
  pacs: string[];
}

const GENERIC_DESCRIPTION =
  /^(trade association|association|membership (organization|association)|non-?profit|n\/a|none|labor union|professional association|corporation|company)\.?$/i;

const COMMON_FIRST_WORDS = new Set([
  "NATIONAL", "AMERICAN", "AMERICA", "AMERICAS", "ASSOCIATION", "INTERNATIONAL",
  "UNITED", "FEDERATION", "COUNCIL", "ALLIANCE", "SOCIETY", "INSTITUTE",
  "COALITION", "COMMUNITY", "FIRST", "GENERAL", "GLOBAL", "NORTH", "SOUTH",
  "SOUTHERN", "NORTHERN", "WESTERN", "EASTERN", "CENTRAL", "INDEPENDENT",
  "ASSOCIATED", "CONSUMER", "CITIZENS", "FRIENDS", "PEOPLE", "COMMITTEE",
]);

/**
 * lda.gov matches on substrings of the raw name, so try a few spellings:
 * as-is, with "&" for "AND", and the first word alone ("COZEN" finds
 * "COZEN O'CONNOR PC"), leaving sameOrg() to pick the right result.
 */
/** lda.gov's firewall rejects queries containing "admin" with a 403. */
function ldaSafe(name: string) {
  return normalizeOrg(name)
    .split(" ")
    .filter((t) => !/ADMIN/.test(t))
    .join(" ");
}

function ldaQueries(name: string) {
  const query = ldaSafe(name);
  // A lone first word only helps when it's distinctive; "NATIONAL" or
  // "AMERICAN" matches thousands of filings and makes lda.gov crawl.
  const first = query.split(" ")[0]!;
  const useFirst = first.length >= 5 && !COMMON_FIRST_WORDS.has(first) && first !== query;
  return new Set([query, query.replace(/ AND /g, " & "), ...(useFirst ? [first] : [])]);
}

async function ldaFilings(clientName: string): Promise<LdaFiling[]> {
  for (const q of ldaQueries(clientName)) {
    const qs = new URLSearchParams({ client_name: q, page_size: "25" });
    const res = await getJson<{ results: LdaFiling[] }>(`${LDA_API}/filings/?${qs}`, LDA);
    const matches = (res?.results ?? []).filter((f) => sameOrg(f.client.name, clientName));
    if (matches.length) return matches;
  }
  return [];
}

/** Law and lobbying firms show up as registrants, not clients. */
async function ldaRegistrant(name: string) {
  for (const q of ldaQueries(name)) {
    const qs = new URLSearchParams({ registrant_name: q, page_size: "25" });
    const res = await getJson<{ results: { name: string; description: string | null }[] }>(
      `${LDA_API}/registrants/?${qs}`,
      LDA
    );
    const match = res?.results.find((r) => sameOrg(r.name, name));
    if (match) return match;
  }
}

/** The organization a PAC belongs to, per lobbyists' LD-203 reports. */
async function ldaRegistrantForPac(pacName: string) {
  const qs = new URLSearchParams({
    contribution_contributor: ldaSafe(pacName),
    page_size: "10",
  });
  const res = await getJson<{ results: LdaContribution[] }>(
    `${LDA_API}/contributions/?${qs}`,
    LDA
  );
  return res?.results.find((r) => r.pacs.some((p) => sameOrg(p, pacName)))?.registrant.name;
}

async function lookupLobbying(orgName: string, pacName: string, cache: Cache<Lobbying | null>) {
  const key = normalizeOrg(orgName);
  if (!cache.has(key)) {
    let filings = await ldaFilings(orgName);
    if (!filings.length) {
      const registrant = await ldaRegistrantForPac(pacName);
      if (registrant) filings = await ldaFilings(registrant);
    }

    const registrant = filings.length ? undefined : await ldaRegistrant(orgName);
    if (registrant) {
      cache.set(key, {
        client: registrant.name,
        description: registrant.description?.trim() || undefined,
        issues: [],
        filings: 0,
        firm: true,
      });
    } else if (!filings.length) {
      cache.set(key, null);
    } else {
      const issues = new Map<string, { code: string; name: string; count: number }>();
      for (const f of filings) {
        for (const a of f.lobbying_activities) {
          const issue = issues.get(a.general_issue_code) ?? {
            code: a.general_issue_code,
            name: a.general_issue_code_display,
            count: 0,
          };
          issue.count++;
          issues.set(a.general_issue_code, issue);
        }
      }
      const description = filings
        .map((f) => f.client.general_description?.trim())
        .filter((d): d is string => !!d && !GENERIC_DESCRIPTION.test(d))
        .sort((a, b) => b.length - a.length)[0];

      cache.set(key, {
        client: filings[0]!.client.name,
        description,
        issues: [...issues.values()].sort((a, b) => b.count - a.count),
        filings: filings.length,
      });
    }
  }
  return cache.get(key) ?? undefined;
}

// --- Putting it together ---------------------------------------------------

/** "NATIONAL READY MIXED CONCRETE ASSN. PAC" -> "National Ready Mixed Concrete Association" */
function orgNameFromPac(pacName: string) {
  return titleCase(normalizeOrg(pacName));
}

function classify(
  c: FecCommittee,
  parentName: string | undefined,
  sec: SecCompany | undefined,
  lobbying: Lobbying | undefined
): { sector: Sector; industry?: string; classifiedBy: ClassifiedBy } {
  const lobbyingIndustry = (sector: Sector) => lobbying && industryIssue(lobbying.issues, sector);

  if (c.kind === "leadership-pac" || c.kind === "candidate" || c.kind === "party") {
    return { sector: "Party & Candidate Committees", classifiedBy: "fec-type" };
  }
  if (c.orgType === "L") {
    // A union's lobbying issues describe its members' work, not an industry.
    return { sector: "Labor", classifiedBy: "fec-type" };
  }
  if (sec?.sic) {
    return {
      sector: sectorForSic(sec.sic),
      industry: sec.sicDescription,
      classifiedBy: "sec",
    };
  }

  if (lobbying?.firm && /law|legal|attorney|lobby|government relations|public (affairs|policy)|consult/i.test(lobbying.description ?? "")) {
    return { sector: "Lawyers & Lobbyists", industry: lobbying.description, classifiedBy: "lobbying" };
  }

  const nameSector = sectorForName(parentName ?? c.name);
  if (nameSector) return { sector: nameSector, industry: lobbyingIndustry(nameSector), classifiedBy: "name" };

  const issueSector = lobbying && sectorForIssues(lobbying.issues);
  if (issueSector) {
    return { sector: issueSector, industry: lobbyingIndustry(issueSector), classifiedBy: "lobbying" };
  }

  // No company, union or trade group behind it: an ideological or
  // single-issue PAC (or an advocacy group that also lobbies).
  // Membership groups with no industry signal are usually advocacy groups.
  if (!parentName || !c.orgType || c.orgType === "M") {
    return { sector: "Ideological & Single-Issue", classifiedBy: "fec-type" };
  }
  return { sector: "Unknown", classifiedBy: "none" };
}

export async function enrichCommittees(
  fec: FecData,
  legislators: Legislator[],
  options: { minTotal: number }
) {
  const overrides: Record<string, Override> = fs.existsSync(OVERRIDES_FILE)
    ? JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf8"))
    : {};
  const bioguideByFecId = new Map(legislators.flatMap((l) => l.fec.map((id) => [id, l.bioguide])));

  const sponsorCache = new Cache<string[]>("fec-sponsors");
  const secCache = new Cache<SecCompany>("sec");
  const ldaCache = new Cache<Lobbying | null>("lda-v2");

  const totals = new Map(
    Object.entries(fec.contributions).map(([id, byMember]) => [
      id,
      Object.values(byMember).reduce(
        (sum, byCycle) => sum + Object.values(byCycle).reduce((a, b) => a + b, 0),
        0
      ),
    ])
  );

  const all = Object.values(fec.committees);
  const leadership = all.filter((c) => c.kind === "leadership-pac").map((c) => c.id);
  console.log(`Looking up sponsors for ${leadership.length} leadership PACs`);
  await fetchSponsors(leadership, sponsorCache);

  const tickers = await loadSecTickers();
  // The organization FEC says is behind a PAC. Nonconnected PACs sometimes
  // name another PAC here, which doesn't count.
  const declaredParent = (c: FecCommittee) => {
    if (c.kind !== "pac") return undefined;
    if (c.connectedOrg && !looksLikePac(c.connectedOrg)) return c.connectedOrg;
    if (c.orgType) return orgNameFromPac(c.name);
  };
  // Otherwise guess from the PAC's own name ("DELOITTE POLITICAL ACTION
  // COMMITTEE" -> Deloitte) and only keep the guess if SEC or LDA confirm it.
  const guessedParent = (c: FecCommittee) =>
    declaredParent(c) ?? (c.kind === "pac" ? orgNameFromPac(c.name) : undefined);

  const toLookUp = all.filter(
    (c) => c.kind === "pac" && (totals.get(c.id) ?? 0) >= options.minTotal
  );
  const uncached = toLookUp.filter((c) => !ldaCache.has(normalizeOrg(guessedParent(c)!)));
  console.log(
    `Enriching ${toLookUp.length} PACs with a parent organization ` +
      `(${uncached.length} not cached, ~${Math.ceil((uncached.length * 1.3 * LDA.intervalMs) / 60_000)} min)`
  );

  // Look everything up first, a few at a time; lda.gov responses are slow.
  const found = new Map<string, { sec?: SecCompany; lobbying?: Lobbying }>();
  let n = 0;
  await mapLimit(toLookUp, 8, async (c) => {
    const parentName = guessedParent(c)!;
    try {
      const lobbying = await lookupLobbying(parentName, c.name, ldaCache);
      const sec = await lookupSec(
        [parentName, lobbying?.client].filter((x): x is string => !!x),
        tickers,
        secCache,
        c.orgType === "C"
      );
      found.set(c.id, { sec, lobbying });
    } catch (error) {
      // Keep going; the next run will retry anything that failed.
      console.error(`  ${c.name}: ${(error as Error).message}`);
    }
    if (++n % 50 === 0) {
      console.log(`  ${n}/${toLookUp.length}`);
      ldaCache.save();
      secCache.save();
    }
  });
  ldaCache.save();
  secCache.save();

  const committees: Record<string, Committee> = {};
  const organizations: Record<string, Organization> = {};

  for (const c of all.sort((a, b) => (totals.get(b.id) ?? 0) - (totals.get(a.id) ?? 0))) {
    const override = overrides[c.id] ?? {};
    const { sec, lobbying } = found.get(c.id) ?? {};
    const parentName = declaredParent(c) ?? (sec || lobbying ? guessedParent(c) : undefined);

    const classification = classify(c, parentName, sec, lobbying);
    if (override.sector) Object.assign(classification, { sector: override.sector, classifiedBy: "override" });
    if (override.industry) classification.industry = override.industry;

    // Group PACs under the organization behind them. PACs with no parent
    // (ideological, leadership) are their own organization.
    const orgName = override.name ?? titleCase(lobbying?.client ?? parentName ?? c.name);
    const orgId =
      override.organization ??
      (sec ? slugify(sec.name) : parentName ? slugify(parentName) : `${slugify(c.name)}-${c.id.toLowerCase()}`);

    const org = (organizations[orgId] ??= {
      id: orgId,
      name: orgName,
      ...classification,
      committees: [],
      sec,
      lobbying,
    });
    org.committees.push(c.id);

    const sponsors = sponsorCache.get(c.id);
    committees[c.id] = {
      ...c,
      organization: orgId,
      sector: org.sector,
      industry: org.industry,
      sponsors: sponsors?.length
        ? sponsors.map((fecId) => ({ fecId, bioguide: bioguideByFecId.get(fecId) }))
        : undefined,
    };
  }

  const orgs = Object.values(organizations);
  const by = (k: ClassifiedBy) => orgs.filter((o) => o.classifiedBy === k).length;
  console.log(
    `${orgs.length} organizations: ${by("sec")} via SEC, ${by("name")} via name, ` +
      `${by("lobbying")} via lobbying, ${by("fec-type")} via FEC type, ` +
      `${by("override")} overridden, ${by("none")} unknown`
  );

  const orgTotal = (o: Organization) => o.committees.reduce((s, id) => s + (totals.get(id) ?? 0), 0);
  const unknown = orgs.filter((o) => o.sector === "Unknown").sort((a, b) => orgTotal(b) - orgTotal(a));
  if (unknown.length) {
    console.log(`Biggest unclassified (add to ${OVERRIDES_FILE}):`);
    for (const o of unknown.slice(0, 15)) {
      console.log(`  ${o.committees[0]}  $${orgTotal(o).toLocaleString()}  ${o.name}`);
    }
  }

  return { committees, organizations };
}
