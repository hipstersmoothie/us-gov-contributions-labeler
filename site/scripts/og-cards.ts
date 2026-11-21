// Card data for the link-preview images: one small record per page, from the
// same data/*.json and helpers the pages use. Runs after `astro build`; the
// server (site/server) renders a card into a PNG the first time it's asked for.
import fs from "node:fs";
import path from "node:path";
import {
  members,
  organizations,
  committees,
  donors,
  congressCommittees,
  congressCommitteeById,
  memberById,
  committeeById,
  photoUrl,
  partyLetter,
  partySplit,
  seat,
  kindLabel,
  displayName,
  cycleRange,
  type Member,
} from "../src/lib/data";
import { pacPercentile, pacTotal, chamberName, shortSeat } from "../src/lib/derived";
import { sectors } from "../src/lib/sectors";
import { shortSector, money } from "../src/lib/format";
import { hemicycle } from "../src/lib/charts";
import { ogVersion } from "../src/lib/og";
import { bills, congress, ordinal, shortStatus, fmtDate, PATTERN_LABEL, chamberLabel } from "../src/lib/legislation";
import { countries, principalsByCountry, registrantById, activePrincipals, activeRegistrants, giftsTotal, faraSince } from "../src/lib/fara";
import { revolvingStats, lobbyists, membersByStaff, filingYears } from "../src/lib/revolving";
import { trips, activeSponsors, tripsBySponsor, summarize, sinceLabel } from "../src/lib/travel";
import { bundledMembers, bundlingTotal, bundlers, bundlerName } from "../src/lib/bundling";
import { vendors, spendingCycles, spendingMembers, memberSpending, allMembersBuckets, bucketRows, bucketPhrase, payerRow, payersPhrase } from "../src/lib/disbursements";
import { delegations, stateSlug, zipCoverage } from "../src/lib/districts";
import { summarizeState, makeup } from "../src/lib/states";
import { possessive } from "../src/islands/find/core";
import type { Bar, Card, CardsFile, Party, Split } from "../server/src/types";
import { allRaces, racesOf, candidateRaces, raceName, raceShort, raceChamber, stateName, personName, partyLetterOf, partyName, raised, sourceValues, resultLine, noResult, cycleOf, PENDING } from "../src/lib/races";

const OUT_DIR = path.resolve(process.cwd(), "server/data");
const NOT_INDUSTRY = ["Unknown", "Party & Candidate Committees"];

const cards: Record<string, Card> = {};
const party = (m: Member) => partyLetter(m.party) as Party;
const toSplit = (s: ReturnType<typeof partySplit>): Split => ({ D: s.Democrat, I: s.Independent, R: s.Republican });
/** A member as a bar row: "Bernie Sanders", with "I-VT" beside it. */
const memberBar = (r: { id: string; total: number }): Bar[] => {
  const m = memberById.get(r.id);
  return m ? [{ label: m.name, value: r.total, party: party(m), note: shortSeat(m) }] : [];
};

for (const m of members) {
  const rank = pacPercentile(m);
  cards[`member/${m.bioguide}`] = {
    type: "member",
    name: m.name,
    party: party(m),
    partyName: m.party,
    seat: seat(m),
    photo: photoUrl(m.bioguide) ? m.bioguide : undefined,
    pac: pacTotal(m),
    rank: rank.rank,
    of: rank.of,
    peers: m.chamber === "senate" ? "senators" : "House members",
    sectors: m.sectors
      .filter((s) => s.id !== "Unknown" && s.total > 0)
      .slice(0, 4)
      .map((s) => ({ label: shortSector(s.id), value: s.total })),
  };
}

for (const o of organizations) {
  cards[`organization/${o.id}`] = {
    type: "organization",
    name: o.name,
    sector: o.sector,
    total: o.total,
    members: o.recipients.length,
    split: toSplit(partySplit(o.recipients)),
    top: o.recipients.slice(0, 3).flatMap(memberBar),
  };
}

