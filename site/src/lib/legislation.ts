// Bills, their passage votes, and the organizations whose lobbying reports
// name them, from ../data/legislation.json (src/ingest/legislation.ts).
//
// Nothing here puts PAC money next to votes. Lobbying reports say what an
// organization lobbied on, not which side it took, so "lobbied on this bill"
// is all the data supports.
import fs from "node:fs";
import path from "node:path";
import { partyLetter, type Member } from "./data";
import type {
  LegislationFile,
  LegislationBill,
  LegislationVote,
  LobbyingClient,
  OrganizationBill,
  VotePattern,
} from "../../../src/ingest/legislation.ts";

export type { LegislationBill as Bill, LegislationVote as Vote, LobbyingClient, OrganizationBill, VotePattern };

const file = path.resolve(process.cwd(), "../data/legislation.json");
const data: LegislationFile = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : { generatedAt: "", congress: 0, caucus: {}, quarters: [], bills: [], organizations: {} };

export const congress = data.congress;
export const bills = data.bills;
export const billById = new Map(bills.map((b) => [b.id, b]));
export const organizationBills = data.organizations;

/** The party a current independent caucuses with now ("D" / "R"), if any. */
export const caucusOf = (m: Member) => (partyLetter(m.party) === "I" ? data.caucus[m.bioguide] : undefined);
/** Who a member's votes are compared with: "Democrats", or an independent's caucus. */
export const memberCaucusName = (m: Member) => {
  const c = caucusOf(m) ?? partyLetter(m.party);
  return c === "I" ? "independents" : partyPlural(c);
};

/** Rows shown on the page; the rest load when the reader opens the full list. */
export const CLIENTS_SHOWN = 25;
export const VOTES_SHOWN = 10;

/** "January 2025 through September 2026" */
export const lobbyingSpan = (() => {
  if (!data.quarters.length) return "";
  const parse = (q: string) => {
    const [year, period] = q.split("-");
    return { year, n: ["first", "second", "third", "fourth"].indexOf(period!.split("_")[0]!) };
  };
  const first = parse(data.quarters[0]!);
  const last = parse(data.quarters.at(-1)!);
  return `${["January", "April", "July", "October"][first.n]} ${first.year} through ${["March", "June", "September", "December"][last.n]} ${last.year}`;
})();

