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

/** Prototype: one reported trade, from House periodic transaction reports. */
export interface TradeRow {
  id: string;
  member: string;
  bioguide: string;
  sortName: string;
  party: "D" | "R" | "I";
  date: string;
  asset: string;
  company: boolean;
  tx: string;
  owner: string;
  amount: string;
  min: number;
  lagDays: number;
  docUrl: string;
}
