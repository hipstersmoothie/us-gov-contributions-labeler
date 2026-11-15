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

export interface PageCard {
  type: "page";
  kicker: string;
  title: string;
  dek: string;
  stats?: { label: string; value: string }[];
  bars?: Bar[];
  barsTitle?: string;
  /** Plain lines of text instead of bars, e.g. data sources. */
  lines?: { strong: string; text: string }[];
}

export type Card = MemberCard | OrgCard | PacCard | DonorCard | SectorCard | CommitteeCard | BillCard | PageCard;

export interface CardsFile {
  version: string;
  /** "2021–2026", for the footer. */
  cycleRange: string;
  /** Keyed by "<type>/<id>", the path under /og/<version>/. */
  cards: Record<string, Card>;
}
