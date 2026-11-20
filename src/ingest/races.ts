// One federal general election's House and Senate races: every candidate on
// the November ballot, what each raised, who gave, and outside spending for
// and against each. Writes data/races-<year>.json, for each year with a
// data/elections-<year>.json (the facts FEC data doesn't have: dates,
// redistricting, primary systems, specials).
//
// Who was on the ballot, best source first:
//   1. The FEC's list of general-election ballot candidates, compiled from
//      state election offices (election-results.ts), once it's published.
//   2. Until then, the campaigns' own filings: a campaign has to file a
//      pre-general report (12G) for a general election it's on the ballot
//      for, and a post-general one (30G) after. That's a superset (some file
//      after losing a primary), so same-party ties are broken by
//      general-election outside spending, then general-election money given
//      after the primaries; what's left is marked uncertain.
//   3. Where no one filed one, everyone who raised money, and the race says
//      the nominees aren't known.
//
// Who won. Never inferred from money, filings or early returns. Only from
//   - data/race-results-<year>.json: state certifications entered with
//     `pnpm race-results add`, each with the official source,
//   - the FEC's official results compilation, once it's published, and
//   - congress-legislators: a candidate sworn in to the seat on or after the
//     new Congress's first day.
// If two of them disagree, the race stays pending and the run says so.
//
// Money is the election's cycle only, for incumbents too, so candidates
// compare like for like: campaign summaries (weball), PAC contributions
// (pas2), itemized individual donations (indiv) and outside spending (from
// the fec step's per-candidate totals, which include 24/48-hour notices).
import fs from "fs";
import { fecBulk } from "../lib/download.js";
import type { Legislator } from "../lib/legislators.js";
import type { Sector } from "../lib/sectors.js";
import type { CandidateOutside, FecData } from "./fec.js";
import type { Committee, Organization } from "./committees.js";
import { committeeSummaries, pages, cachedJson, parseCsv } from "./outside.js";
import { donationClassifier, mainEntry, rows, type IndividualSector } from "./individuals.js";
import { byCandidate as resultsByCandidate, fecElectionFiles, parseBallot, parseResults, type ResultLine } from "./election-results.js";

/** The hand-entered facts about one election (data/elections-<year>.json). */
export interface Election {
  year: number;
  electionDay: string;
  /** The day the members it elects take office. */
  newCongress: string;
  /** The day after the last regular primary. */
  lateGeneralFrom: string;
  /** House seats per state (the census apportionment): one is an at-large seat. */
  houseSeats: Record<string, number>;
  redistricting: { source: string; sourceName: string; asOf: string; states: Record<string, string> };
  /** Where November isn't a plain party-nominee general: "top-two", "top-four", "louisiana". */
  systems: Record<string, { house?: string; senate?: string }>;
  systemNotes?: Record<string, string>;
  /** General-election runoff dates, by state. */
  runoffs?: Record<string, string>;
  /** States with a Senate special election, and what it fills. */
  senateSpecials?: Record<string, string>;
  /** When each state certifies (null where it isn't posted), and its official results page. */
  certification?: Record<string, { deadline: string | null; results: string }>;
}

export const electionFile = (year: number) => `data/elections-${year}.json`;
export const racesFile = (year: number) => `data/races-${year}.json`;
export const resultsFile = (year: number) => `data/race-results-${year}.json`;
/** Every year with an election file, oldest first. */
export const electionYears = () =>
  fs.readdirSync("data").flatMap((f) => (/^elections-(\d{4})\.json$/.exec(f) ? [Number(f.slice(10, 14))] : [])).sort();
export const loadElection = (year: number): Election => JSON.parse(fs.readFileSync(electionFile(year), "utf8"));

/**
 * Hosts a certification can come from: government domains, plus results
 * sites states run through a vendor and link from their own pages.
 */
const OFFICIAL_HOSTS = [/\.gov$/, /\.us$/, /\.gov\.[a-z]{2}$/, /(^|\.)clarityelections\.com$/, /(^|\.)enr-scvotes\.org$/];
export const isOfficialUrl = (url: string) => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return new URL(url).protocol === "https:" && OFFICIAL_HOSTS.some((re) => re.test(host));
  } catch {
    return false;
  }
};

// --- shapes --------------------------------------------------------------------------

interface Amount {
  id: string;
  total: number;
}

export interface CandidateMoney {
  receipts: number;
  disbursements: number;
  cashOnHand: number;
  individual: number;
  itemized?: number;
  unitemized?: number;
  pac: number;
  party: number;
  /** The candidate's own contributions and loans. */
  candidate: number;
  candidateLoans: number;
  /** The last day the campaign's processed reports cover, YYYY-MM-DD. */
  through?: string;
}

export interface RaceCandidate {
  /** FEC candidate id. */
  id: string;
  /** As filed: "LATIMER, GEORGE". */
  name: string;
  /** FEC party code: DEM, REP, LIB, IND... */
  party?: string;
  /** Incumbent, challenger or open seat, as filed. */
  ici?: "I" | "C" | "O";
  /** A current member of Congress. */
  bioguide?: string;
  /** On the November ballot, by their FEC filings (see the top of this file). */
  onBallot: boolean;
  /** The reports that put them there. */
  reports?: ("12G" | "30G")[];
  /**
   * Filed a general-election report, but so did another candidate of their
   * party, and neither general-election money nor general-election outside
   * spending says which one was the nominee.
   */
  uncertain?: boolean;
  /** Official results, from the FEC's compilation: votes (across party lines), share, and runoff votes. */
  votes?: { votes?: number; pct?: number; runoffVotes?: number };
  committees: string[];
  money?: CandidateMoney;
  /** PAC and other committee contributions, by committee, largest first. */
  pacs: Amount[];
  /** How many committees gave, and their total (pas2; can differ a little from the campaign's own summary). */
  pacCount: number;
  pacTotal: number;
  /** PAC money by sector. */
  pacSectors: Amount[];
  /** Itemized individual donations. */
  individuals?: {
    itemized: number;
    donations: number;
    sectors: { id: IndividualSector | "Unknown"; total: number }[];
    employers: { id: string; name: string; total: number; organization?: string }[];
    places: { inState: number; outOfState: number; unknown: number };
  };
  /** Organization: its PAC plus its employees. */
  contributors: { id: string; name: string; total: number; pacs: number; individuals: number }[];
  combinedSectors: Amount[];
  /** Independent expenditures naming them, this cycle and in the general alone. */
  outside: { support: number; oppose: number; generalSupport: number; generalOppose: number; spenders: { id: string; support: number; oppose: number; generalSupport: number; generalOppose: number }[] };
}

