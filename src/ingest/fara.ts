// Foreign lobbying under the Foreign Agents Registration Act, for data/fara.json.
//
//   Registrants, foreign principals, short forms   efile.fara.gov bulk XML
//   Agents' political contributions                FEC itemized individual contributions
//
// Registrants report their political contributions on supplemental
// statements, but only as PDFs (many of them scans), so the contributions
// here come from the FEC's own records instead: donations to current members'
// campaigns from people who filed a FARA short form, while it was in effect,
// who named their FARA registrant as their employer.
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { XMLParser } from "fast-xml-parser";
import { downloadFile } from "../lib/download.js";
import { normalizeOrg, sameOrg, slugify, titleCase, fixCase } from "../lib/names.js";
import type { Legislator } from "../lib/legislators.js";
import { download as fecDownload, rows, mainEntry } from "./individuals.js";
import type { OrganizationRecord } from "./build.js";
import type { Ld2 } from "./legislation.js";

const DIR = ".cache/fara";
const BULK = "https://efile.fara.gov/bulk/zip";
const DAY = 24 * 60 * 60 * 1000;
const FILES = ["Registrants", "ForeignPrincipals", "ShortForms"] as const;

export interface FaraFile {
  generatedAt: string;
  /** When efile.fara.gov last rebuilt the bulk files we read. */
  fetched: string;
  cycles: number[];
  /** Registrations, principals and agents in effect on or after this date are kept. */
  since: string;
  countries: FaraCountry[];
  registrants: FaraRegistrant[];
  principals: FaraPrincipal[];
  /** Agents' donations to current members' campaigns, by bioguide id. */
  gifts: Record<string, FaraGift[]>;
}

export interface FaraCountry {
  id: string;
  name: string;
  /** Principals with a registration in effect now. */
  active: number;
  /** Principals whose registration ended since `since`. */
  ended: number;
  /** Registrants representing an active principal. */
  registrants: number;
}

export interface FaraRegistrant {
  /** FARA registration number. */
  id: string;
  name: string;
  registered: string;
  terminated?: string;
  city?: string;
  state?: string;
  /** People with a short form in effect now. */
  agents: number;
  /** Our organization, when the name matches one. */
  organization?: string;
  /** Its Lobbying Disclosure Act registration, when the name matches one. */
  lda?: { id: number; name: string };
}

export interface FaraPrincipal {
  name: string;
  country: string;
  registrant: string;
  registered: string;
  terminated?: string;
  /** Our organization, when the name matches one. */
  organization?: string;
}

export interface FaraGift {
  /** The agent, as named on their short form. */
  agent: string;
  registrant: string;
  total: number;
  count: number;
  first: string;
  last: string;
  /** The member's committee that got the most, for a link to the FEC's records. */
  committee: string;
}

// --- bulk files --------------------------------------------------------------------------

type Bulk = { rows: Record<string, string>[]; date: Date };
async function bulk(name: (typeof FILES)[number]): Promise<Bulk> {
  const zip = path.join(DIR, `FARA_All_${name}.xml.zip`);
  if (!fs.existsSync(zip) || Date.now() - fs.statSync(zip).mtimeMs > 7 * DAY) {
    console.log(`  downloading FARA_All_${name}.xml.zip`);
    await downloadFile(`${BULK}/FARA_All_${name}.xml.zip`, zip);
  }
  const { execFileSync } = await import("child_process");
  // The files are Windows-1252, whatever the XML declaration says.
  const xml = new TextDecoder("windows-1252").decode(execFileSync("unzip", ["-p", zip], { maxBuffer: 1 << 28 }));
  const parsed = new XMLParser({ parseTagValue: false, trimValues: true }).parse(xml);
  const root = Object.values(parsed).find((v) => typeof v === "object" && v && "ROW" in (v as object)) as { ROW: any[] };
  return { rows: [root.ROW].flat() as Record<string, string>[], date: fs.statSync(zip).mtime };
}

/** MM/DD/YYYY to YYYY-MM-DD. */
function isoDate(s: string | undefined) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s?.trim() ?? "");
  return m ? `${m[3]}-${m[1]}-${m[2]}` : undefined;
}

