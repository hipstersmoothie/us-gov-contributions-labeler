// Row shapes the list-page islands receive. Kept flat and small: they are
// serialized into the page (first rows) and into /data/*.json (all rows).

export interface MemberRow {
  id: string;
  name: string;
  sortName: string;
  party: "D" | "R" | "I";
  chamber: "house" | "senate";
  state: string;
  seat: string;
  topSector: string;
  raised: number;
  pacs: number;
}

export interface OrgRow {
  id: string;
  name: string;
  sector: string;
  industry: string;
  members: number;
  total: number;
}

export interface DonorRow {
  id: string;
  name: string;
  type: "individual" | "organization" | "committee";
  about: string;
  top: string;
  total: number;
}

export interface BillRow {
  id: string;
  label: string;
  name: string;
  policyArea: string;
  status: string;
  law: boolean;
  /** Date and pattern of its latest passage vote. */
  lastVote: string;
  pattern: "party-line" | "near-unanimous" | "split";
  lobbying: number;
}

export interface RaceRow {
  id: string;
  /** "Arizona's 4th District" */
  name: string;
  /** "AZ-04", for sorting and search */
  short: string;
  href: string;
  state: string;
  chamber: "house" | "senate";
  open: boolean;
  /** Party letter (or "") and surname of up to four candidates on the ballot. */
  field: { party: string; name: string }[];
  /** Searchable: every candidate's full name. */
  names: string;
  raised: number;
  /** General-election outside spending. */
  outside: number;
  tier: "10m" | "1m" | "some" | "none";
  redrawn: boolean;
  /** "Pending" or the result line. */
  result: string;
}
