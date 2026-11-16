// Build-time access to ../data/*.json, produced by `pnpm ingest`.
import fs from "node:fs";
import path from "node:path";
import { titleCase } from "../../../src/lib/names.ts";
import type { Member, CommitteeRecord, OrganizationRecord, DonorRecord } from "../../../src/ingest/build.ts";
import type { CongressCommittee } from "../../../src/ingest/assignments.ts";

export type { Member, CommitteeRecord as Committee, OrganizationRecord as Organization, DonorRecord as Donor, CongressCommittee };

const DATA_DIR = path.resolve(process.cwd(), "../data");

function load<T>(file: string, fallback?: T): T {
  const full = path.join(DATA_DIR, file);
  if (fallback !== undefined && !fs.existsSync(full)) return fallback;
  return JSON.parse(fs.readFileSync(full, "utf8"));
}

const membersFile = load<{ generatedAt: string; cycles: number[]; members: Member[] }>("members.json");
const { committees } = load<{ committees: CommitteeRecord[] }>("committees.json");
const { organizations } = load<{ organizations: OrganizationRecord[] }>("organizations.json");
const { donors } = load<{ donors: DonorRecord[] }>("donors.json", { donors: [] });
const { committees: congressCommittees } = load<{ committees: CongressCommittee[] }>("congress-committees.json", {
  committees: [],
});

// Committees that file with the FEC under an acronym, by their full names.
// Renamed here, at load, so every page, list, search entry and link preview
// agrees; the organization and donor records built from the same committee
// carry its name too.
const FULL_NAMES: Record<string, string> = {
  C00000935: "Democratic Congressional Campaign Committee",
  C00027466: "National Republican Senatorial Committee",
  C00042366: "Democratic Senatorial Campaign Committee",
  C00075820: "National Republican Congressional Committee",
  C00484642: "Senate Majority PAC",
  C00492140: "American Bridge 21st Century",
  C00495028: "House Majority PAC",
  C00504530: "Congressional Leadership Fund",
  C00571703: "Senate Leadership Fund",
  C00684969: "Jewish Democratic Council of America PAC",
  C00710848: "Democratic Majority for Israel PAC",
};
for (const c of committees) {
  const full = FULL_NAMES[c.id];
  if (!full) continue;
  const org = organizations.find((o) => o.id === c.organization);
  if (org && org.committees.length === 1) org.name = full;
  for (const d of donors) if (d.committee === c.id) d.name = full;
  c.name = full;
}

export const generatedAt = new Date(membersFile.generatedAt);
export const cycles = membersFile.cycles;
export const members = [...membersFile.members].sort((a, b) =>
  lastName(a.name).localeCompare(lastName(b.name))
);
export { committees, organizations, donors, congressCommittees };

export const memberById = new Map(members.map((m) => [m.bioguide, m]));
export const committeeById = new Map(committees.map((c) => [c.id, c]));
export const organizationById = new Map(organizations.map((o) => [o.id, o]));
export const donorById = new Map(donors.map((d) => [d.id, d]));
export const congressCommitteeById = new Map(congressCommittees.map((c) => [c.id, c]));

const PHOTO_DIR = path.resolve(process.cwd(), "public/photos");
/** Official portrait URL, if we have one for this member. */
export function photoUrl(bioguide: string) {
  return fs.existsSync(path.join(PHOTO_DIR, `${bioguide}.jpg`)) ? `/photos/${bioguide}.jpg` : undefined;
}
export const MIN_DONATION = 50_000;

function lastName(name: string) {
  return name.replace(/,? (Jr\.|Sr\.|II|III|IV)$/, "").split(" ").at(-1)!;
}

export { money, percent } from "./format";

// A word joiner keeps "2021–2026" from breaking after the dash.
export const cycleRange = `${cycles[0]! - 1}–\u2060${cycles.at(-1)}`;

export function partyLetter(party: string) {
  return party[0]!;
}

export function seat(m: Member) {
  if (m.chamber === "senate") return `Senator, ${m.state}`;
  return m.district ? `Representative, ${m.state}-${m.district}` : `Representative, ${m.state} (at large)`;
}

export function sectorSlug(sector: string) {
  return sector.toLowerCase().replace(/&/g, "and").replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");
}

const KIND_LABELS: Record<string, string> = {
  pac: "PAC",
  "leadership-pac": "Leadership PAC",
  candidate: "Candidate committee",
  party: "Party committee",
  "super-pac": "Super PAC / hybrid PAC",
  "non-committee": "Outside group, not a PAC",
  other: "Committee",
};
export const kindLabel = (kind: string) => KIND_LABELS[kind] ?? "Committee";

const ORG_TYPES: Record<string, string> = {
  C: "Corporation",
  L: "Labor organization",
  M: "Membership organization",
  T: "Trade association",
  V: "Cooperative",
  W: "Corporation without capital stock",
};
export const orgTypeLabel = (t?: string) => (t ? ORG_TYPES[t] : undefined);

/** Title-case the ALL CAPS names FEC files under, with acronyms kept: "CMS Energy". */
export function displayName(name: string) {
  return name === name.toUpperCase() ? titleCase(name) : name;
}

export const fecCommitteeUrl = (id: string) => `https://www.fec.gov/data/committee/${id}/`;

/** A committee's name, never a bare FEC ID, even if the ingest missed it. */
export const committeeLabel = (id: string) => {
  const c = committeeById.get(id);
  return c ? displayName(c.name) : `FEC committee ${id}`;
};
/**
 * A group that isn't a PAC whose FEC filings for its outside spending list no
 * donors (Form 5 contributions, Form 9 donations). PACs always report theirs.
 */
export const hidesDonors = (c: CommitteeRecord | undefined) => c?.kind === "non-committee" && !c.person && c.reportedDonations === 0;
/** The spender's type for tables, with "doesn't disclose its donors" where that's so. */
export const spenderType = (id: string) => {
  const c = committeeById.get(id);
  if (!c) return "";
  if (c.person) return "Individual, not a PAC";
  return hidesDonors(c) ? `${kindLabel(c.kind)} · doesn't disclose its donors` : kindLabel(c.kind);
};
/** Its page here, or the FEC's page when we have no profile for it. */
export const committeeHref = (id: string) => (committeeById.has(id) ? `/pacs/${id}/` : fecCommitteeUrl(id));
export const fecCandidateUrl = (id: string) => `https://www.fec.gov/data/candidate/${id}/`;

/** Money from an org or PAC split by the recipients' party. */
export function partySplit(recipients: { id: string; total: number }[]) {
  const split = { Democrat: 0, Independent: 0, Republican: 0 };
  for (const r of recipients) {
    const party = memberById.get(r.id)?.party as keyof typeof split | undefined;
    if (party && party in split) split[party] += r.total;
  }
  return split;
}