for (const c of committees) {
  const targets = (c.outside?.targets ?? [])
    .slice()
    .sort((a, b) => b.support + b.oppose - (a.support + a.oppose))
    .slice(0, 3)
    .flatMap((t) => {
      const m = memberById.get(t.id);
      return m ? [{ label: m.name, note: shortSeat(m), support: t.support, oppose: t.oppose }] : [];
    });
  const outside = (c.outside?.support ?? 0) + (c.outside?.oppose ?? 0);
  cards[`pac/${c.id}`] = {
    type: "pac",
    name: displayName(c.name),
    kind: kindLabel(c.kind),
    sector: c.sector,
    total: c.total,
    members: c.recipients.length,
    split: toSplit(partySplit(c.recipients)),
    support: c.outside?.support ?? 0,
    oppose: c.outside?.oppose ?? 0,
    targets,
    opponents: !outside && c.opponents ? { support: c.opponents.support, oppose: c.opponents.oppose } : undefined,
  };
}

for (const d of donors) {
  cards[`donor/${d.id}`] = {
    type: "donor",
    name: d.name,
    about:
      d.type === "individual"
        ? [d.occupation, d.employer, d.state].filter(Boolean).join(" · ")
        : d.type === "committee"
          ? "Political committee"
          : "Organization",
    total: d.total,
    groups: d.gifts.length,
    gifts: d.gifts.slice(0, 4).map((g) => {
      const c = committeeById.get(g.id);
      return { label: c ? displayName(c.name) : `FEC committee ${g.id}`, value: g.total };
    }),
  };
}

for (const s of sectors) {
  cards[`sector/${s.slug}`] = {
    type: "sector",
    name: s.name,
    total: s.total,
    orgs: s.organizations.length,
    members: s.recipients.length,
    split: toSplit(s.split),
    top: [...s.organizations]
      .sort((a, b) => b.total - a.total)
      .slice(0, 3)
      .map((o) => ({ label: o.name, value: o.total })),
  };
}

for (const c of congressCommittees) {
  const seated = c.members.flatMap((s) => {
    const m = memberById.get(s.bioguide);
    return m ? [{ ...s, m }] : [];
  });
  const counts: Split = { D: 0, I: 0, R: 0 };
  for (const s of seated) counts[party(s.m)]++;
  // Same seat order as the page's hemicycle: Democrats from the left.
  const order = { D: 0, I: 1, R: 2 };
  const ordered = [...seated].sort((a, b) => order[party(a.m)] - order[party(b.m)]);
  const { seats, gap } = hemicycle(ordered.length);
  const sum = (list: Member[]) => {
    const out = new Map<string, number>();
    for (const m of list) for (const x of m.sectors) out.set(x.id, (out.get(x.id) ?? 0) + x.total);
    return out;
  };
  const mine = sum(seated.map((s) => s.m));
  const base = sum(c.chamber === "joint" ? members : members.filter((m) => m.chamber === c.chamber));
  // Shares of all PAC money, as the committee page shows them; only the top sector has to be an industry.
  const mineTotal = [...mine.values()].reduce((a, b) => a + b, 0);
  const baseTotal = [...base.values()].reduce((a, b) => a + b, 0);
  const top = [...mine].filter(([id]) => !NOT_INDUSTRY.includes(id)).sort((a, b) => b[1] - a[1])[0];
  cards[`committee/${c.id}`] = {
    type: "committee",
    name: c.name,
    parent: c.parent ? congressCommitteeById.get(c.parent)?.name : undefined,
    chamber: { house: "House", senate: "Senate", joint: "Joint" }[c.chamber],
    seats: ordered.map((s, i) => ({
      x: Math.round(seats[i]!.x * 1000) / 1000,
      y: Math.round(seats[i]!.y * 1000) / 1000,
      party: party(s.m),
      lead: !!s.title && /^(Chair|Chairman|Ranking Member)$/i.test(s.title),
    })),
    gap,
    counts,
    total: seated.reduce((a, s) => a + pacTotal(s.m), 0),
    lean: top && mineTotal ? { sector: shortSector(top[0]), share: top[1] / mineTotal, base: (base.get(top[0]) ?? 0) / (baseTotal || 1) } : undefined,
  };
}

