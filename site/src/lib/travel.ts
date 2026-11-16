// Privately sponsored travel: trips that outside groups paid for, taken by
// current members and their staff this Congress (data/travel.json, from
// src/scripts/travel/build.ts).
import fs from "node:fs";
import path from "node:path";
import { memberById, organizationById, partyLetter, type Member } from "./data";
import type { Trip, Sponsor } from "../../../src/scripts/travel/build.ts";

export type { Trip, Sponsor };

const FILE = path.resolve(process.cwd(), "../data/travel.json");
const file: { generatedAt: string; since: string; sponsors: Sponsor[]; trips: Trip[] } = fs.existsSync(FILE)
  ? JSON.parse(fs.readFileSync(FILE, "utf8"))
  : { generatedAt: new Date(0).toISOString(), since: "2025-01-03", sponsors: [], trips: [] };

// Only trips by offices of current members with a page here.
export const trips = file.trips.filter((t) => memberById.has(t.bioguide));
export const sponsors = file.sponsors;
export const travelSince = file.since;
export const travelUpdated = new Date(file.generatedAt);

export const sponsorByKey = new Map(sponsors.map((s) => [s.key, s]));
export const sponsorBySlug = new Map(sponsors.map((s) => [s.slug, s]));

function groupBy<K>(list: Trip[], keys: (t: Trip) => K[]) {
  const out = new Map<K, Trip[]>();
  for (const t of list) for (const k of keys(t)) out.set(k, [...(out.get(k) ?? []), t]);
  return out;
}
export const tripsByMember = groupBy(trips, (t) => [t.bioguide]);
export const tripsBySponsor = groupBy(trips, (t) => t.sponsors);
/** Sponsors with trips, most trips first. */
export const activeSponsors = sponsors
  .filter((s) => tripsBySponsor.has(s.key))
  .sort((a, b) => tripsBySponsor.get(b.key)!.length - tripsBySponsor.get(a.key)!.length || a.name.localeCompare(b.name));
/** The sponsor record for an organization with a page here, if it paid for trips. */
export const sponsorByOrganization = new Map(activeSponsors.filter((s) => s.organization).map((s) => [s.organization!, s]));

export const sponsorHref = (s: Sponsor) => `/travel/sponsors/${s.slug}/`;
export const organizationOf = (s: Sponsor) => (s.organization ? organizationById.get(s.organization) : undefined);

/** Totals over a list of trips: cost only where the filing's cost was read. */
export function summarize(list: Trip[]) {
  const withCost = list.filter((t) => t.cost);
  return {
    trips: list.length,
    withCost: withCost.length,
    cost: withCost.reduce((s, t) => s + t.cost!.total, 0),
    family: withCost.reduce((s, t) => s + (t.cost!.family ?? 0), 0),
    byMembers: list.filter((t) => t.member).length,
    offices: new Set(list.map((t) => t.bioguide)).size,
    sponsors: new Set(list.flatMap((t) => t.sponsors)).size,
  };
}

/** Offices by party: "14 Democrats and 9 Republicans". */
export function officeParties(list: Trip[]) {
  const v = { D: 0, I: 0, R: 0 };
  for (const id of new Set(list.map((t) => t.bioguide))) {
    const m = memberById.get(id);
    if (m) v[partyLetter(m.party) as keyof typeof v]++;
  }
  const words: [number, string, string][] = [[v.D, "Democrat", "Democrats"], [v.R, "Republican", "Republicans"], [v.I, "independent", "independents"]];
  const parts = words.filter(([n]) => n > 0).map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : (parts[0] ?? "");
}

/** Trips by office party: D, I, R. */
export function partyCounts(list: Trip[]) {
  const v = { D: 0, I: 0, R: 0 };
  for (const t of list) {
    const m = memberById.get(t.bioguide);
    if (m) v[partyLetter(m.party) as keyof typeof v]++;
  }
  return v;
}

/** A long joint sponsor list cut at a comma: "Iowa Renewable Fuels Association, …, and 17 others". */
export function shortSponsorName(name: string, max = 80) {
  if (name.length <= max) return name;
  const parts = name.split(/,\s+(?:and\s+)?/);
  let out = parts[0]!;
  let i = 1;
  while (i < parts.length && out.length + parts[i]!.length + 2 <= max) out += `, ${parts[i++]}`;
  const rest = parts.length - i;
  return rest > 0 ? `${out} and ${rest} ${rest === 1 ? "other" : "others"}` : `${name.slice(0, max - 1)}…`;
}

/** The sponsor names a trip was filed under, linked where we have a page. */
export function tripSponsors(t: Trip) {
  return t.sponsors.map((k) => sponsorByKey.get(k)).filter((s): s is Sponsor => !!s);
}

const MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
/** "Feb. 7–10, 2025", "June 30–July 2, 2025", "Dec. 30, 2025–Jan. 2, 2026": AP style. */
export function tripDates(t: Pick<Trip, "departure" | "return">) {
  const [y1, m1, d1] = t.departure.split("-").map(Number) as [number, number, number];
  const [y2, m2, d2] = (t.return || t.departure).split("-").map(Number) as [number, number, number];
  const a = `${MONTHS[m1 - 1]} ${d1}`;
  if (t.departure === t.return || !t.return) return `${a}, ${y1}`;
  if (y1 !== y2) return `${a}, ${y1}–${MONTHS[m2 - 1]} ${d2}, ${y2}`;
  if (m1 !== m2) return `${a}–${MONTHS[m2 - 1]} ${d2}, ${y2}`;
  return `${a}–${d2}, ${y2}`;
}

export const sinceLabel = (() => {
  const [y, m, d] = travelSince.split("-").map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}, ${y}`;
})();

/** "a staffer, Jane Doe" or the member. */
export function travelerLabel(t: Trip, m?: Member) {
  return t.member ? (m?.name ?? t.traveler) : t.traveler;
}

/** "Members went on 3 of them themselves." / "One was taken by a member." */
export function byMembersSentence(n: number, of: number) {
  if (n === 0) return "";
  if (n === of) return of === 1 ? "A member took it." : "Members took all of them.";
  return n === 1 ? "One was taken by a member." : `Members took ${n.toLocaleString()} of them.`;
}

/** Rows shown before "more", on member and sponsor pages. */
export const TRIPS_SHOWN = 8;
/** Sponsors listed on /travel/ before "more". */
export const SPONSORS_SHOWN = 30;
/** On a sponsor's own page. */
export const SPONSOR_TRIPS_SHOWN = 25;

export const COST_NOTE =
  "Cost is what the sponsor reported paying per traveler for transportation, lodging, meals and other expenses, from its post-travel form. Where the form couldn't be read reliably, no cost is shown; the filing is linked.";
