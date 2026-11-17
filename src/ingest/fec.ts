// Campaign finance totals and PAC contributions from FEC bulk data.
// https://www.fec.gov/data/browse-data/?tab=bulk-data
import fs from "fs";
import path from "path";
import readline from "readline";
import { spawn } from "child_process";
import type { Legislator } from "../lib/legislators.js";
import { currentCycle } from "../lib/cycles.js";
import { fecBulk } from "../lib/download.js";
import { committeeSummaries, electioneering, form5, form9Donations, lateNotices, type IeRow } from "./outside.js";


export interface FecTotals {
  receipts: number;
  disbursements: number;
  cashOnHand: number;
  individual: number;
  pac: number;
  party: number;
  /** The candidate's own contributions. */
  candidate: number;
  /** Loans from the candidate. */
  candidateLoans?: number;
  /** Individual contributions the campaign itemized (over $200 a year from one donor). */
  itemized?: number;
  /** Individual contributions reported only as a total ($200 or less a year from one donor). */
  unitemized?: number;
}

export type CommitteeKind =
  | "pac"
  | "leadership-pac"
  | "candidate"
  | "party"
  | "super-pac"
  /** A group or person that isn't a political committee but reported outside spending (FEC Form 5 or 9). */
  | "non-committee"
  | "other";

export interface FecCommittee {
  id: string;
  name: string;
  connectedOrg?: string;
  /** C corporation, L labor, M membership, T trade, V cooperative, W corp w/o stock */
  orgType?: string;
  kind: CommitteeKind;
  state?: string;
  /**
   * Form 5 and Form 9 filers: what their reports list as received to pay for
   * this spending, over the cycles. 0 means their filings name no donors.
   */
  reportedDonations?: number;
  /** Form 5 filers who report as an individual, not a group. */
  person?: boolean;
}

export interface FecData {
  /** bioguide -> cycle -> totals */
  totals: Record<string, Record<number, FecTotals>>;
  /** Every committee that gave to a current member. */
  committees: Record<string, FecCommittee>;
  /** committee id -> bioguide -> cycle -> amount */
  contributions: Record<string, Record<string, Record<number, number>>>;
  /**
   * Independent expenditures (ads etc. made without coordinating with the
   * campaign): committee id -> bioguide -> support/oppose -> cycle -> amount
   */
  outside: Record<string, Record<string, OutsideSpending>>;
  /** Spending on members' opponents (see OpponentSpending). */
  opponents: OpponentSpending[];
  /** The opponents named in `opponents`. */
  candidates: Record<string, FecCandidate>;
  /**
   * Electioneering communications (Form 9) naming a member: committee id ->
   * bioguide -> cycle -> the member's share of the cost. They don't say
   * vote for or against, so they're kept apart from `outside`.
   */
  electioneering?: Record<string, Record<string, Record<number, number>>>;
  /** What the sources beyond pas2 added, for the run log and the about page. */
  added?: { cycle: number; source: "notices" | "form5"; amount: number }[];
  /**
   * Independent expenditures naming any House or Senate candidate, member or
   * not, for the race pages: cycle -> candidate id -> committee id -> amounts,
   * with general-election spending also counted on its own.
   */
  byCandidate?: Record<number, Record<string, Record<string, CandidateOutside>>>;
}

export interface CandidateOutside {
  support: number;
  oppose: number;
  /** The part of support and oppose coded to the general election. */
  generalSupport: number;
  generalOppose: number;
}

export interface OutsideSpending {
  support: Record<number, number>;
  oppose: Record<number, number>;
}

/** A candidate an independent expenditure named, from the candidate master file. */
export interface FecCandidate {
  id: string;
  /** As filed: "LATIMER, GEORGE". */
  name: string;
  party?: string;
  office: "H" | "S";
  state: string;
  /** House only; 0 for at-large seats. */
  district?: number;
  year: number;
  /** Incumbent, challenger or open seat, as filed. */
  ici?: "I" | "C" | "O";
}

/**
 * Independent expenditures on a member's opponent: a candidate in the same
 * race (office, state, district, election year) as a current member. Kept
 * apart from spending that names the member: supporting someone running
 * against a member isn't the same act as opposing the member.
 */
export interface OpponentSpending {
  committee: string;
  /** The current member whose race it was. */
  member: string;
  /** The opponent the expenditure named. */
  candidate: string;
  cycle: number;
  support: number;
  oppose: number;
}

