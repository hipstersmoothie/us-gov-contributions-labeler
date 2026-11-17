// The 2026 races and their candidates (data/races.json, from the ingest's
// races step), and the helpers the race, candidate and member pages share.
//
// Every lookup is a Map built once here, so a page's frontmatter never scans
// the whole list.
import fs from "node:fs";
import path from "node:path";
import type { Race, RaceCandidate, RacesFile } from "../../../src/ingest/races.ts";
import { STATES } from "../../../src/lib/list-specs.ts";
import { committeeById, memberById, displayName, kindLabel, spenderType, fecCommitteeUrl, type Member } from "./data";
import { candidateName, partyCode } from "./format";

export type { Race, RaceCandidate };

const FILE = path.resolve(process.cwd(), "../data/races.json");
const file: RacesFile = fs.existsSync(FILE)
  ? JSON.parse(fs.readFileSync(FILE, "utf8"))
  : { generatedAt: "", year: 2026, electionDay: "2026-11-03", newCongress: "2027-01-03", races: [], committees: {}, members: {}, coverage: {} };

export const raceYear = file.year;
export const races = file.races;
export const raceCoverage = file.coverage;
export const newCongress = file.newCongress;
export const raceById = new Map(races.map((r) => [r.id, r]));
export const raceBySlug = new Map(races.map((r) => [r.slug, r]));
/** FEC candidate id -> the candidate and their race. */
export const candidateById = new Map(races.flatMap((r) => r.candidates.map((c) => [c.id, { c, race: r }] as const)));

// --- members who left Congress ------------------------------------------------------

type Former = Member & { former: { left: string } };
const FORMER_FILE = path.resolve(process.cwd(), "../data/former-members.json");
export const formerMembers: Former[] = fs.existsSync(FORMER_FILE) ? JSON.parse(fs.readFileSync(FORMER_FILE, "utf8")).members : [];
export const formerById = new Map(formerMembers.map((m) => [m.bioguide, m]));

// --- names and places -----------------------------------------------------------------

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};
export const stateName = (s: string) => STATES[s] ?? s;

/** "Arizona's 4th District", "Alaska At Large", "Arizona Senate". */
export function raceName(r: Race) {
  const state = stateName(r.state);
  if (r.office === "S") return `${state} Senate${r.special ? " (special)" : ""}`;
  if (r.delegate) return `${state} Delegate`;
  return r.district ? `${state}'s ${ordinal(r.district)} District` : `${state} At Large`;
}
/** "AZ-04", "AK at large", "AZ Senate". */
export function raceShort(r: Race) {
  if (r.office === "S") return `${r.state} Senate`;
  return r.district ? `${r.state}-${String(r.district).padStart(2, "0")}` : `${r.state} at large`;
}
/** "House", "Senate", "Delegate". */
export const raceChamber = (r: Race) => (r.office === "S" ? "Senate" : r.delegate ? "House delegate" : "House");
export const raceHref = (r: Race) => `/races/${raceYear}/${r.slug}/`;

/** Display name: the member's name for members, else the FEC filing's name cleaned up. */
export function personName(c: { name: string; bioguide?: string }) {
  const m = c.bioguide ? memberById.get(c.bioguide) ?? formerById.get(c.bioguide) : undefined;
  return m?.name ?? candidateName(c.name);
}
/** D / R / I, or undefined for a party without one (LIB, GRE...). */
export const partyLetterOf = (c: { party?: string; bioguide?: string }) => {
  const m = c.bioguide ? memberById.get(c.bioguide) ?? formerById.get(c.bioguide) : undefined;
  return (m?.party[0] as "D" | "R" | "I" | undefined) ?? (partyCode(c.party) as "D" | "R" | "I" | undefined);
};
const PARTIES: Record<string, string> = {
  DEM: "Democrat", REP: "Republican", IND: "Independent", LIB: "Libertarian", GRE: "Green", CON: "Constitution",
  NPA: "No party", NNE: "No party", UN: "Unaffiliated", OTH: "Other", W: "Write-in", DFL: "Democratic-Farmer-Labor",
  WFP: "Working Families", FWD: "Forward", AIP: "American Independent", UNK: "Party not given",
};
export const partyName = (c: { party?: string; bioguide?: string }) => {
  const m = c.bioguide ? memberById.get(c.bioguide) ?? formerById.get(c.bioguide) : undefined;
  return m?.party ?? (c.party ? PARTIES[c.party] ?? c.party : "Party not given");
};

/** Where a candidate's name links: their member page (current or former), else their candidate page. */
export function candidateHref(c: { id: string; bioguide?: string }) {
  if (c.bioguide && (memberById.has(c.bioguide) || formerById.has(c.bioguide))) return `/members/${c.bioguide}/`;
  return candidateById.has(c.id) ? `/candidates/${c.id.toLowerCase()}/` : `https://www.fec.gov/data/candidate/${c.id}/`;
}