for (const b of bills) {
  const v = b.votes.at(-1)!;
  // Independents' row says who they caucus with.
  const caucuses = [...new Set(Object.values(v.caucus ?? {}))];
  const status = b.law ? "Became law" : shortStatus(b).replace(/^(Passed|Failed in) /, "$1 the ");
  cards[`bill/${b.id}`] = {
    type: "bill",
    label: b.label,
    name: b.name,
    policyArea: b.policyArea,
    status,
    congress: `${ordinal(congress)} Congress`,
    vote: {
      chamber: chamberLabel(v.chamber),
      date: fmtDate(v.date, true),
      pattern: PATTERN_LABEL[v.pattern],
      rows: (["D", "I", "R"] as Party[])
        .filter((p) => v.tally[p])
        .map((p) => ({
          party: p,
          ...v.tally[p]!,
          note: p === "I" && caucuses.length === 1 ? `caucus${Object.keys(v.caucus!).length === 1 ? "es" : ""} with ${caucuses[0] === "D" ? "Democrats" : "Republicans"}` : undefined,
        })),
    },
    lobbying: b.lobbying.length,
    // Named it in the most quarterly reports.
    top: [...b.lobbying]
      .sort((x, y) => y.quarters.length - x.quarters.length || Number(!!y.org) - Number(!!x.org))
      .slice(0, 3)
      .map((c) => ({ label: c.name, reports: c.quarters.length })),
  };
}

const faraSpan = `${faraSince.slice(0, 4)}–${new Date().getFullYear()}`;
for (const c of countries) {
  cards[`country/${c.id}`] = {
    type: "country",
    name: c.name,
    active: c.active,
    ended: c.ended,
    registrants: c.registrants,
    span: faraSpan,
    principals: (principalsByCountry.get(c.id) ?? [])
      .filter((p) => !p.terminated)
      .sort((a, b) => b.registered.localeCompare(a.registered))
      .slice(0, 4)
      .map((p) => ({ label: p.name, note: registrantById.get(p.registrant)?.name ?? "" })),
  };
}

for (const d of delegations) {
  const s = summarizeState(d);
  const who = d.senators.length ? "members of Congress" : d.state === "PR" ? "resident commissioner" : "delegate";
  const order = { D: 0, I: 1, R: 2 };
  cards[`state/${stateSlug(d.state)}`] = {
    type: "state",
    name: d.name,
    title: `Who funds ${possessive(d.state, d.name)} ${who}?`,
    makeup: makeup(s),
    seats: s.members.map(party).sort((a, b) => order[a] - order[b]),
    counts: { D: s.counts.D, I: s.counts.I, R: s.counts.R },
    pac: s.pac,
    sectors: [...s.members.reduce((acc, m) => {
      for (const x of m.sectors) if (!NOT_INDUSTRY.includes(x.id) && x.total > 0) acc.set(x.id, (acc.get(x.id) ?? 0) + x.total);
      return acc;
    }, new Map<string, number>())]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([id, total]) => ({ label: shortSector(id), value: total })),
  };
}

// --- section and static pages ------------------------------------------------------

const pacMoney = members.reduce((a, m) => a + pacTotal(m), 0);
const top = <T,>(list: T[], value: (x: T) => number, n = 5) => [...list].sort((a, b) => value(b) - value(a)).slice(0, n);

