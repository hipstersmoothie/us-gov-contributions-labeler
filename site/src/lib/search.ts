// The search index, as compact rows: [type, path id, label, detail, weight].
// The URL is rebuilt from type + id on the client, and weight (money, so
// prominent entries rank first) is rounded to keep the file small.
import { members, organizations, committees, donors, congressCommittees, displayName, kindLabel } from "./data";
import { pacTotal } from "./derived";
import { bills, shortStatus } from "./legislation";
import { countries } from "./fara";
import { activeSponsors, tripsBySponsor } from "./travel";
import { vendors } from "./disbursements";
import { allRaces, candidateRaces, raceName, raceShort, personName, partyName, raised } from "./races";
import type { SearchRow } from "../../server/src/search.ts";

export type { SearchRow, SearchType } from "../../server/src/search.ts";

const w = (n: number) => Math.round(n / 1000);

function rows(limit?: number): SearchRow[] {
  const top = <T,>(list: T[], value: (x: T) => number) =>
    limit ? [...list].sort((a, b) => value(b) - value(a)).slice(0, limit) : list;
  return [
    ...members.map((m): SearchRow => [
      "m",
      m.bioguide,
      m.name,
      `${m.party} · ${m.chamber === "senate" ? `Senator, ${m.state}` : `${m.state}-${m.district ?? "AL"}`}`,
      // Members always outrank everything else.
      1e9 + w(pacTotal(m)),
    ]),
    ...congressCommittees
      .filter((c) => !limit || !c.parent)
      .map((c): SearchRow => ["c", c.id, c.name, c.parent ? "Subcommittee" : "Committee", 5e8]),
    ...top(organizations, (o) => o.total).map((o): SearchRow => ["o", o.id, o.name, o.industry ?? o.sector, w(o.total)]),
    ...top(committees, (c) => c.total + (c.outside ? c.outside.support + c.outside.oppose : 0)).map((c): SearchRow => [
      "p",
      c.id,
      displayName(c.name),
      kindLabel(c.kind),
      w(c.total + (c.outside ? c.outside.support + c.outside.oppose : 0)),
    ]),
    // The number is part of the label so "H.R. 1" finds it too.
    ...bills.map((b): SearchRow => ["b", b.id, `${b.name} (${b.label})`, [b.policyArea, shortStatus(b)].filter(Boolean).join(" · "), b.lobbying.length]),
    ...top(vendors, (v) => v.total).map((v): SearchRow => ["v", v.id, v.name, `Campaign vendor${v.purposes[0] ? ` · ${v.purposes[0].text.toLowerCase()}` : ""}`, w(v.total)]),
    ...countries.map((c): SearchRow => [
      "f",
      c.id,
      c.name,
      c.active ? `${c.active} foreign principal${c.active === 1 ? "" : "s"} with US agents` : "Foreign lobbying",
      c.active,
    ]),
    ...top(activeSponsors, (sp) => tripsBySponsor.get(sp.key)!.length).map((sp): SearchRow => {
      const n = tripsBySponsor.get(sp.key)!.length;
      return ["t", sp.slug, sp.name, `Paid for ${n} ${n === 1 ? "trip" : "trips"} by members and staff`, n];
    }),
    // The short form is part of the label so "AZ-04" finds it too.
    // Newer elections first, so this year's race outranks the last one's.
    ...allRaces.map((r): SearchRow => [
      "r",
      `${r.year}/${r.slug}`,
      `${raceName(r)} (${raceShort(r)})`,
      `${r.year} race · ${r.candidates.slice(0, 3).map(personName).join(", ")}`,
      w(r.outside.total) + r.year * 1e4,
    ]),
    // Candidates who aren't members (members are found as members), by their latest race.
    ...top(
      [...candidateRaces.values()].map((list) => list[0]!).filter(({ c }) => !c.bioguide),
      ({ c }) => raised(c)
    ).map(({ c, race }): SearchRow => ["n", c.id.toLowerCase(), personName(c), `${partyName(c)} · ${race.year} candidate, ${raceShort(race)}`, w(raised(c))]),
    ...top(donors, (d) => d.total).map((d): SearchRow => [
      "d",
      d.id,
      d.name,
      d.type === "individual" ? [d.occupation, d.employer].filter(Boolean).join(", ") || "Individual" : d.type === "committee" ? "Committee" : "Organization",
      w(d.total),
    ]),
  ];
}

/** Everything, for the full results page. */
export const fullIndex = () => rows();
/** The most prominent entries of each kind, for the header autocomplete. */
export const quickIndex = () => rows(400);
