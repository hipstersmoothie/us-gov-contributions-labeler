// Districts and delegations for the member finder and the state pages, from
// data/districts/<congress>.json (pnpm zip-districts) and members.json.
//
// The finder loads only what a lookup needs: one small file of ZIPs per
// three-digit prefix (/data/zips/<congress>/850.json) and the state's
// delegation (/data/delegations/az.json). The Congress is in the ZIP files'
// path, so a new district map gets new URLs.
import fs from "node:fs";
import path from "node:path";
import { CONGRESS } from "../../../src/lib/districts.ts";
import { STATES } from "../../../src/lib/list-specs.ts";
import { members, photoUrl, partyLetter, committeeLabel, committeeHref, spenderType, type Member } from "./data";
import { pacTotal, raisedTotal } from "./derived";
import { shortSector } from "./format";
import type { DelegationFile, MemberSummary, OutsideMoney, RaceLink, StateRaces, ZipFile } from "../islands/find/types";
import { races, raceYear, raceHref, raceName, type Race } from "./races";
import { NO_SENATORS, ordinal, districtName as name } from "../islands/find/core";

export { CONGRESS, STATES, NO_SENATORS };
/** "119th Congress (2025–2027)": the map current members were elected under. */
export const congressName = `${ordinal(CONGRESS)} Congress`;
export const congressYears = `${1787 + 2 * CONGRESS}–${1789 + 2 * CONGRESS}`;

const file: { congress: number; zips: Record<string, Record<string, number>> } = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), `../data/districts/${CONGRESS}.json`), "utf8")
);
if (file.congress !== CONGRESS) throw new Error(`data/districts/${CONGRESS}.json is for the ${file.congress}th Congress`);

/** How many ZIPs the map has, and how many lie in a single district. */
export const zipCoverage = {
  total: Object.keys(file.zips).length,
  single: Object.values(file.zips).filter((parts) => Object.keys(parts).length === 1).length,
};

/** The territories with no ZIP Code Tabulation Areas: each is one delegate's at-large seat. */
const TERRITORY_ZIPS: [string, string, string][] = [
  ["00801", "00851", "VI-0"],
  ["96799", "96799", "AS-0"],
  ["96910", "96932", "GU-0"],
  ["96950", "96952", "MP-0"],
];

/** The ZIP table split by first three digits. */
export function zipFiles(): Map<string, ZipFile> {
  const out = new Map<string, ZipFile>();
  const get = (prefix: string) => {
    let f = out.get(prefix);
    if (!f) out.set(prefix, (f = { congress: CONGRESS, zips: {}, states: [] }));
    return f;
  };
  // Each prefix's state: the one most of its ZIPs are mostly in. (ZIPs near a
  // border reach into the next state, but a prefix belongs to one.)
  const tally = new Map<string, Map<string, number>>();
  for (const [zip, parts] of Object.entries(file.zips)) {
    const prefix = zip.slice(0, 3);
    get(prefix).zips[zip] = Object.entries(parts);
    const st = Object.keys(parts)[0]!.split("-")[0]!;
    const t = tally.get(prefix) ?? new Map<string, number>();
    t.set(st, (t.get(st) ?? 0) + 1);
    tally.set(prefix, t);
  }
  for (const [prefix, t] of tally) out.get(prefix)!.states = [[...t].sort((a, b) => b[1] - a[1])[0]![0]];
  for (const [from, to, key] of TERRITORY_ZIPS) {
    const f = get(from.slice(0, 3));
    (f.ranges ??= []).push([from, to, key]);
  }
  return out;
}

// --- delegations -------------------------------------------------------------------

const NOT_INDUSTRY = new Set(["Unknown", "Party & Candidate Committees", "Retired", "Not employed"]);

/** Every district on this Congress's map, by state, with at-large seats as 0. */
export const districtsByState = new Map<string, number[]>();
for (const parts of Object.values(file.zips)) {
  for (const key of Object.keys(parts)) {
    const [st, d] = key.split("-");
    const list = districtsByState.get(st!) ?? [];
    if (!list.includes(Number(d))) list.push(Number(d));
    districtsByState.set(st!, list);
  }
}
for (const [, , key] of TERRITORY_ZIPS) districtsByState.set(key.split("-")[0]!, [0]);
for (const list of districtsByState.values()) list.sort((a, b) => a - b);

const houseSeat = new Map(members.filter((m) => m.chamber === "house").map((m) => [`${m.state}-${m.district ?? 0}`, m]));
// A House member whose district isn't on the map means the members and the map are
// from different Congresses: say so in the build log.
for (const [key, m] of houseSeat) {
  if (!districtsByState.get(m.state)?.includes(Number(key.split("-")[1]))) {
    console.warn(`! ${m.name} represents ${key}, which isn't on the ${congressName} district map`);
  }
}

