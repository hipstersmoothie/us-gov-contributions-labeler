// Political organizations that report to the IRS instead of the FEC (Section
// 527, Form 8872): what organizations with a page here gave them, and members'
// legal defense funds (data/irs527.json, from src/scripts/irs527/build.py).
import fs from "node:fs";
import path from "node:path";

export interface Group {
  name: string;
  /** What it works on: "Governors' races", "State politics (CA)". */
  kind: string;
  category: string;
  state: string;
  /** Works on state and local races. */
  stateLevel: boolean;
  receipts: number;
}
export interface OrgGiving {
  total: number;
  /** How many groups it gave to. */
  groups: number;
  byYear: Record<string, number>;
  /** The groups it gave the most, up to 12. */
  to: { ein: string; total: number }[];
  filedAs: string[];
}
export interface LegalFund {
  bioguide: string;
  ein: string;
  name: string;
  receipts: number;
  spending: number;
  contributors: number;
  split: { individuals?: number; committees?: number; organizations?: number; unitemized?: number };
}

const FILE = path.resolve(process.cwd(), "../data/irs527.json");
const file: { years: string[]; transmitted: string; groups: Record<string, Group>; organizations: Record<string, OrgGiving>; legalFunds: LegalFund[] } =
  fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, "utf8")) : { years: [], transmitted: "", groups: {}, organizations: {}, legalFunds: [] };

export const groups527 = file.groups;
export const givingByOrg = file.organizations;
export const legalFundByMember = new Map(file.legalFunds.map((f) => [f.bioguide, f]));
/** "2023–2026" */
export const years527 = file.years.length ? `${file.years[0]}–⁠${file.years.at(-1)}` : "";

/** "39-3779941", as the IRS writes an EIN. */
export const ein = (e: string) => `${e.slice(0, 2)}-${e.slice(2)}`;
export const IRS_SEARCH = "https://forms.irs.gov/app/pod/basicSearch/search";