export const ordinal = (n: number) => `${n}${["th", "st", "nd", "rd"][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;
export const chamberLabel = (c: "house" | "senate") => (c === "house" ? "House" : "Senate");

export function fmtDate(iso: string, short = false) {
  return new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", {
    month: short ? "short" : "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

export const PATTERN_LABEL: Record<VotePattern, string> = {
  "party-line": "Party line",
  split: "Split",
  "near-unanimous": "Near-unanimous",
};

const PARTY_PLURAL: Record<string, string> = { D: "Democrats", R: "Republicans", I: "Independents" };
export const partyPlural = (p: string) => PARTY_PLURAL[p] ?? p;

/** "Passage", "Agreeing to the other chamber's changes", from a roll call's question. */
export function voteKind(v: LegislationVote) {
  if (/Objections of the President/i.test(v.question)) return "Overriding a veto";
  // "Concur in the Senate Amendment", not "On the Concurrent Resolution".
  if (/\bConcur\b/i.test(v.question)) return "Agreeing to the other chamber's changes";
  if (/Conference Report/i.test(v.question)) return "Final version";
  if (/Suspend the Rules/i.test(v.question)) return "Passage (two-thirds needed)";
  return "Passage";
}

/** Results read "Passed", "Agreed to", "Bill Passed", "Failed"... */
export const passed = (v: LegislationVote) => !/fail|reject|not (agreed|sustained)/i.test(v.result);

/** Independents in a vote who caucus with a party: "the 2 independents who caucus with them". */
function withIndependents(v: LegislationVote, party: string) {
  const n = Object.values(v.caucus ?? {}).filter((c) => c === party).length;
  return n ? ` (with ${n === 1 ? "the independent" : `the ${n} independents`} who caucus${n === 1 ? "es" : ""} with them)` : "";
}

/** One sentence on how the vote broke down, leading with the pattern. Parties
 *  here include the independents who caucus with them. */
export function patternSentence(v: LegislationVote) {
  const zero = { yes: 0, no: 0, other: 0 };
  const parties = [
    { key: "D", name: "Democrats", t: v.byCaucus.D ?? zero },
    { key: "R", name: "Republicans", t: v.byCaucus.R ?? zero },
  ].map((x) => ({ ...x, name: x.name + withIndependents(v, x.key) }));
  const share = (t: { yes: number; no: number }) => (t.yes + t.no ? t.yes / (t.yes + t.no) : 0);
  const [d, r] = parties as [(typeof parties)[number], (typeof parties)[number]];
  if (v.pattern === "party-line") {
    const [yes, no] = share(r.t) > share(d.t) ? [r, d] : [d, r];
    return `A party-line vote: ${yes.name} voted ${yes.t.yes}–${yes.t.no} for it and ${no.name} ${no.t.yes}–${no.t.no}.`;
  }
  if (v.pattern === "near-unanimous") {
    return `Nearly everyone agreed: ${d.name} voted ${d.t.yes}–${d.t.no} and ${r.name} ${r.t.yes}–${r.t.no}.`;
  }
  const divided = parties.filter((x) => Math.min(x.t.yes, x.t.no) > 0);
  return `A split vote: ${divided.map((x) => `${x.name} divided ${x.t.yes}–${x.t.no}`).join(", and ")}.`;
}

// Each vote's positions as one lookup, built once.
const positions = new Map(
  bills.flatMap((b) =>
    b.votes.map((v) => [
      v,
      new Map<string, "Y" | "N" | "O">([
        ...v.yes.map((id) => [id, "Y"] as const),
        ...v.no.map((id) => [id, "N"] as const),
        ...v.other.map((id) => [id, "O"] as const),
      ]),
    ])
  )
);

/** A current member's position on a vote, the party they voted under, and
 *  the party they were counted with (their caucus, for an independent). */
export function positionOf(v: LegislationVote, m: Member) {
  const position = positions.get(v)?.get(m.bioguide);
  const party = v.parties?.[m.bioguide] ?? partyLetter(m.party);
  return { position, party, group: v.caucus?.[m.bioguide] ?? party } as const;
}

const votesCache = new Map<string, ReturnType<typeof computeMemberVotes>>();
/** A member's passage votes, newest first, with how their caucus voted. */
export function memberVotes(m: Member) {
  if (!votesCache.has(m.bioguide)) votesCache.set(m.bioguide, computeMemberVotes(m));
  return votesCache.get(m.bioguide)!;
}
function computeMemberVotes(m: Member) {
  return bills
    .flatMap((b) =>
      b.votes
        .filter((v) => v.chamber === m.chamber)
        .flatMap((v) => {
          const { position, party, group } = positionOf(v, m);
          if (!position) return [];
          const t = v.byCaucus[group];
          const mine = position === "Y" ? t?.yes : position === "N" ? t?.no : undefined;
          const decided = t ? t.yes + t.no : 0;
          // Siding with 25% or less of your party is breaking ranks; a closer
          // vote is a party split, not one member going their own way. An
          // independent with no caucus has no party to break with.
          const broke = group !== "I" && mine !== undefined && decided > 0 && mine / decided <= 0.25;
          const partySplit = group !== "I" && !!t && decided > 0 && Math.min(t.yes, t.no) / decided > 0.25;
          return [{ b, v, position, party, group, t, broke, partySplit, alongside: broke ? mine! - 1 : 0 }];
        })
    )
    .sort((x, y) => y.v.date.localeCompare(x.v.date));
}

/** Organizations per sector, among clients with a PAC on the site. */
export function clientSectors(b: LegislationBill, sectorOf: (org: string) => string | undefined) {
  const counts = new Map<string, number>();
  for (const c of b.lobbying) {
    const s = c.org ? sectorOf(c.org) : undefined;
    if (s && s !== "Unknown") counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

/** Where the bill stands, in a sentence. */
export function status(b: LegislationBill) {
  if (b.law) return `Became law (Public Law ${b.law})`;
  return b.latestAction?.text.replace(/\.+$/, "") ?? "";
}
/** …and in a word or two, from its last passage vote. */
export function shortStatus(b: LegislationBill) {
  if (b.law) return "Law";
  const last = b.votes.at(-1)!;
  return `${passed(last) ? "Passed" : "Failed in"} ${chamberLabel(last.chamber)}`;
}
