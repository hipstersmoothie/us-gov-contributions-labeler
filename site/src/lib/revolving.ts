// Lobbyists' former government jobs, from ../data/revolving-door.json
// (src/ingest/revolving.ts): who worked for a current member or committee and
// now lobbies, and the former officials lobbying for each organization.
//
// Working on the Hill and then lobbying is legal and disclosed; lobbyists have
// to list the government jobs they held in the 20 years before. The pages say
// what the filings say, nothing more.
import fs from "node:fs";
import path from "node:path";
import type { RevolvingFile, RevolvingLobbyist } from "../../../src/ingest/revolving.ts";
import { memberById, organizationById, congressCommitteeById } from "./data";

export type { RevolvingLobbyist as Lobbyist };

const file = path.resolve(process.cwd(), "../data/revolving-door.json");
const data: RevolvingFile = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : {
      generatedAt: "",
      congress: 0,
      quarters: [],
      stats: { lobbyists: 0, withPositions: 0, memberMentions: 0, memberResolved: 0, memberCurrent: 0, committeeMentions: 0, committeeResolved: 0 },
      lobbyists: [],
    };

export const revolvingStats = data.stats;
export const lobbyists = data.lobbyists;

/** Rows shown on a page; the rest load when the reader opens the full list. */
export const STAFF_SHOWN = 10;

/** A lobbyist as listed on a page: the job that ties them to it, and who they lobby for. */
export interface StaffRow {
  l: RevolvingLobbyist;
  job: string;
  /** For a senator who served in the House: the job was in their House office. */
  note?: string;
}

const byClients = (a: StaffRow, b: StaffRow) => b.l.clients.length - a.l.clients.length || a.l.name.localeCompare(b.l.name);

export const staffByMember = new Map<string, StaffRow[]>();
export const staffByCommittee = new Map<string, StaffRow[]>();
export const officialsByOrg = new Map<string, StaffRow[]>();
for (const l of lobbyists) {
  for (const m of l.members) {
    const member = memberById.get(m.bioguide);
    if (!member) continue;
    const note = m.chamber && m.chamber !== member.chamber ? `In ${m.chamber === "house" ? "the House" : "the Senate"}` : undefined;
    staffByMember.set(m.bioguide, [...(staffByMember.get(m.bioguide) ?? []), { l, job: m.job, note }]);
  }
  for (const c of l.committees) {
    if (!congressCommitteeById.has(c.id)) continue;
    staffByCommittee.set(c.id, [...(staffByCommittee.get(c.id) ?? []), { l, job: c.job }]);
  }
  // Organizations it lobbies for, and in-house lobbyists' own organizations.
  const orgs = new Set([...l.clients, ...l.firms].map((x) => x.organization).filter((x): x is string => !!x && organizationById.has(x)));
  for (const o of orgs) officialsByOrg.set(o, [...(officialsByOrg.get(o) ?? []), { l, job: l.positions.join("; ") }]);
}
for (const map of [staffByMember, staffByCommittee, officialsByOrg]) for (const rows of map.values()) rows.sort(byClients);

/** "January 2025 through September 2026" */
export const filingSpan = (() => {
  if (!data.quarters.length) return "";
  const parse = (q: string) => {
    const [year, period] = q.split("-");
    return { year, n: ["first", "second", "third", "fourth"].indexOf(period!.split("_")[0]!) };
  };
  const first = parse(data.quarters[0]!);
  const last = parse(data.quarters.at(-1)!);
  return `${["January", "April", "July", "October"][first.n]} ${first.year} through ${["March", "June", "September", "December"][last.n]} ${last.year}`;
})();

/** "2025–2026": the years of the filings read. */
export const filingYears = data.quarters.length
  ? [...new Set([data.quarters[0]!, data.quarters.at(-1)!].map((q) => q.slice(0, 4)))].join("–")
  : "";

/** Members with the most former staff lobbying, for the index page. */
export const membersByStaff = [...staffByMember].map(([id, rows]) => ({ id, count: rows.length })).sort((a, b) => b.count - a.count);
export const committeesByStaff = [...staffByCommittee].map(([id, rows]) => ({ id, count: rows.length })).sort((a, b) => b.count - a.count);

/** The hand check of a random sample of matches (data/revolving-door-review.json, src/scripts/review-revolving.ts). */
type Review = { kind: "member" | "committee"; right: boolean | null }[];
const reviewFile = path.resolve(process.cwd(), "../data/revolving-door-review.json");
const review: Review = fs.existsSync(reviewFile) ? JSON.parse(fs.readFileSync(reviewFile, "utf8")).sample : [];
const tally = (kind: string) => {
  const done = review.filter((r) => r.kind === kind && r.right !== null);
  return { checked: done.length, right: done.filter((r) => r.right).length };
};
export const REVIEW = { members: tally("member"), committees: tally("committee") };
