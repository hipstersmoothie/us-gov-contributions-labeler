// What each link-preview card shows. site/scripts/og-cards.ts computes these
// from data/*.json at build time; the server renders them on request.

export type Party = "D" | "I" | "R";
export type Split = Record<Party, number>;

export interface Bar {
  label: string;
  value: number;
  /** Shown as a letter after the label, e.g. a recipient's party. */
  party?: Party;
  /** Small text after the label, e.g. "R-TX". */
  note?: string;
}

/** Outside spending on one member, for and against. */
export interface Target {
  label: string;
  note?: string;
  support: number;
  oppose: number;
}

export interface MemberCard {
  type: "member";
  name: string;
  party: Party;
  partyName: string;
  /** "Senator, VT" / "Representative, CA-12". */
  seat: string;
  /** Bioguide id, when there's an official portrait. */
  photo?: string;
  pac: number;
  rank: number;
  of: number;
  /** "senators" / "House members". */
  peers: string;
  sectors: Bar[];
}

export interface OrgCard {
  type: "organization";
  name: string;
  sector?: string;
  total: number;
  members: number;
  split: Split;
  top: Bar[];
}

export interface PacCard {
  type: "pac";
  name: string;
  kind: string;
  sector?: string;
  total: number;
  members: number;
  split: Split;
  /** Independent expenditures on current members. */
  support: number;
  oppose: number;
  targets: Target[];
  /** Spending on members' opponents, when there's none naming members. */
  opponents?: { support: number; oppose: number };
}

export interface DonorCard {
  type: "donor";
  name: string;
  about: string;
  total: number;
  gifts: Bar[];
  groups: number;
}

export interface SectorCard {
  type: "sector";
  name: string;
  total: number;
  orgs: number;
  members: number;
  split: Split;
  top: Bar[];
}

export interface Seat {
  x: number;
  y: number;
  party: Party;
  /** Chair or ranking member. */
  lead?: boolean;
}

export interface CommitteeCard {
  type: "committee";
  name: string;
  parent?: string;
  chamber: string;
  seats: Seat[];
  /** Seat radius in hemicycle units. */
  gap: number;
  counts: Split;
  total: number;
  /** The industry the committee leans on most, vs. its chamber. */
  lean?: { sector: string; share: number; base: number };
}

export interface BillCard {
  type: "bill";
  /** "H.R. 3633" */
  label: string;
  name: string;
  policyArea?: string;
  /** "Became law" / "Passed the House" / "Failed in the Senate" */
  status: string;
  /** The latest passage vote. */
  vote: {
    chamber: string;
    /** "Jul 17, 2025" */
    date: string;
    /** "Party line" / "Split" / "Near-unanimous" */
    pattern: string;
    rows: { party: Party; yes: number; no: number; other: number; note?: string }[];
  };
  /** "119th Congress", for the footer. */
  congress: string;
  /** How many organizations' lobbying reports name it, and the ones that named it most. */
  lobbying: number;
  top: { label: string; reports: number }[];
}

export interface CountryCard {
  type: "country";
  name: string;
  /** Foreign principals with a registration in effect now, and ones that ended since `span` began. */
  active: number;
  ended: number;
  registrants: number;
  /** "2021–2026", for the footer. */
  span: string;
  /** A few principals now, each with its US agent. */
  principals: { label: string; note: string }[];
}

export interface PageCard {
  type: "page";
  kicker: string;
  title: string;
  dek: string;
  /** Footer source line, when it isn't FEC filings ("Lobbying disclosures from lda.gov"), and its span. */
  foot?: string;
  span?: string;
  stats?: { label: string; value: string }[];
  bars?: Bar[];
  barsTitle?: string;
  /** Plain lines of text instead of bars, e.g. data sources. */
  lines?: { strong: string; text: string }[];
}

/** Privately sponsored travel: the /travel/ index and each sponsor's page. */
export interface TravelCard {
  type: "travel";
  kicker: string;
  title: string;
  dek: string;
  stats: { label: string; value: string }[];
  /** Counted in trips, not dollars. */
  bars?: Bar[];
  barsTitle?: string;
  /** "since Jan. 3, 2025", for the footer. */
  span: string;
}

/** A 2026 race: the leading candidates, what each raised, outside spending on each. */
export interface RaceCard {
  type: "race";
  /** "2026 House race · Arizona" */
  kicker: string;
  /** "Arizona's 4th District" */
  name: string;
  /** "Results pending certification", or the certified result. */
  status: string;
  candidates: { label: string; party?: Party; note?: string; raised: number; support: number; oppose: number }[];
  /** "2025–2026", for the footer. */
  span: string;
}

/** A 2026 candidate who isn't a member of Congress. */
export interface CandidateCard {
  type: "candidate";
  name: string;
  party?: Party;
  partyName: string;
  /** "Candidate for the House, AZ-04" */
  seat: string;
  raised: number;
  /** Raised by source: individuals, PACs and party, own money. */
  sources: Bar[];
  status: string;
  span: string;
}

export type Card = MemberCard | OrgCard | PacCard | DonorCard | SectorCard | CommitteeCard | BillCard | CountryCard | PageCard | TravelCard | RaceCard | CandidateCard;

export interface CardsFile {
  version: string;
  /** "2021–2026", for the footer. */
  cycleRange: string;
  /** Keyed by "<type>/<id>", the path under /og/<version>/. */
  cards: Record<string, Card>;
}