cards["page/members"] = {
  type: "page",
  kicker: "Members of Congress",
  title: "Every member, and who funds them",
  dek: `${members.length} current members took ${money(pacMoney, true)} from PACs, ${cycleRange}.`,
  barsTitle: "Most PAC money",
  bars: top(members, pacTotal, 4).map((m) => ({ label: m.name, value: pacTotal(m), party: party(m), note: `${chamberName(m)}, ${m.state}` })),
};
cards["page/organizations"] = {
  type: "page",
  kicker: "Organizations",
  title: "The companies, unions and groups that fund Congress",
  dek: `${organizations.filter((o) => o.total > 0).length.toLocaleString()} organizations whose PACs gave to current members, ${cycleRange}.`,
  barsTitle: "Gave the most",
  bars: top(organizations, (o) => o.total, 4).map((o) => ({ label: o.name, value: o.total })),
};
cards["page/sectors"] = {
  type: "page",
  kicker: "Sectors",
  title: "PAC money to Congress, by industry",
  dek: `${money(sectors.reduce((a, s) => a + s.total, 0), true)} from ${sectors.length} sectors, ${cycleRange}.`,
  barsTitle: "Biggest sectors",
  bars: sectors.filter((s) => !NOT_INDUSTRY.includes(s.name)).slice(0, 4).map((s) => ({ label: shortSector(s.name), value: s.total })),
};
const topCommittees = congressCommittees.filter((c) => !c.parent);
const committeeMoney = (c: (typeof congressCommittees)[number]) =>
  c.members.reduce((a, s) => a + (memberById.has(s.bioguide) ? pacTotal(memberById.get(s.bioguide)!) : 0), 0);