/** Names the bulk files write in a way that sorts badly or reads oddly. */
const COUNTRY_NAMES: Record<string, string> = {
  "KOREA SOUTH": "South Korea",
  "KOREA NORTH": "North Korea",
  "CONGO DEMOCRATIC REPUBLIC OF THE": "Democratic Republic of the Congo",
  "CONGO REPUBLIC OF THE": "Republic of the Congo",
  "COTE D'IVOIRE (IVORY COAST)": "Côte d’Ivoire",
  "GERMANY FEDERAL REPUBLIC OF": "Germany",
  "BOSNIA & HERZEGOVINA": "Bosnia and Herzegovina",
  "ANTIGUA & BARBUDA": "Antigua and Barbuda",
  "GUADELOUPE & MARTINIQUE": "Guadeloupe and Martinique",
  "GAMBIA THE": "The Gambia",
  "MYANMAR (BURMA)": "Burma",
  "CEYLON (SRI LANKA)": "Sri Lanka",
  "REPUBLIC OF SOUTH SUDAN": "South Sudan",
  "TIMOR-LESTE (EAST TIMOR)": "Timor-Leste",
  "ST. KITTS AND NEVIS": "St. Kitts and Nevis",
  "KOSOVA": "Kosovo",
  "INTERNATIONAL": "International organizations",
  "USSR": "Soviet Union",
};
export function countryName(raw: string) {
  const key = raw.replace(/,/g, "").replace(/\s+/g, " ").trim().toUpperCase();
  return COUNTRY_NAMES[key] ?? titleCase(key).replace(/ & /g, " and ");
}

/** Mixed-case names stay as filed; all-caps ones get title case. */
const display = (name: string) => {
  const n = name.replace(/\s+/g, " ").trim();
  return /[a-z]/.test(n) ? n : fixCase(titleCase(n));
};

// --- matching names to people and firms ---------------------------------------------------

const TITLES = /\b(MR|MRS|MS|MISS|DR|HON|JR|SR|II|III|IV|ESQ|PHD|MD)\b\.?/g;
const plain = (s: string) =>
  s.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(TITLES, " ").replace(/[^A-Z ]/g, " ").replace(/\s+/g, " ").trim();
/** Last names compare without spaces or hyphens: "DE LA CRUZ", "DELACRUZ". */
const lastKey = (s: string) => plain(s).replace(/ /g, "");

/** Generic first words that don't identify a firm on their own. */
const GENERIC = new Set([
  "NATIONAL", "AMERICAN", "GLOBAL", "INTERNATIONAL", "UNITED", "US", "USA", "FIRST", "NEW", "STRATEGIC", "CAPITOL",
  "CAPITAL", "PUBLIC", "GOVERNMENT", "LAW", "OFFICE", "OFFICES", "WASHINGTON", "DC", "POLICY", "CONSULTING", "ADVISORS",
  "PARTNERS", "SELF", "RETIRED", "NONE",
]);

/** Does an FEC employer name the FARA registrant? Their first two words agree, or the employer is
 *  the firm's first word ("BROWNSTEIN"). A firm known by one word must be named exactly. */
export function employerIsFirm(employer: string, firm: string) {
  const tokens = (n: string) => normalizeOrg(n).split(" ").filter((w) => w && w !== "AND" && w !== "OF");
  const a = tokens(employer);
  const b = tokens(firm);
  if (!a.length || !b.length || a[0]!.length < 3 || GENERIC.has(a[0]!)) return false;
  if (sameOrg(employer, firm)) return true;
  if (b.length === 1) return a.length === 1 && a[0] === b[0];
  const n = Math.min(a.length, 2);
  return a.slice(0, n).join(" ") === b.slice(0, n).join(" ");
}

