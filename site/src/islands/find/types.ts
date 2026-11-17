// What the member finder loads: built by lib/districts.ts into /data/zips/
// and /data/delegations/, read by Finder.tsx.

/** /data/zips/<congress>/<first three digits>.json */
export interface ZipFile {
  congress: number;
  /** ZIP -> [district key ("AZ-3", at-large "WY-0"), share of the ZIP's land area], largest first. */
  zips: Record<string, [string, number][]>;
  /** The prefix's state, for ZIPs the table doesn't have (PO boxes, businesses). */
  states: string[];
  /** ZIP ranges that are all one district: the territories without Census ZIP areas. */
  ranges?: [string, string, string][];
}

export interface MemberSummary {
  id: string;
  name: string;
  party: "D" | "R" | "I";
  partyName: string;
  /** "District 3", "At large", "Delegate", "Senator". */
  seat: string;
  photo?: string;
  pac: number;
  raised: number;
  /** Top industries, PAC and employee money combined. */
  industries: string[];
  /** Outside spending (independent expenditures) that named them, when there was any. */
  outside?: OutsideMoney;
}

export interface OutsideMoney {
  support: number;
  oppose: number;
  /** Spending on their opponents in the same races, kept apart. */
  opponents: { support: number; oppose: number };
  /** The biggest spenders naming them, by support plus opposition. */
  spenders: OutsideSpender[];
}

export interface OutsideSpender {
  id: string;
  name: string;
  /** "Super PAC / hybrid PAC · doesn't disclose its donors" */
  kind: string;
  href: string;
  support: number;
  oppose: number;
}

/** /data/delegations/<state>.json */
export interface DelegationFile {
  state: string;
  name: string;
  congress: number;
  senators: MemberSummary[];
  /** District ("0" at large) -> its member, or null if the seat is vacant. */
  house: Record<string, MemberSummary | null>;
  /** DC and the territories. */
  noSenators?: boolean;
  /** The delegation's Bluesky list. */
  list?: string;
}