cards["page/committees"] = {
  type: "page",
  kicker: "Committees",
  title: "Where members sit, and who funds them",
  dek: `${topCommittees.length} committees and ${congressCommittees.length - topCommittees.length} subcommittees in the House, Senate and joint.`,
  barsTitle: "PAC money to their members",
  bars: top(topCommittees, committeeMoney, 4).map((c) => ({ label: c.name.replace(/^(House|Senate) Committee on /, ""), value: committeeMoney(c), note: { house: "House", senate: "Senate", joint: "Joint" }[c.chamber] })),
};
const passageVotes = bills.flatMap((b) => b.votes);
const patternShare = (p: string) => `${Math.round((100 * passageVotes.filter((v) => v.pattern === p).length) / Math.max(passageVotes.length, 1))}%`;
cards["page/bills"] = {
  type: "page",
  kicker: "Bills",
  title: "What Congress voted on",
  dek: `Every bill the ${ordinal(congress)} Congress voted on passing, how each party voted, and who lobbied on it.`,
  stats: [
    { label: "Bills voted on", value: bills.length.toLocaleString() },
    { label: "Became law", value: bills.filter((b) => b.law).length.toLocaleString() },
    { label: "Party-line votes", value: patternShare("party-line") },
  ],
};
cards["page/donors"] = {
  type: "page",
  kicker: "Big donors",
  title: "Who funds the super PACs",
  dek: `${donors.length.toLocaleString()} people and groups who gave big to the super PACs that spend on Congress, ${cycleRange}.`,
  barsTitle: "Gave the most",
  bars: top(donors, (d) => d.total, 4).map((d) => ({ label: d.name, value: d.total })),
};
cards["page/revolving-door"] = {
  type: "page",
  kicker: "The revolving door",
  title: "Former congressional staff who now lobby",
  dek: `Lobbyists list the government jobs they held before. Of ${revolvingStats.lobbyists.toLocaleString()} lobbying this Congress, ${revolvingStats.withPositions.toLocaleString()} listed one.`,
  foot: "Lobbying disclosures from lda.gov",
  span: filingYears,
  stats: [
    { label: "Worked for a current member", value: lobbyists.filter((l) => l.members.length).length.toLocaleString() },
    { label: "Worked for a committee", value: lobbyists.filter((l) => l.committees.length).length.toLocaleString() },
    { label: "Members with ex-staff lobbying", value: membersByStaff.length.toLocaleString() },
  ],
};
cards["page/foreign-lobbying"] = {
  type: "page",
  kicker: "Foreign lobbying",
  title: "Who represents foreign governments in Washington",
  dek: `${activeRegistrants.toLocaleString()} US firms and people are registered under FARA to represent ${activePrincipals.toLocaleString()} foreign principals.`,
  foot: "Foreign agents from FARA filings",
  span: faraSpan,
  stats: [
    { label: "Foreign principals", value: activePrincipals.toLocaleString() },
    { label: "Countries", value: countries.filter((c) => c.active > 0).length.toLocaleString() },
    { label: "Agents' gifts to members", value: money(giftsTotal, true) },
  ],
};
cards["page/bundling"] = {
  type: "page",
  kicker: "Lobbyist bundling",
  title: "Lobbyists who bundled money for members",
  dek: `Lobbyists and lobbyists' PACs bundled ${money(bundlingTotal, true)} for ${bundledMembers.length} current members, ${cycleRange}.`,
  barsTitle: "Bundled the most",
  bars: bundlers.slice(0, 4).map((b) => ({ label: bundlerName(b), value: b.total })),
};
cards["page/about"] = {
  type: "page",
  kicker: "About the data",
  title: "How this data works",
  dek: "Where the numbers come from, what's counted and how organizations are classified.",
  lines: [
    { strong: "FEC filings", text: "PAC contributions, outside spending and big donors" },
    { strong: "SEC EDGAR", text: "which industry each company is in" },
    { strong: "lda.gov", text: "lobbying disclosures, issues and lobbyists' past jobs" },
    { strong: "efile.fara.gov", text: "foreign agents and who they represent" },
  ],
};
cards["page/open-data"] = {
  type: "page",
  kicker: "Open data",
  title: "Download the whole dataset",
  dek: "Every member, organization and PAC as atproto records, readable with standard atproto tools. CC0.",
  stats: [
    { label: "Members", value: members.length.toLocaleString() },
    { label: "Organizations", value: organizations.length.toLocaleString() },
    { label: "PACs and committees", value: committees.length.toLocaleString() },
  ],
};
cards["page/mcp"] = {
  type: "page",
  kicker: "For AI assistants",
  title: "Ask your AI assistant who funds Congress",
  dek: "Add contributions.fyi to Claude or any assistant that takes an MCP server. Free, with no sign-in.",
  lines: [
    { strong: "search", text: "members, PACs, donors, bills and races by name" },
    { strong: "get_record", text: "a page's full record, with links" },
    { strong: "find_members", text: "who represents a ZIP code or address" },
    { strong: "query", text: "SQL across everything, down to FEC filings" },
  ],
};
cards["page/find"] = {
  type: "page",
  kicker: "Find your member",
  title: "Who represents you in Congress?",
  dek: "Enter your ZIP code or street address to see your representative and senators, and who funds them.",
  stats: [
    { label: "ZIP codes mapped", value: zipCoverage.total.toLocaleString() },
    { label: "in a single district", value: `${Math.round((zipCoverage.single / zipCoverage.total) * 100)}%` },
    { label: "members of Congress", value: members.length.toLocaleString() },
  ],
};
cards["page/search"] = {
  type: "page",
  kicker: "Search",
  title: "Find a member, company, PAC or donor",
  dek: `Search everyone in the data, ${cycleRange}.`,
  stats: [
    { label: "Members", value: members.length.toLocaleString() },
    { label: "Organizations", value: organizations.length.toLocaleString() },
    { label: "PACs", value: committees.length.toLocaleString() },
    { label: "Donors", value: donors.length.toLocaleString() },
  ],
};

// --- sponsored travel ----------------------------------------------------------------