/**
 * The FEC lines behind the totals, one per line, written per cycle to
 * .cache/fec/<cycle>/lines.jsonl for the open-data source records
 * (src/lib/sqlite-files.ts). Amounts are as filed: refunds and corrections are
 * negative, nothing is rounded.
 */
export type FecLine =
  | {
      /** A PAC or other committee's contribution to a member's campaign (pas2 24K, or 24Z in-kind). */
      kind: "contribution";
      cycle: number;
      committee: string;
      candidate: string;
      bioguide: string;
      /** The committee that received it. */
      recipient: string;
      recipientName: string;
      type: string;
      /** Election, as filed: "P2026" primary, "G2026" general. */
      election: string;
      date?: string;
      amount: number;
      filing: string;
      image: string;
      transaction: string;
      memo?: string;
    }
  | {
      /** An independent expenditure naming a member, or a candidate running against one. */
      kind: "independent";
      cycle: number;
      source: "pas2" | "notice" | "form5";
      committee: string;
      candidate: string;
      /** When the candidate it names is a current member. */
      bioguide?: string;
      /** Current members whose race it counted toward as spending on an opponent. */
      opponentOf?: string[];
      side: "support" | "oppose";
      election: string;
      date?: string;
      amount: number;
      filing?: string;
      image?: string;
    }
  | {
      /** An electioneering communication (Form 9) naming a member: the member's share of its cost. */
      kind: "electioneering";
      cycle: number;
      committee: string;
      candidate: string;
      bioguide: string;
      date: string;
      amount: number;
      image?: string;
    };

const fecDate = (d = "") => (d.length === 8 ? `${d.slice(4)}-${d.slice(0, 2)}-${d.slice(2, 4)}` : undefined);

function download(cycle: number, file: string) {
  return fecBulk(cycle, `${file}${String(cycle).slice(2)}.zip`);
}

/** Stream the pipe-delimited rows of the single file inside a bulk zip. */
async function* rows(zip: string) {
  const child = spawn("unzip", ["-p", zip]);
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) if (line) yield line.split("|");
}

function committeeKind(type: string, designation: string): CommitteeKind {
  if (designation === "D") return "leadership-pac";
  if (["H", "S", "P"].includes(type)) return "candidate";
  if (["X", "Y", "Z"].includes(type)) return "party";
  if (["O", "U", "V", "W"].includes(type)) return "super-pac";
  if (type === "I" || type === "E") return "non-committee";
  if (["N", "Q"].includes(type)) return "pac";
  return "other";
}

/** States whose primaries put every party on one ballot (top-two, or Alaska's top-four). */
const TOP_TWO = new Set(["CA", "WA", "AK"]);

/** Which Senate class is up in a given election year (class 1 in 2024, 2 in 2026, 3 in 2028). */
const senateClassUpIn = (year: number) => ([3, 1, 2] as const)[(((year - 2022) / 2) % 3 + 3) % 3]!;