export interface RaceResult {
  /** "upcoming" before Election Day; "pending" until an official source says who won. */
  status: "upcoming" | "pending" | "certified" | "sworn-in" | "runoff";
  /** FEC candidate ids of the winner (or the two in a runoff). */
  winners?: string[];
  /** Who certified it: "the Delaware Department of Elections". */
  source?: string;
  sourceUrl?: string;
  /** The official results that name the winner, when the certification itself doesn't (minutes, a press release, a scan). */
  evidenceUrl?: string;
  /** YYYY-MM-DD */
  date?: string;
  note?: string;
  /** Other official sources that agree. */
  confirmedBy?: { source: string; sourceUrl?: string; date?: string }[];
  /** Official sources that disagreed; the race stays pending until it's sorted out. */
  conflict?: string;
}

export interface Race {
  /** "AZ-04", "AK-AL", "AZ-S". */
  id: string;
  /** URL slug: "az-04", "ak-at-large", "az-senate". */
  slug: string;
  office: "H" | "S";
  state: string;
  /** House: 0 for at-large seats. */
  district?: number;
  /** A delegate's or resident commissioner's seat. */
  delegate?: boolean;
  special?: string;
  system?: string;
  redrawn?: { note: string; source: string };
  /** No current member of the chamber is on the ballot. */
  open: boolean;
  /** Current members of Congress on the ballot here. */
  incumbents: string[];
  /** Where the November candidates come from: the FEC's ballot list, campaigns' filings, or not known. */
  nominees: "ballot" | "filings" | "unknown";
  /** On the ballot first (by money raised), then those who weren't, or aren't known to be. */
  candidates: RaceCandidate[];
  /** Everyone else who registered for this race and raised money, in short. */
  others: { id: string; name: string; party?: string; bioguide?: string; receipts: number }[];
  outside: {
    support: number;
    oppose: number;
    /** Coded to the general election. */
    general: number;
    total: number;
    /** Every spender in the race, by candidate. */
    spenders: { id: string; total: number; general: number; byCandidate: { id: string; support: number; oppose: number }[] }[];
  };
  result: RaceResult;
}

export interface RacesFile {
  generatedAt: string;
  year: number;
  electionDay: string;
  newCongress: string;
  election: Election;
  /** The FEC compilations used, when published. */
  fec?: { ballot?: boolean; results?: boolean };
  races: Race[];
  /** Outside spenders and PACs that don't have a page (not in committees.json): name and kind. */
  committees: Record<string, { name: string; kind: string }>;
  /** Members of Congress who ran, by bioguide: their race. */
  members: Record<string, { race: string; onBallot: boolean }>;
  coverage: Record<string, number>;
}

// --- helpers ---------------------------------------------------------------------------

const pad = (n: number) => String(n).padStart(2, "0");
const DELEGATES = new Set(["DC", "PR", "GU", "VI", "AS", "MP"]);
export const raceId = (office: string, state: string, district?: number) =>
  office === "S" ? `${state}-S` : `${state}-${district ? pad(district) : "AL"}`;
export const raceSlug = (id: string) =>
  id.endsWith("-S") ? `${id.slice(0, 2).toLowerCase()}-senate` : id.endsWith("-AL") ? `${id.slice(0, 2).toLowerCase()}-at-large` : id.toLowerCase();

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const ranked = (m: Map<string, number>, limit = Infinity) =>
  [...m].map(([id, total]) => ({ id, total: Math.round(total) })).filter((x) => x.total > 0).sort((a, b) => b.total - a.total).slice(0, limit);
const add = <K>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) ?? 0) + v);
const isoDate = (mdy: string) => (/^\d\d\/\d\d\/\d{4}$/.test(mdy) ? `${mdy.slice(6)}-${mdy.slice(0, 2)}-${mdy.slice(3, 5)}` : undefined);

/** Bulk file rows, pipe-delimited. */
async function* bulk(year: number, file: string) {
  for await (const line of rows(await fecBulk(year, `${file}${String(year).slice(2)}.zip`))) yield line.split("|");
}