const since = `since ${sinceLabel}`;
const officeBars = (list: typeof trips, n: number): Bar[] =>
  [...list.reduce((acc, t) => acc.set(t.bioguide, (acc.get(t.bioguide) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .flatMap(([id, count]) => {
      const m = memberById.get(id);
      return m ? [{ label: m.name, value: count, party: party(m), note: shortSeat(m) }] : [];
    });
const allTrips = summarize(trips);
cards["travel/index"] = {
  type: "travel",
  kicker: "Sponsored travel",
  title: "Trips paid for by outside groups",
  dek: `${allTrips.trips.toLocaleString()} trips by members of Congress and their staff ${since}, paid for by ${activeSponsors.length} sponsors.`,
  stats: [
    { value: allTrips.trips.toLocaleString(), label: "trips by members and their staff" },
    { value: activeSponsors.length.toLocaleString(), label: "sponsors" },
    { value: allTrips.offices.toLocaleString(), label: "offices" },
  ],
  barsTitle: "Paid for the most trips",
  bars: activeSponsors.slice(0, 4).map((sp) => ({ label: sp.name, value: tripsBySponsor.get(sp.key)!.length })),
  span: since,
};
for (const sp of activeSponsors) {
  const list = tripsBySponsor.get(sp.key)!;
  const sum = summarize(list);
  cards[`travel/${sp.slug}`] = {
    type: "travel",
    kicker: "Sponsored travel",
    title: sp.name,
    dek: `Paid for ${sum.trips.toLocaleString()} ${sum.trips === 1 ? "trip" : "trips"} by members of Congress or their staff ${since}, from ${sum.offices} ${sum.offices === 1 ? "office" : "offices"}${sum.withCost ? `; it reported spending ${money(sum.cost, true)} on the ${sum.withCost === sum.trips ? "" : `${sum.withCost} `}trips whose costs were read` : ""}.`,
    stats: [
      { value: sum.trips.toLocaleString(), label: `${sum.trips === 1 ? "trip" : "trips"} it paid for` },
      { value: sum.offices.toLocaleString(), label: sum.offices === 1 ? "office" : "offices" },
      ...(sum.withCost ? [{ value: money(sum.cost, true), label: sum.withCost < sum.trips ? "reported, where read" : "reported cost" }] : []),
    ],
    barsTitle: "Whose offices went",
    bars: officeBars(list, 4),
    span: since,
  };
}

// --- campaign spending ----------------------------------------------------------------

const asParty = (p: string | undefined) => (p === "D" || p === "R" || p === "I" ? (p as Party) : undefined);

if (vendors.length && spendingCycles.length) {
  const latest = spendingCycles.at(-1)!;
  const current = allMembersBuckets(latest);
  const top = bucketRows(current.buckets, 2);
  let allCycles = 0;
  for (const id of spendingMembers) for (const s of Object.values(memberSpending(id)!.byCycle)) allCycles += s.total;
  cards["spending/index"] = {
    type: "spending",
    kicker: "Campaign spending",
    title: "Where campaigns spend their money",
    dek: `Members' campaigns itemized ${money(allCycles, true)} in spending, ${cycleRange.replace(/\u2060/g, "")}${top[0] ? `; ${bucketPhrase(top[0].key)} takes ${Math.round((top[0].value / current.total) * 100)}% this cycle` : ""}.`,
    stats: [
      { value: money(allCycles, true), label: "itemized by members' campaigns" },
      { value: vendors.length.toLocaleString(), label: "vendors with pages" },
    ],
    barsTitle: "Paid the most",
    bars: vendors.slice(0, 4).map((v) => ({ label: v.name, value: v.total })),
    span: cycleRange.replace(/\u2060/g, ""),
  };
  for (const v of vendors) {
    const payers = v.payers.slice(0, 4).flatMap((p) => {
      const r = payerRow(p);
      return r ? [{ label: r.label, value: p.total, party: asParty(r.party), note: r.note }] : [];
    });
    cards[`spending/${v.id}`] = {
      type: "spending",
      kicker: "Campaign vendor",
      title: v.name,
      dek: `Paid ${money(v.total, true)} by ${payersPhrase(v)}${v.purposes[0] ? `, mostly for ${v.purposes[0].text.toLowerCase()}` : ""}.`,
      stats: [
        { value: money(v.total, true), label: "from members' campaigns and leadership PACs" },
        { value: v.payers.length.toLocaleString(), label: v.payers.length === 1 ? "committee" : "committees" },
      ],
      barsTitle: "Paid it the most",
      bars: payers,
      span: cycleRange.replace(/\u2060/g, ""),
    };
  }
}

// --- House and Senate races, and candidates who aren't members -------------------

const statusOf = (r: (typeof allRaces)[number]) => (r.result.status === "pending" ? PENDING : resultLine(r));
for (const r of allRaces) {
  cards[`race/${r.year}-${r.slug}`] = {
    type: "race",
    kicker: `${r.year} ${raceChamber(r)} race · ${stateName(r.state)}`,
    name: raceName(r),
    status: statusOf(r),
    candidates: r.candidates.slice(0, 3).map((c) => ({
      label: personName(c),
      party: asParty(partyLetterOf(c)),
      note: asParty(partyLetterOf(c)) ? undefined : c.party,
      raised: raised(c),
      support: c.outside.support,
      oppose: c.outside.oppose,
    })),
    span: cycleOf(r.year),
  };
}
// A candidate's card is about their latest race, like their page.
for (const [id, [{ c, race: r }]] of candidateRaces as Map<string, [{ c: (typeof allRaces)[number]["candidates"][number]; race: (typeof allRaces)[number] }]>) {
  if (c.bioguide) continue;
  const v = sourceValues(c);
  cards[`candidate/${id}`] = {
    type: "candidate",
    name: personName(c),
    party: asParty(partyLetterOf(c)),
    partyName: partyName(c),
    seat: `${r.office === "S" ? "Senate" : "House"} candidate, ${raceShort(r)} (${r.year})`,
    raised: raised(c),
    sources: [
      { label: "Individuals", value: v.individual },
      { label: "PACs & party", value: v.pac },
      { label: "Own money", value: v.self },
    ],
    status: statusOf(r),
    span: cycleOf(r.year),
  };
}
for (const year of new Set(allRaces.map((r) => r.year))) {
  const list = racesOf(year);
  const raceMoney = list.reduce((a, r) => a + r.candidates.reduce((b, c) => b + raised(c), 0), 0);
  const decided = list.filter((r) => !noResult(r) && r.result.status !== "runoff").length;
  cards[`page/races-${year}`] = {
    type: "page",
    kicker: `${year} races`,
    title: `Every ${year} House and Senate race`,
    dek: `${list.reduce((a, r) => a + r.candidates.length, 0).toLocaleString()} candidates on the November ballot raised ${money(raceMoney, true)}. ${decided ? `${decided} of ${list.length} races have official results.` : `${PENDING}.`}`,
    span: cycleOf(year),
    barsTitle: "Most outside spending",
    bars: [...list]
      .sort((a, b) => b.outside.total - a.outside.total)
      .slice(0, 4)
      .map((r) => ({ label: raceName(r), value: r.outside.total })),
  };
}

const file: CardsFile = { version: ogVersion(cards), cycleRange: cycleRange.replace(/\u2060/g, ""), cards };
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, "cards.json"), JSON.stringify(file));
// The wordmark, so the server doesn't need the rest of the repo.
fs.copyFileSync(path.resolve(process.cwd(), "../design/logo/logo-light.svg"), path.join(OUT_DIR, "logo.svg"));
console.log(`og cards: ${Object.keys(cards).length} cards, ${(fs.statSync(path.join(OUT_DIR, "cards.json")).size / 1e6).toFixed(1)} MB, version ${file.version}`);
