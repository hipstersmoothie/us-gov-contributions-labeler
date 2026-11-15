// Turn the raw sources into the three files the website and labeler read:
//   data/members.json        members of Congress
//   data/organizations.json  the companies, unions and groups behind PACs
//   data/committees.json     the PACs themselves
import type { Legislator } from "../lib/legislators.js";
import type { Sector } from "../lib/sectors.js";
import type { FecCandidate, FecData, FecTotals } from "./fec.js";
import type { Committee, Organization } from "./committees.js";
import type { Donor } from "./donors.js";
import type { CongressCommittee } from "./assignments.js";
import type { EmployerGiving, MemberIndividuals } from "./individuals.js";
import type { LobbyingSpend } from "./lobbying.js";

export interface Account {
  did: string;
  handle: string;
  displayName?: string;
  sources: string[];
}

interface Amount<K extends string> {
  id: K extends "sector" ? Sector : string;
  total: number;
}

export interface Member {
  bioguide: string;
  name: string;
  chamber: "house" | "senate";
  state: string;
  district?: number;
  party: string;
  fecIds: string[];
  accounts: Account[];
  totals: Record<number, FecTotals>;
  /** PAC money by sector, largest first. */
  sectors: Amount<"sector">[];
  /** Organization ids, largest first. */
  organizations: Amount<"org">[];
  /** Committee ids, largest first. */
  committees: Amount<"committee">[];
  /** Independent expenditures for and against them. */
  outside: Outside & { spenders: (Outside & { id: string })[] };
  /**
   * Independent expenditures on their opponents: candidates in the same race,
   * same-party in a primary. `support` is money spent supporting an opponent,
   * `oppose` money spent opposing one. Never mixed into `outside`.
   */
  opponents: Outside & {
    spenders: (Outside & { id: string })[];
    candidates: (Outside & Pick<FecCandidate, "id" | "name" | "party" | "office" | "state" | "district">)[];
  };
  /** Congressional committee seats. */
  assignments: { id: string; title?: string }[];
  /** Itemized individual donations by employer and estimated sector. */
  individuals?: MemberIndividuals;
  /**
   * OpenSecrets-style totals: an organization's PAC money plus donations from
   * its employees, and sectors from both PAC and individual money.
   */
  contributors: Contributor[];
  combinedSectors: { id: string; total: number }[];
}

export interface Contributor {
  /** Organization id, or "employer:<name>" for employers without a PAC. */
  id: string;
  name: string;
  total: number;
  pacs: number;
  individuals: number;
}

interface Outside {
  support: number;
  oppose: number;
}

interface Giver {
  total: number;
  byCycle: Record<number, number>;
  /** bioguide ids, largest first. */
  recipients: { id: string; total: number }[];
}

export type CommitteeRecord = Committee &
  Giver & {
    /** Outside spending on current members, by member. */
    outside?: Outside & { targets: (Outside & { id: string })[] };
    /** Outside spending on current members' opponents, by the member whose race it was. */
    opponents?: Outside & { targets: (Outside & { id: string })[] };
    /** Large donors, if this is a super PAC we looked up. */
    donors?: { id: string; total: number }[];
  };
export type OrganizationRecord = Organization &
  Giver & {
    /** Donations to super PACs and other outside spenders. */
    outsideGifts?: { id: string; total: number }[];
    /** Itemized donations from people who list it as their employer. */
    employees?: Omit<EmployerGiving, "organization">;
    /** Federal lobbying spending in the same years. */
    lobbyingSpend?: LobbyingSpend;
  };
export type DonorRecord = Omit<Donor, "gifts"> & {
  total: number;
  gifts: { id: string; total: number; byCycle: Record<number, number> }[];
};

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

function ranked(map: Map<string, number>, limit = Infinity) {
  return [...map]
    .map(([id, total]) => ({ id, total }))
    .sort((a, b) => b.total - a.total)
    .slice(0, limit);
}

function add(map: Map<string, number>, key: string, amount: number) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