/** A name with only its legal form, punctuation and asides dropped: "Steptoe LLP (FKA Steptoe & Johnson)" -> "STEPTOE". */
export function strictKey(name: string) {
  return name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\([^)]*\)?/g, " ")
    .replace(/[&+]/g, " AND ")
    .replace(/['’]/g, "")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\bCORP\b/g, "CORPORATION")
    .replace(/\b(L ?L ?C|L ?L ?P|INC|P ?C|P ?A|P ?L ?L ?C|LTD|CHARTERED|THE|AND)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

interface Agent {
  first: string;
  last: string;
  name: string;
  registrant: string;
  firms: string[];
  from: string;
  to?: string;
}

// --- FEC ---------------------------------------------------------------------------------

/** The FEC fields we keep: committee, transaction type, entity type, name, employer, date, amount, memo code. */
type FecRow = [string, string, string, string, string, string, string, string];
const personKey = (last: string, first: string) => `${lastKey(last)}|${plain(first).split(" ")[0] ?? ""}`;

/** FEC rows to current members' campaigns from anyone sharing a name with an agent, per cycle. */
async function candidateRows(cycle: number, legislators: Legislator[], names: Set<string>) {
  const [ccl, indiv] = await Promise.all([fecDownload(cycle, "ccl"), fecDownload(cycle, "indiv")]);
  const cache = path.join(DIR, `fec-${cycle}.json`);
  const stamp = `${fs.statSync(indiv).mtimeMs}:${createHash("sha1").update([...names].sort().join()).digest("hex")}`;
  if (fs.existsSync(cache)) {
    const c = JSON.parse(fs.readFileSync(cache, "utf8"));
    if (c.stamp === stamp) return c.rows as { bioguide: string; row: FecRow }[];
  }

  const byFecId = new Map<string, string>();
  for (const l of legislators) for (const id of l.fec) byFecId.set(id, l.bioguide);
  const campaignOf = new Map<string, string>();
  for await (const line of rows(ccl)) {
    const [candId, , , cmteId, , designation] = line.split("|");
    const bioguide = byFecId.get(candId!);
    if (bioguide && (designation === "P" || designation === "A")) campaignOf.set(cmteId!, bioguide);
  }

  console.log(`  FEC individual contributions ${cycle}`);
  const out: { bioguide: string; row: FecRow }[] = [];
  let seen = 0;
  for await (const line of rows(indiv, mainEntry(indiv))) {
    if (++seen % 20_000_000 === 0) console.log(`    ${(seen / 1e6).toFixed(0)}M rows`);
    const bioguide = campaignOf.get(line.slice(0, line.indexOf("|")));
    if (!bioguide) continue;
    const r = line.split("|");
    const [last = "", first = ""] = (r[7] ?? "").split(",");
    if (!names.has(personKey(last, first))) continue;
    out.push({ bioguide, row: [r[0]!, r[5]!, r[6]!, r[7]!, r[11]!, r[13]!, r[14]!, r[18]!] });
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(cache, JSON.stringify({ stamp, rows: out }));
  return out;
}

function fecDate(s: string) {
  return /^\d{8}$/.test(s) ? `${s.slice(4)}-${s.slice(0, 2)}-${s.slice(2, 4)}` : "";
}

// --- ingest ------------------------------------------------------------------------------

export async function ingestFara(
  legislators: Legislator[],
  cycles: number[],
  organizations: OrganizationRecord[],
  /** LD-1/LD-2 filings of the current Congress, for registrants that also lobby under the LDA. */
  ldaFilings: Ld2[]
): Promise<FaraFile> {
  console.log("Foreign lobbying (FARA)");
  const since = `${cycles[0]! - 1}-01-01`;
  const inWindow = (terminated?: string) => !terminated || terminated >= since;

  const [reg, fp, sf] = (await Promise.all(FILES.map(bulk))) as [Bulk, Bulk, Bulk];

  // Registrants that were in effect at some point since `since`.
  const registrants = new Map<string, FaraRegistrant & { business?: string }>();
  for (const r of reg.rows) {
    const terminated = isoDate(r.Termination_Date);
    if (!inWindow(terminated)) continue;
    registrants.set(String(r.Registration_Number), {
      id: String(r.Registration_Number),
      name: display(r.Name ?? ""),
      registered: isoDate(r.Registration_Date)!,
      ...(terminated ? { terminated } : {}),
      ...(r.City ? { city: display(r.City) } : {}),
      ...(r.State ? { state: r.State } : {}),
      agents: 0,
      ...(r.Business_Name ? { business: display(r.Business_Name.replace(/^D\/?B\/?A:?\s*/i, "")) } : {}),
    });
  }

  const principals: FaraPrincipal[] = [];
  for (const r of fp.rows) {
    const terminated = isoDate(r.FP_termination_date);
    const registrant = String(r.Registration_number);
    if (!inWindow(terminated) || !registrants.has(registrant) || !r.Foreign_principal) continue;
    principals.push({
      name: display(r.Foreign_principal),
      country: slugify(countryName(r.Country_location_represented ?? "Unknown")),
      registrant,
      registered: isoDate(r.FP_registration_date)!,
      ...(terminated ? { terminated } : {}),
    });
  }
  const countryLabel = new Map(fp.rows.map((r) => [slugify(countryName(r.Country_location_represented ?? "Unknown")), countryName(r.Country_location_represented ?? "Unknown")]));

  const agents: Agent[] = [];
  for (const r of sf.rows) {
    const to = isoDate(r.Short_form_termination_date);
    const registrant = String(r.Registration_number);
    const firm = registrants.get(registrant);
    if (!inWindow(to) || !firm || !r.Short_form_last_name) continue;
    if (!to) firm.agents++;
    agents.push({
      first: personKey("", r.Short_form_first_name ?? "").slice(1),
      last: lastKey(r.Short_form_last_name),
      name: `${(r.Short_form_first_name ?? "").trim()} ${r.Short_form_last_name.trim()}`.replace(/\s+/g, " "),
      registrant,
      firms: [firm.name, ...(firm.business ? [firm.business] : [])],
      from: isoDate(r.Short_form_date) ?? firm.registered,
      ...(to ? { to } : {}),
    });
  }
  console.log(
    `  ${registrants.size} registrants, ${principals.length} foreign principals, ${agents.length} short-form agents in effect since ${since}`
  );

  // Registrants and principals that are organizations we have, by the same name give or take
  // "LLC" or "Inc." (stricter than normalizeOrg, which would make Brunswick Group Brunswick Corporation).
  const orgByName = new Map<string, string>();
  for (const o of organizations) {
    for (const n of [o.name, o.lobbying?.client]) if (n && strictKey(n)) orgByName.set(strictKey(n), o.id);
  }
  // Or a firm's PAC: "Akin Gump Strauss Hauer & Feld LLP Civic Action Committee".
  const PAC_WORDS = /^( (CIVIC ACTION|POLITICAL ACTION|PAC|EMPLOYEES?|GOOD GOVERNMENT|COMMITTEE|FUND|FOR EFFECTIVE GOVERNMENT|FEDERAL))+$/;
  const pacOrgs = organizations.map((o) => [strictKey(o.name), o.id] as const);
  const orgFor = (...names: (string | undefined)[]) =>
    names
      .map((n) => {
        const key = n ? strictKey(n) : "";
        if (!key) return undefined;
        return orgByName.get(key) ?? pacOrgs.find(([k]) => k.startsWith(key + " ") && PAC_WORDS.test(k.slice(key.length)))?.[1];
      })
      .find(Boolean);
  const ldaByName = new Map<string, { id: number; name: string }>();
  for (const f of ldaFilings) ldaByName.set(strictKey(f.registrant.name), f.registrant);
  for (const r of registrants.values()) {
    const organization = orgFor(r.name, r.business);
    if (organization) r.organization = organization;
    const lda = ldaByName.get(strictKey(r.name)) ?? (r.business ? ldaByName.get(strictKey(r.business)) : undefined);
    if (lda) r.lda = { id: lda.id, name: display(lda.name) };
  }
  for (const p of principals) {
    const organization = orgFor(p.name);
    if (organization) p.organization = organization;
  }

  // Agents' donations to current members, per the FEC.
  const byName = new Map<string, Agent[]>();
  for (const a of agents) byName.set(`${a.last}|${a.first}`, [...(byName.get(`${a.last}|${a.first}`) ?? []), a]);
  const gifts = new Map<string, Map<string, FaraGift & { byCommittee: Map<string, number> }>>();
  let matched = 0;
  for (const cycle of cycles) {
    for (const { bioguide, row } of await candidateRows(cycle, legislators, new Set(byName.keys()))) {
      const [committee, type, entity, name, employer, dt, amt, memo] = row;
      if (!["15", "15E", "15J", "22Y"].includes(type)) continue;
      if (memo === "X" && type !== "15J") continue;
      if (entity && entity !== "IND") continue;
      const [last = "", first = ""] = name.split(",");
      const date = fecDate(dt);
      const agent = byName
        .get(personKey(last, first))
        ?.find((a) => date >= since && date >= a.from && (!a.to || date <= a.to) && a.firms.some((f) => employerIsFirm(employer, f)));
      if (!agent) continue;
      matched++;
      const amount = (Number(amt) || 0) * (type === "22Y" ? -1 : 1);
      const byAgent = gifts.get(bioguide) ?? gifts.set(bioguide, new Map()).get(bioguide)!;
      const key = `${agent.registrant}:${agent.name}`;
      const g = byAgent.get(key) ?? { agent: agent.name, registrant: agent.registrant, total: 0, count: 0, first: date, last: date, committee: "", byCommittee: new Map() };
      g.total += amount;
      if (type !== "22Y") g.count++;
      if (date < g.first) g.first = date;
      if (date > g.last) g.last = date;
      g.byCommittee.set(committee, (g.byCommittee.get(committee) ?? 0) + amount);
      byAgent.set(key, g);
    }
  }

  const giftsOut: Record<string, FaraGift[]> = {};
  for (const [bioguide, byAgent] of gifts) {
    const list = [...byAgent.values()]
      .filter((g) => g.total > 0)
      .map(({ byCommittee, ...g }) => ({
        ...g,
        total: Math.round(g.total),
        committee: [...byCommittee].sort((a, b) => b[1] - a[1])[0]![0],
      }))
      .sort((a, b) => b.total - a.total || a.agent.localeCompare(b.agent));
    if (list.length) giftsOut[bioguide] = list;
  }
  const people = new Set(Object.values(giftsOut).flatMap((l) => l.map((g) => `${g.registrant}:${g.agent}`)));
  const giving = new Set(Object.values(giftsOut).flatMap((l) => l.map((g) => g.registrant)));
  const total = Object.values(giftsOut).flat().reduce((s, g) => s + g.total, 0);
  console.log(
    `  ${matched.toLocaleString()} FEC records from ${people.size} agents to ${Object.keys(giftsOut).length} members, $${total.toLocaleString()}`
  );

  // Countries, by principals in effect now.
  const countries = new Map<string, FaraCountry & { firms: Set<string> }>();
  for (const p of principals) {
    const c = countries.get(p.country) ?? { id: p.country, name: countryLabel.get(p.country)!, active: 0, ended: 0, registrants: 0, firms: new Set() };
    if (p.terminated) c.ended++;
    else {
      c.active++;
      c.firms.add(p.registrant);
    }
    countries.set(p.country, c);
  }

  // Only registrants with a principal in the window are shown.
  const used = new Set(principals.map((p) => p.registrant));
  return {
    generatedAt: new Date().toISOString(),
    fetched: fp.date.toISOString().slice(0, 10),
    cycles,
    since,
    countries: [...countries.values()]
      .map(({ firms, ...c }) => ({ ...c, registrants: firms.size }))
      .sort((a, b) => b.active - a.active || b.ended - a.ended || a.name.localeCompare(b.name)),
    registrants: [...registrants.values()]
      .filter((r) => used.has(r.id) || giving.has(r.id))
      .map(({ business, ...r }) => r)
      .sort((a, b) => Number(b.id) - Number(a.id)),
    principals: principals.sort((a, b) => a.country.localeCompare(b.country) || a.name.localeCompare(b.name)),
    gifts: giftsOut,
  };
}