export async function ingestFec(legislators: Legislator[], cycles: number[]) {
  const legislatorById = new Map(legislators.map((l) => [l.bioguide, l]));
  const byFecId = new Map<string, string>();
  for (const l of legislators) for (const id of l.fec) byFecId.set(id, l.bioguide);

  const data: FecData = { totals: {}, committees: {}, contributions: {}, outside: {}, opponents: [], candidates: {}, electioneering: {}, added: [], byCandidate: {} };
  const opponentSpending = new Map<string, OpponentSpending>();
  const allCommittees = new Map<string, FecCommittee>();
  // Form 5 contributions and Form 9 donations, by filer, over the cycles.
  const nonCommitteeDonations = new Map<string, number>();
  const nonCommitteePeople = new Set<string>();

  for (const cycle of cycles) {
    console.log(`FEC ${cycle}${cycle === currentCycle() ? " (current)" : ""}`);
    const [weball, pas2, cm, cn, ccl] = await Promise.all([
      download(cycle, "weball"),
      download(cycle, "pas2"),
      download(cycle, "cm"),
      download(cycle, "cn"),
      download(cycle, "ccl"),
    ]);
    const summaries = await committeeSummaries(cycle);
    const lines: FecLine[] = [];

    // Races this cycle, from the candidate master. A race is office + state
    // (+ district for the House) + election year: only candidates whose
    // election year is this cycle are running in it, which keeps the two
    // Senate seats in a state apart (they're up in different years). Members
    // are placed by their own candidate record for the cycle, so redistricting
    // and members who ran for another office land in the right race.
    const raceOf = new Map<string, string>();
    const candidates = new Map<string, FecCandidate>();
    for await (const r of rows(cn)) {
      const [id, name, party, year, state, office, district, ici] = r;
      if ((office !== "H" && office !== "S") || Number(year) !== cycle || !state) continue;
      const c: FecCandidate = {
        id: id!,
        name: name!,
        party: party || undefined,
        office,
        state,
        district: office === "H" ? Number(district) || 0 : undefined,
        year: cycle,
        ici: ici === "I" || ici === "C" || ici === "O" ? ici : undefined,
      };
      candidates.set(c.id, c);
      raceOf.set(c.id, office === "H" ? `H|${state}|${c.district}|${cycle}` : `S|${state}|${cycle}`);
    }
    const inRace = new Map<string, FecCandidate[]>();
    for (const c of candidates.values()) {
      const race = raceOf.get(c.id)!;
      inRace.get(race)?.push(c) ?? inRace.set(race, [c]);
    }
    // Who's actually running. A candidate record alone isn't enough: a
    // retiring incumbent keeps one, so when the rest of a race's field filed
    // as running for an open seat, its incumbent isn't in it, either as a
    // member with opponents or as someone's opponent.
    const openRaces = new Set(
      [...inRace].filter(([, field]) => {
        const rest = field.filter((c) => c.ici !== "I");
        return rest.filter((c) => c.ici === "O").length > rest.filter((c) => c.ici === "C").length;
      }).map(([race]) => race)
    );
    const running = (c: FecCandidate) => !(c.ici === "I" && openRaces.has(raceOf.get(c.id)!));
    const membersInRace = new Map<string, Map<string, FecCandidate>>();
    for (const [fecId, bioguide] of byFecId) {
      const own = candidates.get(fecId);
      if (!own || !running(own)) continue;
      const race = raceOf.get(fecId)!;
      let map = membersInRace.get(race);
      if (!map) membersInRace.set(race, (map = new Map()));
      map.set(bioguide, own);
    }
    // Whether a member was on the general-election ballot: for a finished
    // cycle, they hold the seat that race filled (the right Senate class);
    // for the current one, they're running.
    // A special Senate election fills the other seat, not the one regularly up.
    const finished = cycle < currentCycle();
    // In the cycle under way, who won a primary isn't in the FEC files yet.
    // General-election spending says who the nominees are, though: a member
    // whose race saw general-election spending naming their party's nominee
    // (or, in a top-two state, two finalists), but never them, lost the primary.
    const generalNamed = new Map<string, Set<string>>();
    const inGeneral = (bioguide: string, c: FecCandidate, special: boolean) => {
      if (!finished) {
        const named = generalNamed.get(raceOf.get(c.id)!);
        if (!named || named.has(c.id)) return true;
        if (TOP_TWO.has(c.state)) return named.size < 2;
        return ![...named].some((id) => candidates.get(id)?.party === c.party);
      }
      const l = legislatorById.get(bioguide)!;
      if (c.office === "H") return l.chamber === "house" && l.state === c.state;
      const regular = l.senateClass === senateClassUpIn(cycle);
      return l.chamber === "senate" && l.state === c.state && (special ? !regular : regular);
    };
    // Two sitting senators from one state hold different seats, so they never
    // ran against each other (a regular and a special election can share a year).
    const sameStateSenators = (a: string, b: string | undefined) => {
      const x = legislatorById.get(a);
      const y = b ? legislatorById.get(b) : undefined;
      return !!y && x?.chamber === "senate" && y.chamber === "senate" && x.state === y.state;
    };

    for await (const r of rows(weball)) {
      const bioguide = byFecId.get(r[0]!);
      if (!bioguide) continue;
      const n = (i: number) => Number(r[i]) || 0;
      const totals = (data.totals[bioguide] ??= {});
      const prev = totals[cycle];
      // A member can have more than one candidate ID in a cycle (House + Senate).
      totals[cycle] = {
        receipts: n(5) + (prev?.receipts ?? 0),
        disbursements: n(7) + (prev?.disbursements ?? 0),
        cashOnHand: n(10) + (prev?.cashOnHand ?? 0),
        individual: n(17) + (prev?.individual ?? 0),
        pac: n(25) + (prev?.pac ?? 0),
        party: n(26) + (prev?.party ?? 0),
        candidate: n(11) + (prev?.candidate ?? 0),
        candidateLoans: n(12) + (prev?.candidateLoans ?? 0),
      };
    }

    // Itemized and unitemized individual money, from each member's own
    // campaign committees (principal and authorized) this cycle.
    for await (const r of rows(ccl)) {
      const [candId, , , cmteId, , designation] = r;
      const bioguide = byFecId.get(candId!);
      const summary = summaries.get(cmteId!);
      const totals = bioguide && data.totals[bioguide]?.[cycle];
      if (!totals || !summary || (designation !== "P" && designation !== "A")) continue;
      totals.itemized = (totals.itemized ?? 0) + summary.itemized;
      totals.unitemized = (totals.unitemized ?? 0) + summary.unitemized;
    }

    for await (const r of rows(cm)) {
      const [id, name, , , , , state, , designation, type, , , orgType, connectedOrg] = r;
      // Later cycles overwrite earlier ones so names are current.
      allCommittees.set(id!, {
        id: id!,
        name: name!,
        connectedOrg:
          connectedOrg && !/^none$/i.test(connectedOrg) ? connectedOrg : undefined,
        orgType: orgType || undefined,
        kind: committeeKind(type!, designation!),
        state: state || undefined,
      });
    }

    // One independent expenditure, from whichever source: counted for or
    // against the member it names, and toward their opponents' races.
    // Filers sometimes name a candidate without the id: find them by office,
    // state, district and last name, when exactly one candidate matches.
    const byName = new Map<string, string[]>();
    for (const c of candidates.values()) {
      const key = `${c.office}|${c.state}|${c.office === "H" ? c.district : 0}|${c.name.split(",")[0]!.trim().toUpperCase()}`;
      byName.get(key)?.push(c.id) ?? byName.set(key, [c.id]);
    }
    let unnamed = 0;
    const resolve = (ie: IeRow): IeRow | undefined => {
      if (ie.candidate || !ie.named) return ie.candidate ? ie : undefined;
      const n = ie.named;
      const found = byName.get(`${n.office}|${n.state}|${n.office === "H" ? n.district : 0}|${n.last}`);
      if (found?.length !== 1) return void unnamed++;
      return { ...ie, candidate: found[0]! };
    };
    const byCandidate = (data.byCandidate![cycle] = {} as Record<string, Record<string, CandidateOutside>>);
    const recordIe = (ie: IeRow, source: "pas2" | "notice" | "form5") => {
      const opponentOf: string[] = [];
      if (raceOf.has(ie.candidate)) {
        const byCommittee = (byCandidate[ie.candidate] ??= {});
        const row = (byCommittee[ie.committee] ??= { support: 0, oppose: 0, generalSupport: 0, generalOppose: 0 });
        row[ie.side] += ie.amount;
        if (ie.election === "G") row[ie.side === "support" ? "generalSupport" : "generalOppose"] += ie.amount;
      }
      // Spending on members' opponents: any expenditure naming a candidate in
      // a current member's race, other than that member. That includes another
      // member, where two incumbents met in the same race.
      const race = raceOf.get(ie.candidate);
      const members = race ? membersInRace.get(race) : undefined;
      const target = candidates.get(ie.candidate);
      // Primary and runoff spending is about the member's own primary: the
      // same party, except where everyone runs in one top-two primary.
      // General-election spending counts only if the member was on that ballot.
      const primary = ie.election === "P" || ie.election === "R";
      const targetMember = byFecId.get(ie.candidate);
      for (const [member, own] of members ?? []) {
        if (!target || member === targetMember || !running(target) || sameStateSenators(member, targetMember)) continue;
        if (primary ? own.party !== target.party && !TOP_TWO.has(own.state) : !inGeneral(member, own, ie.election === "S")) continue;
        const key = `${ie.committee}|${member}|${ie.candidate}|${cycle}`;
        const row = opponentSpending.get(key) ?? { committee: ie.committee, member, candidate: ie.candidate, cycle, support: 0, oppose: 0 };
        row[ie.side] += ie.amount;
        opponentSpending.set(key, row);
        data.candidates[ie.candidate] ??= target;
        opponentOf.push(member);
      }

      if (targetMember || opponentOf.length) {
        lines.push({
          kind: "independent", cycle, source, committee: ie.committee, candidate: ie.candidate, bioguide: targetMember,
          opponentOf: opponentOf.length ? opponentOf : undefined, side: ie.side, election: ie.election, date: ie.date || undefined,
          amount: ie.amount, filing: ie.filing, image: ie.image,
        });
      }
      if (!targetMember) return;
      const byMember = (data.outside[ie.committee] ??= {});
      const spending = (byMember[targetMember] ??= { support: {}, oppose: {} });
      spending[ie.side][cycle] = (spending[ie.side][cycle] ?? 0) + ie.amount;
    };

    // The latest independent expenditure pas2 has for each committee: its
    // processed reports run at least that far. (The committee summaries can
    // be a report ahead of pas2, so their coverage dates aren't used.)
    const pas2Through = new Map<string, string>();
    const ies: IeRow[] = [];
    for await (const r of rows(pas2)) {
      // 24E: independent expenditure supporting, 24A: opposing.
      if (r[5] === "24E" || r[5] === "24A") {
        const date = fecDate(r[13]) ?? "";
        if (date > (pas2Through.get(r[0]!) ?? "")) pas2Through.set(r[0]!, date);
        ies.push({ committee: r[0]!, candidate: r[16]!, side: r[5] === "24E" ? "support" : "oppose", amount: Number(r[14]) || 0, election: r[3]?.[0] ?? "", date, filing: r[18] || undefined, image: r[4] || undefined });
        continue;
      }

      const bioguide = byFecId.get(r[16]!);
      if (!bioguide) continue;
      const amount = Number(r[14]) || 0;

      // 24K: direct contribution, 24Z: in-kind.
      if (r[5] === "24K" || r[5] === "24Z") {
        const byMember = (data.contributions[r[0]!] ??= {});
        const byCycle = (byMember[bioguide] ??= {});
        byCycle[cycle] = (byCycle[cycle] ?? 0) + amount;
        lines.push({
          kind: "contribution", cycle, committee: r[0]!, candidate: r[16]!, bioguide, recipient: r[15]!, recipientName: r[7]!,
          type: r[5]!, election: r[3]!, date: fecDate(r[13]), amount, filing: r[18]!, image: r[4]!, transaction: r[17]!, memo: r[20] || undefined,
        });
      }
    }

    // pas2 stops at each committee's last processed periodic report; the
    // 24/48-hour notices carry on from there. A finished cycle's reports are
    // all processed, so its notices would only repeat what pas2 has.
    const notices = finished ? [] : (await lateNotices(cycle, (id) => pas2Through.get(id), (id) => allCommittees.has(id))).flatMap((ie) => resolve(ie) ?? []);
    const form5Filings = await form5(cycle);
    const f5 = form5Filings.rows.flatMap((ie) => resolve(ie) ?? []);
    for (const id of form5Filings.people) nonCommitteePeople.add(id);
    const { contributions } = form5Filings;
    // Stray lines coded to the wrong election shouldn't decide it: a
    // candidate counts as named once general-election spending on them
    // passes $10,000.
    const generalSpent = new Map<string, number>();
    for (const ie of [...ies, ...notices, ...f5]) {
      if (ie.election === "G") generalSpent.set(ie.candidate, (generalSpent.get(ie.candidate) ?? 0) + Math.abs(ie.amount));
    }
    for (const [candidate, amount] of generalSpent) {
      const race = raceOf.get(candidate);
      if (race && amount >= 10_000) generalNamed.set(race, (generalNamed.get(race) ?? new Set()).add(candidate));
    }
    for (const ie of ies) recordIe(ie, "pas2");
    for (const ie of notices) recordIe(ie, "notice");
    for (const ie of f5) recordIe(ie, "form5");
    for (const [id, amount] of [...contributions, ...(await form9Donations(cycle))]) {
      nonCommitteeDonations.set(id, (nonCommitteeDonations.get(id) ?? 0) + amount);
    }
    const named = (xs: IeRow[]) => Math.round(xs.filter((x) => byFecId.has(x.candidate) || raceOf.has(x.candidate)).reduce((s, x) => s + x.amount, 0));
    data.added!.push({ cycle, source: "notices", amount: named(notices) }, { cycle, source: "form5", amount: named(f5) });
    console.log(`  ${notices.length.toLocaleString()} notice lines after the last processed reports; ${unnamed} lines naming no candidate we could find`);

    for (const ec of await electioneering(cycle)) {
      const bioguide = byFecId.get(ec.candidate);
      if (!bioguide) continue;
      const byMember = (data.electioneering![ec.committee] ??= {});
      const byCycle = (byMember[bioguide] ??= {});
      byCycle[cycle] = (byCycle[cycle] ?? 0) + ec.amount;
      lines.push({ kind: "electioneering", cycle, committee: ec.committee, candidate: ec.candidate, bioguide, date: ec.date, amount: ec.amount, image: ec.image });
    }
    fs.writeFileSync(path.join(".cache/fec", String(cycle), "lines.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }

  // Drop refunds that net out to nothing, and round to whole dollars.
  for (const [id, byMember] of Object.entries(data.contributions)) {
    for (const [bioguide, byCycle] of Object.entries(byMember)) {
      for (const cycle of Object.keys(byCycle)) {
        const amount = Math.round(byCycle[Number(cycle)]!);
        if (amount > 0) byCycle[Number(cycle)] = amount;
        else delete byCycle[Number(cycle)];
      }
      if (!Object.keys(byCycle).length) delete byMember[bioguide];
    }
    if (!Object.keys(byMember).length) delete data.contributions[id];
    else data.committees[id] = allCommittees.get(id) ?? { id, name: id, kind: "other" };
  }

  for (const [id, byMember] of Object.entries(data.outside)) {
    for (const spending of Object.values(byMember)) {
      for (const side of [spending.support, spending.oppose]) {
        for (const cycle of Object.keys(side)) side[Number(cycle)] = Math.round(side[Number(cycle)]!);
      }
    }
    data.committees[id] ??= allCommittees.get(id) ?? { id, name: id, kind: "other" };
  }

  for (const [id, byMember] of Object.entries(data.electioneering!)) {
    for (const byCycle of Object.values(byMember)) {
      for (const cycle of Object.keys(byCycle)) byCycle[Number(cycle)] = Math.round(byCycle[Number(cycle)]!);
    }
    data.committees[id] ??= allCommittees.get(id) ?? { id, name: id, kind: "non-committee" };
  }

  // Candidates' outside spending, in whole dollars. Spenders that only named
  // non-members stay out of data.committees (and so out of committees.json);
  // the races step names them from the committee master.
  for (const byCand of Object.values(data.byCandidate!)) {
    for (const [cand, byCommittee] of Object.entries(byCand)) {
      for (const [id, row] of Object.entries(byCommittee)) {
        for (const k of ["support", "oppose", "generalSupport", "generalOppose"] as const) row[k] = Math.round(row[k]);
        if (row.support <= 0 && row.oppose <= 0) {
          delete byCommittee[id];
        }
      }
      if (!Object.keys(byCommittee).length) delete byCand[cand];
    }
  }

  for (const row of opponentSpending.values()) {
    row.support = Math.round(row.support);
    row.oppose = Math.round(row.oppose);
    if (row.support <= 0 && row.oppose <= 0) continue;
    data.opponents.push(row);
    data.committees[row.committee] ??= allCommittees.get(row.committee) ?? { id: row.committee, name: row.committee, kind: "other" };
  }

  // Whether groups that aren't PACs name any donors for this spending.
  const nonCommittee = Object.values(data.committees).filter((c) => c.kind === "non-committee").map((c) => c.id);
  // Only filers with periodic reports on file have said either way.
  for (const id of nonCommittee) {
    const donations = nonCommitteeDonations.get(id);
    const c = data.committees[id]!;
    c.reportedDonations = donations === undefined ? undefined : Math.round(donations);
    if (nonCommitteePeople.has(id)) c.person = true;
  }

  console.log(
    `FEC totals for ${Object.keys(data.totals).length}/${legislators.length} members, ` +
      `${Object.keys(data.contributions).length} contributing committees, ` +
      `${Object.keys(data.outside).length} outside spenders, ` +
      `${new Set(data.opponents.map((o) => o.committee)).size} spending on members' opponents`
  );
  return data;
}