export function buildData(
  legislators: Legislator[],
  cycles: number[],
  accounts: { bioguide: string; accounts: Account[] }[],
  fec: FecData,
  enriched: { committees: Record<string, Committee>; organizations: Record<string, Organization> },
  donorData: { donors: Record<string, Donor> } | undefined,
  assignments: CongressCommittee[] | undefined,
  individuals: { members: Record<string, MemberIndividuals>; employers: Record<string, EmployerGiving> } | undefined,
  lobbyingSpend: Record<string, LobbyingSpend> | undefined
) {
  const seats = new Map<string, { id: string; title?: string }[]>();
  for (const c of assignments ?? []) {
    for (const m of c.members) {
      let list = seats.get(m.bioguide);
      if (!list) seats.set(m.bioguide, (list = []));
      list.push({ id: c.id, title: m.title });
    }
  }
  const accountsByMember = new Map(accounts.map((a) => [a.bioguide, a.accounts]));

  const memberCommittees = new Map<string, Map<string, number>>();
  const memberOrgs = new Map<string, Map<string, number>>();
  const memberSectors = new Map<string, Map<string, number>>();
  const givers = new Map<string, { byCycle: Map<string, number>; recipients: Map<string, number> }>();
  const giver = (id: string) => {
    let g = givers.get(id);
    if (!g) givers.set(id, (g = { byCycle: new Map(), recipients: new Map() }));
    return g;
  };
  const forMember = (map: Map<string, Map<string, number>>, bioguide: string) => {
    let m = map.get(bioguide);
    if (!m) map.set(bioguide, (m = new Map()));
    return m;
  };

  for (const [committeeId, byMember] of Object.entries(fec.contributions)) {
    const committee = enriched.committees[committeeId];
    if (!committee) continue;

    for (const [bioguide, byCycle] of Object.entries(byMember)) {
      const total = sum(Object.values(byCycle));
      add(forMember(memberCommittees, bioguide), committeeId, total);
      add(forMember(memberOrgs, bioguide), committee.organization, total);
      add(forMember(memberSectors, bioguide), committee.sector, total);

      for (const id of [committeeId, `org:${committee.organization}`]) {
        const g = giver(id);
        add(g.recipients, bioguide, total);
        for (const [cycle, amount] of Object.entries(byCycle)) add(g.byCycle, cycle, amount);
      }
    }
  }

  // Outside spending, kept apart from contributions: money spent attacking
  // someone isn't funding them.
  const memberOutside = new Map<string, Map<string, Outside>>();
  const spenderOutside = new Map<string, Map<string, Outside>>();
  const bump = (map: Map<string, Map<string, Outside>>, a: string, b: string, o: Outside) => {
    let inner = map.get(a);
    if (!inner) map.set(a, (inner = new Map()));
    const prev = inner.get(b) ?? { support: 0, oppose: 0 };
    inner.set(b, { support: prev.support + o.support, oppose: prev.oppose + o.oppose });
  };
  for (const [committeeId, byMember] of Object.entries(fec.outside ?? {})) {
    for (const [bioguide, spending] of Object.entries(byMember)) {
      const o = { support: sum(Object.values(spending.support)), oppose: sum(Object.values(spending.oppose)) };
      bump(memberOutside, bioguide, committeeId, o);
      bump(spenderOutside, committeeId, bioguide, o);
    }
  }
  // Spending on members' opponents, by spender, by opponent, and by the
  // spender's targets (the members whose races they spent in).
  const memberOpponents = new Map<string, Map<string, Outside>>();
  const memberOpponentCandidates = new Map<string, Map<string, Outside>>();
  const spenderOpponents = new Map<string, Map<string, Outside>>();
  for (const o of fec.opponents ?? []) {
    bump(memberOpponents, o.member, o.committee, o);
    bump(memberOpponentCandidates, o.member, o.candidate, o);
    bump(spenderOpponents, o.committee, o.member, o);
  }

  const rankedOutside = (map: Map<string, Outside> | undefined, limit = Infinity) => {
    const rows = [...(map ?? [])].map(([id, o]) => ({ id, ...o }));
    rows.sort((a, b) => b.support + b.oppose - (a.support + a.oppose));
    return {
      support: sum(rows.map((r) => r.support)),
      oppose: sum(rows.map((r) => r.oppose)),
      rows: rows.slice(0, limit),
    };
  };

  // Donors, plus the reverse indexes for super PAC and organization pages.
  const donorsBySpender = new Map<string, Map<string, number>>();
  const giftsByOrg = new Map<string, Map<string, number>>();
  const donors = Object.values(donorData?.donors ?? {})
    .map((d): DonorRecord => {
      const gifts = Object.entries(d.gifts).map(([id, byCycle]) => ({ id, total: sum(Object.values(byCycle)), byCycle }));
      gifts.sort((a, b) => b.total - a.total);
      for (const g of gifts) {
        let m = donorsBySpender.get(g.id);
        if (!m) donorsBySpender.set(g.id, (m = new Map()));
        m.set(d.id, g.total);
        if (d.organization) {
          let o = giftsByOrg.get(d.organization);
          if (!o) giftsByOrg.set(d.organization, (o = new Map()));
          add(o, g.id, g.total);
        }
      }
      return { ...d, total: sum(gifts.map((g) => g.total)), gifts };
    })
    .sort((a, b) => b.total - a.total);

  const combine = (
    pacOrgs: Map<string, number> | undefined,
    pacSectors: Map<string, number> | undefined,
    ind: MemberIndividuals | undefined
  ): Pick<Member, "contributors" | "combinedSectors"> => {
    const contributors = new Map<string, Contributor>();
    for (const [id, total] of pacOrgs ?? []) {
      const org = enriched.organizations[id];
      contributors.set(id, { id, name: org?.name ?? id, total, pacs: total, individuals: 0 });
    }
    for (const e of ind?.employers ?? []) {
      const id = e.organization ?? `employer:${e.id}`;
      const c = contributors.get(id) ?? { id, name: e.organization ? enriched.organizations[e.organization]?.name ?? e.name : e.name, total: 0, pacs: 0, individuals: 0 };
      c.individuals += e.total;
      c.total += e.total;
      contributors.set(id, c);
    }

    const sectorTotals = new Map(pacSectors ?? []);
    for (const s of ind?.sectors ?? []) add(sectorTotals, s.id, s.total);

    return {
      contributors: [...contributors.values()].sort((a, b) => b.total - a.total).slice(0, 50),
      combinedSectors: ranked(sectorTotals),
    };
  };

  const giverFields = (id: string): Giver => {
    const g = givers.get(id);
    return {
      total: g ? sum([...g.byCycle.values()]) : 0,
      byCycle: Object.fromEntries(g?.byCycle ?? []),
      recipients: g ? ranked(g.recipients) : [],
    };
  };

  const members = legislators.map(
    (l): Member => ({
      bioguide: l.bioguide,
      name: l.name,
      chamber: l.chamber,
      state: l.state,
      district: l.district,
      party: l.party,
      fecIds: l.fec,
      accounts: accountsByMember.get(l.bioguide) ?? [],
      totals: fec.totals[l.bioguide] ?? {},
      sectors: ranked(memberSectors.get(l.bioguide) ?? new Map()) as Amount<"sector">[],
      organizations: ranked(memberOrgs.get(l.bioguide) ?? new Map(), 50),
      committees: ranked(memberCommittees.get(l.bioguide) ?? new Map(), 50),
      outside: (({ rows, ...totals }) => ({ ...totals, spenders: rows }))(
        rankedOutside(memberOutside.get(l.bioguide), 25)
      ),
      opponents: (({ rows, ...totals }) => ({
        ...totals,
        spenders: rows,
        candidates: rankedOutside(memberOpponentCandidates.get(l.bioguide)).rows.map((r) => {
          const c = fec.candidates?.[r.id];
          return { ...r, name: c?.name ?? r.id, party: c?.party, office: c?.office ?? "H", state: c?.state ?? l.state, district: c?.district };
        }),
      }))(rankedOutside(memberOpponents.get(l.bioguide), 25)),
      assignments: seats.get(l.bioguide) ?? [],
      individuals: individuals?.members[l.bioguide],
      ...combine(memberOrgs.get(l.bioguide), memberSectors.get(l.bioguide), individuals?.members[l.bioguide]),
    })
  );

  const committees = Object.values(enriched.committees)
    .map((c): CommitteeRecord => {
      const outside = spenderOutside.has(c.id) ? rankedOutside(spenderOutside.get(c.id)) : undefined;
      const opponents = spenderOpponents.has(c.id) ? rankedOutside(spenderOpponents.get(c.id)) : undefined;
      const donorMap = donorsBySpender.get(c.id);
      return {
        ...c,
        ...giverFields(c.id),
        outside: outside && { support: outside.support, oppose: outside.oppose, targets: outside.rows },
        opponents: opponents && { support: opponents.support, oppose: opponents.oppose, targets: opponents.rows },
        donors: donorMap && ranked(donorMap),
      };
    })
    .sort((a, b) => b.total + (b.outside ? b.outside.support + b.outside.oppose : 0) - (a.total + (a.outside ? a.outside.support + a.outside.oppose : 0)));

  const organizations = Object.values(enriched.organizations)
    .map((o): OrganizationRecord => {
      const gifts = giftsByOrg.get(o.id);
      const employees = individuals?.employers[o.id];
      return {
        ...o,
        ...giverFields(`org:${o.id}`),
        outsideGifts: gifts && ranked(gifts),
        employees: employees && { total: employees.total, recipients: employees.recipients },
        lobbyingSpend: lobbyingSpend?.[o.id],
      };
    })
    .sort((a, b) => b.total - a.total);

  const meta = { generatedAt: new Date().toISOString(), cycles };
  return {
    members: { ...meta, members },
    committees: { ...meta, committees },
    organizations: { ...meta, organizations },
    donors: { ...meta, donors },
    congressCommittees: { ...meta, committees: assignments ?? [] },
  };
}