/** Who they are in the race: "Incumbent", "Challenger", or for open seats, "Open seat". */
export function role(c: RaceCandidate, r: Race) {
  if (c.bioguide && r.incumbents.includes(c.bioguide)) return "Incumbent";
  if (c.bioguide && memberById.has(c.bioguide)) {
    const m = memberById.get(c.bioguide)!;
    return m.chamber === "senate" ? "Senator" : `Representative, ${m.state}-${m.district ?? "AL"}`;
  }
  return r.open ? "Open-seat candidate" : "Challenger";
}

/** A spender's name and type, for committees with and without a page here. */
export function spender(id: string) {
  const c = committeeById.get(id);
  if (c) return { label: displayName(c.name), href: `/pacs/${id}/`, kind: spenderType(id) };
  const x = file.committees[id];
  return { label: x ? displayName(x.name) : `FEC committee ${id}`, href: fecCommitteeUrl(id), kind: x ? kindLabel(x.kind) : "" };
}

/** The race a member ran in this year, if any. */
export const raceOfMember = (bioguide: string) => {
  const x = file.members[bioguide];
  return x ? { race: raceById.get(x.race)!, onBallot: x.onBallot } : undefined;
};

// --- money --------------------------------------------------------------------------

export const raised = (c: RaceCandidate) => c.money?.receipts ?? 0;
export const ownMoney = (c: RaceCandidate) => (c.money?.candidate ?? 0) + (c.money?.candidateLoans ?? 0);
export const outsideTotal = (c: RaceCandidate) => c.outside.support + c.outside.oppose;
export const generalOutside = (c: RaceCandidate) => c.outside.generalSupport + c.outside.generalOppose;

/** The money chart's sources, the same split for every candidate, in the member pages' neutral series. */
export const SOURCES = [
  { key: "individual", label: "Individuals", color: "var(--bar)", ink: "var(--on-bar)" },
  { key: "pac", label: "PACs & party", color: "var(--bar-muted)", ink: "var(--on-bar-muted)" },
  { key: "self", label: "Own money", color: "var(--context)", ink: "var(--on-context)" },
];
export function sourceValues(c: RaceCandidate) {
  const m = c.money;
  if (!m) return { individual: 0, pac: 0, self: 0 };
  return { individual: m.individual, pac: m.pac + m.party, self: m.candidate + m.candidateLoans };
}
/** Donations of $200 or less a year, as a share of individual money, when the campaign's summary has it. */
export const smallShare = (c: RaceCandidate) => {
  const m = c.money;
  return m && m.individual > 0 && m.unitemized !== undefined ? Math.min(m.unitemized / m.individual, 1) : undefined;
};

/** Outside spending tiers for the index filter: general-election spending in the race. */
export const TIERS = [
  { id: "10m", label: "$10M+", min: 10_000_000 },
  { id: "1m", label: "$1M–10M", min: 1_000_000 },
  { id: "some", label: "Under $1M", min: 1 },
  { id: "none", label: "None", min: 0 },
] as const;
export const tierOf = (r: Race) => TIERS.find((t) => r.outside.general >= t.min)!.id;

// --- results --------------------------------------------------------------------------

export const PENDING = "Results pending certification";
/** One line on the race's result, never a guess. */
export function resultLine(r: Race) {
  const res = r.result;
  const names = (res.winners ?? []).map((id) => {
    const c = r.candidates.find((x) => x.id === id);
    return c ? personName(c) : id;
  });
  switch (res.status) {
    case "certified":
      return `${names.join(" and ")} won, as certified${res.source ? ` by ${res.source}` : ""}`;
    case "sworn-in":
      return `${names.join(" and ")} won and took office on Jan. 3, 2027`;
    case "runoff":
      return `${names.join(" and ")} advanced to a runoff${res.date ? ` on ${res.date}` : ""}`;
    default:
      return PENDING;
  }
}
export const isWinner = (r: Race, c: RaceCandidate) => (r.result.status === "certified" || r.result.status === "sworn-in") && !!r.result.winners?.includes(c.id);

/** The candidates' letters and surnames, for list rows: "D Stanton · R Cooper". */
export const fieldSummary = (r: Race) =>
  r.candidates
    .slice(0, 4)
    .map((c) => ({ party: partyLetterOf(c), name: personName(c).replace(/,? (Jr\.|Sr\.|II|III|IV)$/, "").split(" ").at(-1)! }));

export { candidateName, partyCode };

/** State names whose House races ran on new maps, for the index's note. */
export const REDRAWN_STATES = [...new Set(races.filter((r) => r.redrawn).map((r) => r.state))].sort().map(stateName);