/** "District 3", "At large", "Delegate", "Resident Commissioner", "Senator". */
export function seatLabel(m: Pick<Member, "chamber" | "state" | "district">) {
  if (m.chamber === "senate") return "Senator";
  if (m.state === "PR") return "Resident Commissioner";
  if (NO_SENATORS.has(m.state)) return "Delegate";
  return m.district ? `District ${m.district}` : "At large";
}

export function summary(m: Member): MemberSummary {
  const source = m.combinedSectors?.length ? m.combinedSectors : m.sectors;
  return {
    id: m.bioguide,
    name: m.name,
    party: partyLetter(m.party) as MemberSummary["party"],
    partyName: m.party,
    seat: seatLabel(m),
    photo: photoUrl(m.bioguide),
    pac: pacTotal(m),
    raised: raisedTotal(m),
    industries: source.filter((s) => !NOT_INDUSTRY.has(s.id) && s.total > 0).slice(0, 3).map((s) => shortSector(s.id)),
    outside: outsideMoney(m),
  };
}

/** Independent expenditures naming a member, and on their opponents, as the member page counts them. */
export function outsideMoney(m: Member, top = 4): OutsideMoney | undefined {
  const opp = m.opponents ?? { support: 0, oppose: 0 };
  if (m.outside.support + m.outside.oppose + opp.support + opp.oppose <= 0) return undefined;
  return {
    support: m.outside.support,
    oppose: m.outside.oppose,
    opponents: { support: opp.support, oppose: opp.oppose },
    spenders: [...m.outside.spenders]
      .sort((a, b) => b.support + b.oppose - (a.support + a.oppose))
      .slice(0, top)
      .map((x) => ({ id: x.id, name: committeeLabel(x.id), kind: spenderType(x.id), href: committeeHref(x.id), support: x.support, oppose: x.oppose })),
  };
}

export interface Delegation {
  state: string;
  name: string;
  senators: Member[];
  /** By district; undefined where the seat is vacant. */
  house: { district: number; member?: Member }[];
}

export const delegations: Delegation[] = Object.keys(STATES)
  .filter((st) => districtsByState.has(st) || members.some((m) => m.state === st))
  .map((st) => ({
    state: st,
    name: STATES[st]!,
    senators: members.filter((m) => m.state === st && m.chamber === "senate"),
    house: (districtsByState.get(st) ?? []).map((d) => ({ district: d, member: houseSeat.get(`${st}-${d}`) })),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
export const delegationByState = new Map(delegations.map((d) => [d.state, d]));
export const stateSlug = (st: string) => st.toLowerCase();
export const statePath = (st: string) => `/states/${stateSlug(st)}/`;
export const delegationMembers = (d: Delegation) => [...d.senators, ...d.house.flatMap((h) => (h.member ? [h.member] : []))];

export function delegationFile(d: Delegation, list?: string): DelegationFile {
  return {
    state: d.state,
    name: d.name,
    congress: CONGRESS,
    senators: d.senators.map(summary),
    house: Object.fromEntries(d.house.map((h) => [String(h.district), h.member ? summary(h.member) : null])),
    noSenators: NO_SENATORS.has(d.state) || undefined,
    list,
    races: stateRaces(d.state),
  };
}

const racesByState = Map.groupBy(races, (r) => r.state);
const raceLink = (r: Race): RaceLink => ({ label: raceName(r), href: raceHref(r), support: r.outside.support, oppose: r.outside.oppose });

/**
 * A state's races this year. The House races follow the districts on the
 * ballot, so where a state drew new lines they're linked as a list, not
 * matched to the reader's current district.
 */
export function stateRaces(st: string): StateRaces | undefined {
  const list = racesByState.get(st);
  if (!list?.length) return undefined;
  const house = list.filter((r) => r.office === "H");
  const redrawn = house.find((r) => r.redrawn)?.redrawn?.note;
  return {
    year: raceYear,
    senate: list.filter((r) => r.office === "S").map(raceLink),
    house: redrawn ? {} : Object.fromEntries(house.map((r) => [String(r.district ?? 0), raceLink(r)])),
    redrawn,
    index: `/races/${raceYear}/?state=${st}`,
  };
}

/** "Arizona's 3rd district", "Wyoming's at-large seat". */
export const districtName = (st: string, district: number) => name(st, STATES[st] ?? st, district);