/** Words of a person's name for matching: "SMITH, JOHN R. JR" -> last SMITH, first JOHN. */
function nameParts(raw: string) {
  const [last = "", rest = ""] = raw.toUpperCase().split(",").map((s) => s.trim());
  return { last: last.replace(/[^A-Z' -]/g, "").trim(), first: rest.split(/\s+/)[0]?.replace(/[^A-Z]/g, "") ?? "" };
}

// --- general-election reports ------------------------------------------------------------

interface Report {
  committee_id: string;
  report_type: string;
  coverage_end_date: string | null;
  document_description: string | null;
}

/** Campaign committees that filed a pre- or post-general report this cycle. A few dozen API calls a week at most. */
async function generalReports(year: number) {
  const out: Report[] = [];
  for (const type of ["12G", "30G"]) {
    const list = await cachedJson(year, `reports-${type}`, async () => {
      const got: Report[] = [];
      for await (const r of pages<Report>("reports/house-senate/", { cycle: String(year), report_type: type, sort: "beginning_image_number" })) {
        got.push({ committee_id: r.committee_id, report_type: r.report_type, coverage_end_date: r.coverage_end_date, document_description: r.document_description });
      }
      return got;
    });
    out.push(...list);
  }
  return out;
}

// --- results -------------------------------------------------------------------------------

/** One official source's word on a race. */
export type Claim = { status: "certified" | "runoff" | "sworn-in"; winners: string[]; source: string; sourceUrl?: string; evidenceUrl?: string; date?: string; note?: string };

/**
 * A race's result from every official claim about it, most specific source
 * first. Final results (certified, sworn in) have to agree with each other,
 * and with a runoff the state certified (the winner is one of the two);
 * otherwise the race stays pending with the disagreement noted.
 */
export function reconcile(claims: Claim[], beforeElection: boolean): RaceResult {
  const key = (c: Claim) => [...c.winners].sort().join(",");
  const finals = claims.filter((c) => c.status !== "runoff");
  const runoff = claims.find((c) => c.status === "runoff");
  const disagree =
    new Set(finals.map(key)).size > 1 ? finals.map((c) => `${c.source}: ${c.winners.join(", ")}`).join("; ")
    : runoff && finals[0] && !finals[0].winners.every((w) => runoff.winners.includes(w)) ? `runoff ${runoff.winners.join(", ")} vs ${finals[0].source}: ${finals[0].winners.join(", ")}`
    : undefined;
  if (disagree) return { status: "pending", conflict: disagree };
  if (finals.length) {
    const [first, ...rest] = finals;
    return { ...first!, confirmedBy: rest.length ? rest.map(({ source, sourceUrl, date }) => ({ source, sourceUrl, date })) : undefined };
  }
  if (runoff) return { ...runoff };
  return { status: beforeElection ? "upcoming" : "pending" };
}

// --- the step ----------------------------------------------------------------------------

export async function ingestRaces(
  year: number,
  legislators: Legislator[],
  fec: FecData,
  enriched: { committees: Record<string, Committee>; organizations: Record<string, Organization> },
  /** Committee ids with a page on the site (committees.json). */
  committeePages: Set<string>,
  /** Members who have left Congress (former-members.json), so their candidacies still link to them. */
  former: { bioguide: string; fecIds: string[]; chamber: "house" | "senate"; state: string }[] = []
): Promise<RacesFile> {
  console.log(`Races ${year}`);
  const E = loadElection(year);
  const today = new Date().toISOString().slice(0, 10);
  const byFecId = new Map<string, string>();
  for (const f of former) for (const id of f.fecIds) byFecId.set(id, f.bioguide);
  for (const l of legislators) for (const id of l.fec) byFecId.set(id, l.bioguide);
  const formerById = new Map(former.map((f) => [f.bioguide, f]));
  // Who was in office on Election Day. Once the new Congress is sworn in,
  // the current list has the winners, so incumbency is carried over from the
  // races-<year>.json written before then.
  const newCongress = today >= E.newCongress;
  const before: RacesFile | undefined = fs.existsSync(racesFile(year)) ? JSON.parse(fs.readFileSync(racesFile(year), "utf8")) : undefined;
  const incumbentsBefore = new Map((before?.races ?? []).map((r) => [r.id, r.incumbents]));
  const legislatorById = new Map(legislators.map((l) => [l.bioguide, l]));

  // Candidates for House and Senate this year.
  const candidates = new Map<string, RaceCandidate & { race: string; status: string }>();
  for await (const r of bulk(year, "cn")) {
    const [id, name, party, candYear, state, office, district, ici, status] = r;
    if ((office !== "H" && office !== "S") || Number(candYear) !== year || !state || !id) continue;
    // One-seat states (and delegates) are at large, whatever district number was filed.
    const race = raceId(office, state, office === "H" ? (E.houseSeats[state] === 1 ? 0 : Number(district) || 0) : undefined);
    candidates.set(id, {
      id,
      name: name!,
      party: party || undefined,
      ici: ici === "I" || ici === "C" || ici === "O" ? ici : undefined,
      bioguide: byFecId.get(id),
      onBallot: false,
      committees: [],
      pacs: [],
      pacCount: 0,
      pacTotal: 0,
      pacSectors: [],
      contributors: [],
      combinedSectors: [],
      outside: { support: 0, oppose: 0, generalSupport: 0, generalOppose: 0, spenders: [] },
      race,
      status: status ?? "",
    });
  }

  // Members who filed for a new office under an id congress-legislators
  // doesn't list yet (a House member running for the Senate): match on
  // state, last name and first name or nickname, when exactly one fits.
  const memberIds = new Set([...candidates.values()].flatMap((c) => (c.bioguide ? [c.bioguide] : [])));
  let matchedByName = 0;
  for (const c of candidates.values()) {
    if (c.bioguide) continue;
    const { last, first } = nameParts(c.name);
    const state = c.race.slice(0, 2);
    const fits = legislators.filter(
      (l) =>
        !memberIds.has(l.bioguide) &&
        l.state === state &&
        l.last.toUpperCase().replace(/[^A-Z' -]/g, "") === last &&
        [l.first, l.nickname].some((n) => n && n.toUpperCase().replace(/[^A-Z]/g, "") === first)
    );
    if (fits.length === 1) {
      c.bioguide = fits[0]!.bioguide;
      matchedByName++;
      console.log(`  ${c.id} ${c.name} matched by name to ${fits[0]!.name}`);
    }
  }

  // Campaign committees (principal and authorized).
  const candidatesOf = new Map<string, string[]>();
  for await (const [candId, candYear, , cmteId, , designation] of bulk(year, "ccl")) {
    const c = candidates.get(candId!);
    if (!c || Number(candYear) !== year || (designation !== "P" && designation !== "A")) continue;
    if (!c.committees.includes(cmteId!)) c.committees.push(cmteId!);
    candidatesOf.set(cmteId!, [...(candidatesOf.get(cmteId!) ?? []), candId!]);
  }

  // On the November ballot: their campaign filed a pre- or post-general report.
  // Reports for a special general on another date cover other periods; the
  // pre-general for Nov. 3 covers through Oct. 14.
  // The pre-general report covers through 20 days before the election.
  const preGeneralFrom = new Date(Date.parse(E.electionDay) - 40 * 86400_000).toISOString().slice(0, 10);
  for (const r of await generalReports(year)) {
    const desc = (r.document_description ?? "").toUpperCase();
    if (/SPECIAL|RUNOFF/.test(desc)) continue;
    const end = (r.coverage_end_date ?? "").slice(0, 10);
    if (r.report_type === "12G" && !(end >= preGeneralFrom && end < E.electionDay)) continue;
    for (const id of candidatesOf.get(r.committee_id) ?? []) {
      const c = candidates.get(id)!;
      c.onBallot = true;
      const type = r.report_type as "12G" | "30G";
      if (!c.reports?.includes(type)) (c.reports ??= []).push(type);
    }
  }

  // Campaign totals.
  for await (const r of bulk(year, "weball")) {
    const c = candidates.get(r[0]!);
    if (!c) continue;
    const n = (i: number) => Math.round(Number(r[i]) || 0);
    c.money = {
      receipts: n(5),
      disbursements: n(7),
      cashOnHand: n(10),
      individual: n(17),
      pac: n(25),
      party: n(26),
      candidate: n(11),
      candidateLoans: n(12),
      through: isoDate(r[27] ?? ""),
    };
  }
  const summaries = await committeeSummaries(year);
  for (const c of candidates.values()) {
    if (!c.money) continue;
    for (const id of c.committees) {
      const s = summaries.get(id);
      if (!s) continue;
      c.money.itemized = Math.round((c.money.itemized ?? 0) + s.itemized);
      c.money.unitemized = Math.round((c.money.unitemized ?? 0) + s.unitemized);
    }
  }

  // Committee names and kinds, for PACs and spenders without a page.
  const cm = new Map<string, { name: string; kind: string }>();
  for (const c of Object.values(fec.committees)) cm.set(c.id, { name: c.name, kind: c.kind });
  for await (const [id, name, , , , , , , designation, type] of bulk(year, "cm")) {
    if (cm.has(id!)) continue;
    const kind =
      designation === "D" ? "leadership-pac"
      : ["H", "S", "P"].includes(type!) ? "candidate"
      : ["X", "Y", "Z"].includes(type!) ? "party"
      : ["O", "U", "V", "W"].includes(type!) ? "super-pac"
      : ["N", "Q"].includes(type!) ? "pac"
      : type === "I" || type === "E" ? "non-committee"
      : "other";
    cm.set(id!, { name: name!, kind });
  }
  // Groups that aren't committees (Form 5, ids starting C9) are named in the notices.
  const ieFile = await fecBulk(year, `independent_expenditure_${year}.csv`);
  for (const r of parseCsv(fs.readFileSync(ieFile, "latin1"))) {
    if (r.spe_id && r.spe_nam && !cm.has(r.spe_id)) cm.set(r.spe_id, { name: r.spe_nam, kind: r.spe_id.startsWith("C9") ? "non-committee" : "other" });
  }

  // One person, two candidate ids: the same campaign committee linked to
  // both. Keep the one that's a member, else the one that raised more, and
  // do it before anything is collected by id below, so the committees' PAC
  // money, donations and outside spending land on the id kept.
  const raceOfCand = (c: { race: string }) => c.race;
  /** A merged-away id -> the id kept, so official lists naming either find the candidate. */
  const alias = new Map<string, string>();
  const canon = (id: string) => alias.get(id) ?? id;
  let merged = 0;
  for (const c of [...candidates.values()]) {
    if (!candidates.has(c.id)) continue;
    for (const cmte of [...c.committees]) {
      for (const otherId of candidatesOf.get(cmte) ?? []) {
        const o = candidates.get(otherId);
        if (!o || o.id === c.id || raceOfCand(o) !== raceOfCand(c)) continue;
        const keep = !!o.bioguide !== !!c.bioguide ? (c.bioguide ? c : o) : (c.money?.receipts ?? 0) >= (o.money?.receipts ?? 0) ? c : o;
        const drop = keep === c ? o : c;
        keep.onBallot ||= drop.onBallot;
        for (const id of drop.committees) if (!keep.committees.includes(id)) keep.committees.push(id);
        keep.reports = [...new Set([...(keep.reports ?? []), ...(drop.reports ?? [])])];
        if (!keep.reports.length) delete keep.reports;
        candidates.delete(drop.id);
        alias.set(drop.id, keep.id);
        for (const [from, to] of alias) if (to === drop.id) alias.set(from, keep.id);
        merged++;
      }
    }
  }

  // PAC and committee contributions to the candidates.
  const pacsBy = new Map<string, Map<string, number>>();
  // Money given for the general election after the primaries: only a
  // nominee can take it (a primary loser has to refund general-election
  // money). Every primary but Louisiana's was over by Sept. 15.
  const lateGeneral = new Map<string, number>();
  const isLateGeneral = (pgi: string | undefined, mmddyyyy: string | undefined) => {
    if (!pgi?.startsWith("G") || !mmddyyyy || mmddyyyy.length !== 8) return false;
    const d = `${mmddyyyy.slice(4)}-${mmddyyyy.slice(0, 2)}-${mmddyyyy.slice(2, 4)}`;
    return d >= E.lateGeneralFrom && d <= E.electionDay;
  };
  for await (const r of bulk(year, "pas2")) {
    // Earmark lines are a conduit's voids and refunds, not its money (see fec.ts).
    if ((r[5] !== "24K" && r[5] !== "24Z") || /EARMARK/i.test(r[20] ?? "")) continue;
    const cand = canon(r[16]!);
    if (!candidates.has(cand)) continue;
    if (isLateGeneral(r[3], r[13])) add(lateGeneral, cand, Number(r[14]) || 0);
    let m = pacsBy.get(cand);
    if (!m) pacsBy.set(cand, (m = new Map()));
    add(m, r[0]!, Number(r[14]) || 0);
  }
  const sectorOf = (committee: string): Sector => {
    const e = enriched.committees[committee];
    if (e) return e.sector as Sector;
    const kind = cm.get(committee)?.kind;
    return kind === "party" || kind === "candidate" || kind === "leadership-pac" ? "Party & Candidate Committees" : "Unknown";
  };

  // Itemized individual donations to the campaigns that matter here: anyone
  // on the ballot, or in a race where the nominees aren't known.
  const raceHasBallot = new Set([...candidates.values()].filter((c) => c.onBallot).map((c) => c.race));
  const wanted = (c: RaceCandidate & { race: string }) => c.onBallot || (!raceHasBallot.has(c.race) && (c.money?.receipts ?? 0) > 0) || !!c.bioguide;
  const campaignOf = new Map<string, string>();
  for (const c of candidates.values()) if (wanted(c)) for (const id of c.committees) campaignOf.set(id, c.id);
  const { classify, employerInfo } = donationClassifier(enriched.organizations);
  type Agg = { itemized: number; donations: number; sectors: Map<string, number>; employers: Map<string, number>; places: { inState: number; outOfState: number; unknown: number } };
  const ind = new Map<string, Agg>();
  const indiv = await fecBulk(year, `indiv${String(year).slice(2)}.zip`);
  let seen = 0;
  for await (const line of rows(indiv, mainEntry(indiv))) {
    if (++seen % 10_000_000 === 0) console.log(`  ${(seen / 1e6).toFixed(0)}M individual donation rows`);
    const cand = campaignOf.get(line.slice(0, line.indexOf("|")));
    if (!cand) continue;
    const r = line.split("|");
    const type = r[5]!;
    // Same rules as the members' individuals step.
    if (!["15", "15E", "15J", "22Y"].includes(type)) continue;
    if (r[18] === "X" && type !== "15J") continue;
    if (r[6] && r[6] !== "IND") continue;
    const amount = (Number(r[14]) || 0) * (type === "22Y" ? -1 : 1);
    if (isLateGeneral(r[3], r[13])) add(lateGeneral, cand, amount);
    let a = ind.get(cand);
    if (!a) ind.set(cand, (a = { itemized: 0, donations: 0, sectors: new Map(), employers: new Map(), places: { inState: 0, outOfState: 0, unknown: 0 } }));
    a.itemized += amount;
    a.donations += type === "22Y" ? 0 : 1;
    const home = candidates.get(cand)!.race.slice(0, 2);
    const state = r[9] ?? "";
    if (!/^[A-Z]{2}$/.test(state) || state === "ZZ") a.places.unknown += amount;
    else if (state === home) a.places.inState += amount;
    else a.places.outOfState += amount;
    const classified = classify((r[11] ?? "").trim().toUpperCase(), (r[12] ?? "").trim().toUpperCase());
    if (!classified) continue;
    if (classified.employer) add(a.employers, classified.employer, amount);
    add(a.sectors, classified.sector ?? "Unknown", amount);
  }
  console.log(`  ${(seen / 1e6).toFixed(1)}M rows; itemized donations for ${ind.size} candidates`);

  // Outside spending by candidate, from the fec step, with merged ids' together.
  const outside: Record<string, Record<string, CandidateOutside>> = {};
  for (const [id, byCommittee] of Object.entries(fec.byCandidate?.[year] ?? {})) {
    const target = (outside[canon(id)] ??= {});
    for (const [committee, o] of Object.entries(byCommittee)) {
      const row = (target[committee] ??= { support: 0, oppose: 0, generalSupport: 0, generalOppose: 0 });
      for (const k of ["support", "oppose", "generalSupport", "generalOppose"] as const) row[k] += o[k];
    }
  }

  // Fill in each candidate.
  for (const c of candidates.values()) {
    const pacs = pacsBy.get(c.id) ?? new Map();
    const pacList = ranked(pacs);
    c.pacs = pacList.slice(0, 20);
    c.pacCount = pacList.length;
    c.pacTotal = sum(pacList.map((p) => p.total));
    const pacSectors = new Map<string, number>();
    const pacOrgs = new Map<string, number>();
    for (const p of pacList) {
      add(pacSectors, sectorOf(p.id), p.total);
      const org = enriched.committees[p.id]?.organization;
      if (org) add(pacOrgs, org, p.total);
    }
    c.pacSectors = ranked(pacSectors);

    const a = ind.get(c.id);
    if (a) {
      const employers = ranked(a.employers);
      c.individuals = {
        itemized: Math.round(a.itemized),
        donations: a.donations,
        sectors: ranked(a.sectors) as { id: IndividualSector | "Unknown"; total: number }[],
        employers: employers.slice(0, 20).map((e) => ({ ...e, name: employerInfo.get(e.id)!.name, organization: employerInfo.get(e.id)!.organization })),
        places: { inState: Math.round(a.places.inState), outOfState: Math.round(a.places.outOfState), unknown: Math.round(a.places.unknown) },
      };
      // Organizations: PAC plus employees, as on member pages.
      const contributors = new Map<string, RaceCandidate["contributors"][number]>();
      for (const [id, total] of pacOrgs) contributors.set(id, { id, name: enriched.organizations[id]?.name ?? id, total, pacs: total, individuals: 0 });
      for (const e of employers) {
        const info = employerInfo.get(e.id)!;
        const id = info.organization ?? `employer:${e.id}`;
        const row = contributors.get(id) ?? { id, name: info.organization ? enriched.organizations[info.organization]?.name ?? info.name : info.name, total: 0, pacs: 0, individuals: 0 };
        row.individuals += e.total;
        row.total += e.total;
        contributors.set(id, row);
      }
      c.contributors = [...contributors.values()].sort((x, y) => y.total - x.total).slice(0, 20).map((x) => ({ ...x, total: Math.round(x.total), pacs: Math.round(x.pacs), individuals: Math.round(x.individuals) }));
      const combined = new Map(pacSectors);
      for (const s of c.individuals.sectors) add(combined, s.id, s.total);
      c.combinedSectors = ranked(combined);
    } else {
      c.contributors = [...pacOrgs].map(([id, total]) => ({ id, name: enriched.organizations[id]?.name ?? id, total, pacs: total, individuals: 0 })).sort((x, y) => y.total - x.total).slice(0, 20);
      c.combinedSectors = c.pacSectors;
    }

    const spent = outside[c.id] ?? {};
    const spenders = Object.entries(spent).map(([id, o]) => ({ id, ...o })).sort((x, y) => y.support + y.oppose - (x.support + x.oppose));
    c.outside = {
      support: sum(spenders.map((s) => s.support)),
      oppose: sum(spenders.map((s) => s.oppose)),
      generalSupport: sum(spenders.map((s) => s.generalSupport)),
      generalOppose: sum(spenders.map((s) => s.generalOppose)),
      spenders: spenders.slice(0, 25),
    };
  }

  // The FEC's official compilations, once published: the ballot list
  // decides who was on the ballot in every race it covers, and the results
  // give votes and winners.
  const files = await fecElectionFiles(year);
  const counts = (l: { special: boolean; office: string; state: string }) => !l.special || (l.office === "S" && !!E.senateSpecials?.[l.state]);
  const ballotLines = files.ballot ? parseBallot(files.ballot).filter(counts) : undefined;
  const ballotRaces = new Set<string>();
  /** A line's candidate: by FEC id, else by last name in the race when exactly one fits. */
  const findCandidate = (l: { fecIds: string[]; name: string; office: "H" | "S"; state: string; district?: number }) => {
    const race = raceId(l.office, l.state, E.houseSeats[l.state] === 1 ? 0 : l.district);
    const byId = l.fecIds.map(canon).filter((id) => candidates.get(id)?.race === race);
    if (byId.length) return byId[0];
    const last = l.name.split(",")[0]!.trim().toUpperCase().replace(/[^A-Z' -]/g, "");
    const fits = [...candidates.values()].filter((c) => c.race === race && nameParts(c.name).last === last);
    return fits.length === 1 ? fits[0]!.id : undefined;
  };
  if (ballotLines) {
    const listed = new Set<string>();
    let unmatched = 0;
    for (const l of ballotLines) {
      ballotRaces.add(raceId(l.office, l.state, E.houseSeats[l.state] === 1 ? 0 : l.district));
      const id = findCandidate(l);
      if (id) listed.add(id);
      else unmatched++;
    }
    for (const c of candidates.values()) {
      if (!ballotRaces.has(c.race)) continue;
      c.onBallot = listed.has(c.id);
      delete c.uncertain;
    }
    console.log(`  FEC ballot list: ${ballotLines.length} candidates in ${ballotRaces.size} races; ${unmatched} not matched to an FEC candidate record (write-ins, no FEC filing)`);
  } else console.log("  FEC ballot list not published yet; using campaigns' general-election reports");
  // Results race by race: an FEC id can turn up on another race's lines (a
  // write-in elsewhere, a typo), and its votes mustn't add to the candidate's.
  const resultsByRace = (lines: ResultLine[]) => {
    const groups = new Map<string, ResultLine[]>();
    for (const l of lines) {
      const race = raceId(l.office, l.state, E.houseSeats[l.state] === 1 ? 0 : l.district);
      groups.get(race)?.push(l) ?? groups.set(race, [l]);
    }
    return new Map([...groups].map(([race, ls]) => [race, resultsByCandidate(ls)]));
  };
  const officialByRace = files.results ? resultsByRace(parseResults(files.results).filter(counts)) : undefined;
  if (officialByRace) console.log(`  FEC official results: ${[...officialByRace.values()].reduce((n, m) => n + m.size, 0)} candidates in ${officialByRace.size} races`);
  else console.log("  FEC official results not published yet");

  // General-election reports are a superset: some campaigns file one after
  // losing the primary, or after retiring. Where a party has more than one
  // candidate filing them (outside top-two and top-four states):
  //   1. $10,000+ of general-election outside spending naming a candidate
  //      puts them on the ballot. If that's more than one of them, groups
  //      spent on each in the general, so each was on it (a second party
  //      line, or a party code filed wrong).
  //   2. Otherwise, general-election money given after the primaries (a
  //      primary loser has to refund it): the candidate with five times the
  //      next one's, or every candidate with some, uncertain.
  //   3. Otherwise, all of them, uncertain.
  const fieldOf = new Map<string, (RaceCandidate & { race: string })[]>();
  for (const c of candidates.values()) if (c.onBallot) fieldOf.get(c.race)?.push(c) ?? fieldOf.set(c.race, [c]);
  let dropped = 0;
  let uncertain = 0;
  const keepOnly = (same: RaceCandidate[], keep: RaceCandidate[], unsure: boolean) => {
    for (const c of same) {
      if (!keep.includes(c)) (c.onBallot = false), dropped++;
      else if (unsure) (c.uncertain = true), uncertain++;
    }
  };
  for (const [race, field] of fieldOf) {
    if (ballotRaces.has(race)) continue;
    const system = E.systems[race.slice(0, 2)]?.[race.endsWith("-S") ? "senate" : "house"];
    if (system) continue;
    const byParty = new Map<string, typeof field>();
    for (const c of field) if (c.party) byParty.get(c.party)?.push(c) ?? byParty.set(c.party, [c]);
    for (const [, same] of byParty) {
      if (same.length < 2) continue;
      const spentOn = same.filter((c) => c.outside.generalSupport + c.outside.generalOppose >= 10_000);
      if (spentOn.length) {
        keepOnly(same, spentOn, false);
        continue;
      }
      const late = same.map((c) => ({ c, v: lateGeneral.get(c.id) ?? 0 })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v);
      if (late.length === 1 || (late.length > 1 && late[0]!.v >= 5 * late[1]!.v)) keepOnly(same, [late[0]!.c], false);
      else if (late.length > 1) keepOnly(same, late.map((x) => x.c), true);
      else keepOnly(same, same, true);
    }
  }
  console.log(`  ${merged} duplicate candidate ids merged; ${dropped} general-election filers set aside for another candidate of their party; ${uncertain} left uncertain`);

  // State certifications entered by hand (pnpm race-results add), checked
  // here too: the winners must be candidates in the race, the source an
  // official one.
  const manual = new Map<string, Claim>();
  const entered: Record<string, Claim> = fs.existsSync(resultsFile(year)) ? JSON.parse(fs.readFileSync(resultsFile(year), "utf8")).results ?? {} : {};
  for (const [race, r] of Object.entries(entered)) {
    const problem =
      !["certified", "runoff"].includes(r.status) ? `status "${r.status}"`
      : !r.winners?.length ? "no winners"
      : r.winners.some((w) => candidates.get(canon(w))?.race !== race) ? `winners ${r.winners.join(", ")} aren't all candidates in ${race}`
      : !r.source || !r.date ? "no source or date"
      : !r.sourceUrl || !isOfficialUrl(r.sourceUrl) ? `source ${r.sourceUrl} isn't an official (https, .gov/.us) address`
      : r.evidenceUrl && !isOfficialUrl(r.evidenceUrl) ? `evidence ${r.evidenceUrl} isn't an official address`
      : undefined;
    if (problem) console.warn(`  ${resultsFile(year)}: ${race} ignored: ${problem}`);
    else manual.set(race, { ...r, winners: r.winners.map(canon) });
  }
  const FEC_RESULTS = `https://www.fec.gov/introduction-campaign-finance/election-results-and-voting-information/federal-elections-${year}/`;
  let conflicts = 0;

  // Group into races.
  const byRace = new Map<string, (RaceCandidate & { race: string; status: string })[]>();
  for (const c of candidates.values()) byRace.get(c.race)?.push(c) ?? byRace.set(c.race, [c]);
  const races: Race[] = [];
  const raisedOf = (c: RaceCandidate) => c.money?.receipts ?? 0;
  for (const [id, field] of byRace) {
    const office = id.endsWith("-S") ? "S" : "H";
    const state = id.slice(0, 2);
    const district = office === "H" ? (id.endsWith("-AL") ? 0 : Number(id.slice(3))) : undefined;
    const official = officialByRace?.get(id);
    // Every official claim about who won, before choosing whom to show:
    // a winner is on the ballot whatever the filings suggested.
    const claims: Claim[] = [];
    if (manual.has(id)) claims.push(manual.get(id)!);
    const fecWinners = official ? field.filter((c) => official.get(c.id)?.winner || [...alias].some(([from, to]) => to === c.id && official.get(from)?.winner)) : [];
    if (fecWinners.length) claims.push({ status: "certified", winners: fecWinners.map((c) => c.id), source: `the FEC's official ${year} results, compiled from state election offices`, sourceUrl: FEC_RESULTS });
    const sworn = field.filter((c) => {
      const l = c.bioguide ? legislatorById.get(c.bioguide) : undefined;
      if (!l || !l.termStart || l.termStart < E.newCongress || l.state !== state) return false;
      return office === "S" ? l.chamber === "senate" : l.chamber === "house" && (l.district ?? 0) === district;
    });
    if (sworn.length === 1) {
      claims.push({ status: "sworn-in", winners: [sworn[0]!.id], source: "sworn in to the seat, per congress-legislators", sourceUrl: "https://github.com/unitedstates/congress-legislators", date: legislatorById.get(sworn[0]!.bioguide!)!.termStart });
    }
    for (const w of claims.flatMap((c) => c.winners)) {
      const c = candidates.get(w);
      if (c) c.onBallot = true;
    }
    if (official) {
      for (const c of field) {
        const o = official.get(c.id) ?? [...alias].filter(([, to]) => to === c.id).map(([from]) => official.get(from)).find(Boolean);
        if (o) c.votes = { votes: o.votes, pct: o.pct, runoffVotes: o.runoffVotes };
      }
    }
    // Stray filings for a seat that doesn't exist (an at-large race in a
    // state with districts, a district number past the state's count).
    const seats = E.houseSeats[state] ?? 0;
    if (office === "H" && (district === 0 ? seats > 1 : district! > seats)) {
      if (field.some((c) => c.onBallot || raisedOf(c) > 10_000)) console.log(`  ${id}: no such seat (${state} has ${seats}); ${field.length} candidate records left out`);
      continue;
    }
    // The ballot list covers every general-election race; anything else is a
    // stray filing (a Senate seat that isn't up, an old district).
    if (ballotLines && !ballotRaces.has(id) && !claims.length) continue;
    const ballot = field.filter((c) => c.onBallot);
    const nominees = ballotRaces.has(id) ? "ballot" : ballot.length ? "filings" : "unknown";
    // A race with no money and no one on the ballot by filings is someone's
    // paperwork, not a race (old district numbers, never-run campaigns).
    const active = field.filter((c) => raisedOf(c) > 0 || c.onBallot || (outside[c.id] && Object.keys(outside[c.id]!).length));
    if (!active.length) continue;
    const shown = (nominees !== "unknown" ? ballot : active.filter((c) => raisedOf(c) > 0 || c.bioguide)).sort((a, b) => raisedOf(b) - raisedOf(a));
    if (!shown.length) continue;
    const others = active
      .filter((c) => !shown.includes(c) && raisedOf(c) > 0)
      .sort((a, b) => raisedOf(b) - raisedOf(a))
      .map((c) => ({ id: c.id, name: c.name, party: c.party, bioguide: c.bioguide, receipts: raisedOf(c) }));

    const chamber = office === "S" ? "senate" : "house";
    const sitting = (b: string) => {
      const l = legislatorById.get(b);
      if (l) return l.chamber === chamber && (l.termStart ?? "") < E.newCongress;
      return formerById.get(b)?.chamber === chamber;
    };
    // After the new Congress starts, from the snapshot taken before it; built
    // after the fact with no snapshot, from the FEC's incumbent flag.
    const incumbents =
      newCongress && incumbentsBefore.has(id)
        ? incumbentsBefore.get(id)!
        : newCongress
          ? shown.filter((c) => c.bioguide && c.ici === "I" && (legislatorById.get(c.bioguide)?.chamber ?? formerById.get(c.bioguide)?.chamber) === chamber).map((c) => c.bioguide!)
          : shown.filter((c) => c.bioguide && sitting(c.bioguide)).map((c) => c.bioguide!);

    // Spenders across the race's candidates (everyone, not just those shown).
    const spenders = new Map<string, { id: string; total: number; general: number; byCandidate: Map<string, { support: number; oppose: number }> }>();
    for (const c of active) {
      for (const [sid, o] of Object.entries(outside[c.id] ?? {})) {
        let s = spenders.get(sid);
        if (!s) spenders.set(sid, (s = { id: sid, total: 0, general: 0, byCandidate: new Map() }));
        s.total += o.support + o.oppose;
        s.general += o.generalSupport + o.generalOppose;
        const b = s.byCandidate.get(c.id) ?? { support: 0, oppose: 0 };
        b.support += o.support;
        b.oppose += o.oppose;
        s.byCandidate.set(c.id, b);
      }
    }
    const spenderList = [...spenders.values()]
      .sort((a, b) => b.total - a.total)
      .map((s) => ({ id: s.id, total: s.total, general: s.general, byCandidate: [...s.byCandidate].map(([cid, b]) => ({ id: cid, ...b })) }));

    const result = reconcile(claims, today < E.electionDay);
    if (result.conflict) {
      conflicts++;
      console.warn(`  ${id}: official sources disagree, left pending (${result.conflict})`);
    }

    const general = sum(spenderList.map((s) => s.general));
    const total = sum(spenderList.map((s) => s.total));
    races.push({
      id,
      slug: raceSlug(id),
      office,
      state,
      district,
      delegate: office === "H" && DELEGATES.has(state) ? true : undefined,
      special: office === "S" ? E.senateSpecials?.[state] : undefined,
      system: E.systems[state]?.[office === "S" ? "senate" : "house"],
      redrawn: office === "H" && E.redistricting.states[state] ? { note: E.redistricting.states[state]!, source: E.redistricting.source } : undefined,
      open: incumbents.length === 0,
      incumbents,
      nominees,
      candidates: shown.map(({ race: _r, status: _s, ...c }) => c),
      others,
      outside: {
        support: sum(shown.map((c) => c.outside.support)),
        oppose: sum(shown.map((c) => c.outside.oppose)),
        general,
        total,
        spenders: spenderList,
      },
      result,
    });
  }
  races.sort((a, b) => a.state.localeCompare(b.state) || (a.office === b.office ? (a.district ?? 0) - (b.district ?? 0) : a.office === "S" ? -1 : 1));

  // Sanity: in a party-nominee state, two candidates of one major party on
  // the ballot usually means a fusion line (New York) or a filing mistake.
  for (const r of races) {
    if (r.system || r.nominees !== "filings") continue;
    for (const p of ["DEM", "REP"]) {
      const same = r.candidates.filter((c) => c.party === p);
      if (same.length > 1) console.log(`  ${r.id}: ${same.length} ${p} candidates still on the ballot by filings (${same.map((c) => `${c.name}${c.uncertain ? " ?" : ""}`).join("; ")})`);
    }
  }

  // Names for committees without a page.
  const committees: RacesFile["committees"] = {};
  const need = (id: string) => {
    if (committeePages.has(id) || committees[id]) return;
    committees[id] = cm.get(id) ?? { name: id, kind: "other" };
  };
  for (const r of races) {
    for (const s of r.outside.spenders) need(s.id);
    for (const c of r.candidates) {
      for (const p of c.pacs) need(p.id);
      for (const s of c.outside.spenders) need(s.id);
    }
  }

  const members: RacesFile["members"] = {};
  for (const r of races) {
    for (const c of [...r.candidates, ...r.others]) {
      if (!c.bioguide) continue;
      const onBallot = "onBallot" in c ? c.onBallot : false;
      // A member in two races (a filing left over from the House while running for the Senate): the one they're on the ballot in, else the bigger.
      const prev = members[c.bioguide];
      if (!prev || (onBallot && !prev.onBallot)) members[c.bioguide] = { race: r.id, onBallot };
    }
  }

  const shownCandidates = races.flatMap((r) => r.candidates);
  const coverage = {
    races: races.length,
    house: races.filter((r) => r.office === "H").length,
    senate: races.filter((r) => r.office === "S").length,
    withNominees: races.filter((r) => r.nominees !== "unknown").length,
    fromBallotList: races.filter((r) => r.nominees === "ballot").length,
    candidates: shownCandidates.length,
    onBallot: shownCandidates.filter((c) => c.onBallot).length,
    uncertain: shownCandidates.filter((c) => c.uncertain).length,
    members: shownCandidates.filter((c) => c.bioguide).length,
    challengers: shownCandidates.filter((c) => !c.bioguide).length,
    openSeats: races.filter((r) => r.open).length,
    withResults: races.filter((r) => r.result.status === "certified" || r.result.status === "sworn-in").length,
    runoffs: races.filter((r) => r.result.status === "runoff").length,
    conflicts,
    matchedByName,
    pacsClassified: Math.round((100 * sum(shownCandidates.flatMap((c) => c.pacs.filter((p) => enriched.committees[p.id]).map((p) => p.total)))) / Math.max(1, sum(shownCandidates.flatMap((c) => c.pacs.map((p) => p.total))))),
  };
  console.log(`  ${JSON.stringify(coverage)}`);
  return { generatedAt: new Date().toISOString(), year, electionDay: E.electionDay, newCongress: E.newCongress, election: E, fec: { ballot: !!ballotLines, results: !!officialByRace }, races, committees, members, coverage };
}
