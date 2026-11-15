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
