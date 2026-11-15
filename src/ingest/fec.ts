// Campaign finance totals and PAC contributions from FEC bulk data.
// https://www.fec.gov/data/browse-data/?tab=bulk-data
import fs from "fs";
import path from "path";
import readline from "readline";
import { spawn } from "child_process";
import type { Legislator } from "../lib/legislators.js";
import { currentCycle, isFresh } from "../lib/cycles.js";

const CACHE_DIR = ".cache/fec";
const BULK_URL = "https://www.fec.gov/files/bulk-downloads";

export interface FecTotals {
  receipts: number;
  disbursements: number;
  cashOnHand: number;
  individual: number;
  pac: number;
  party: number;
  candidate: number;
}

export type CommitteeKind =
  | "pac"
  | "leadership-pac"
  | "candidate"
  | "party"
  | "super-pac"
  | "other";

export interface FecCommittee {
  id: string;
  name: string;
  connectedOrg?: string;
  /** C corporation, L labor, M membership, T trade, V cooperative, W corp w/o stock */
  orgType?: string;
  kind: CommitteeKind;
  state?: string;
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

async function download(cycle: number, file: string) {
  const yy = String(cycle).slice(2);
  const dest = path.join(CACHE_DIR, String(cycle), `${file}${yy}.zip`);

  // Past cycles are effectively final; the current one gets refreshed weekly.
  if (fs.existsSync(dest) && isFresh(fs.statSync(dest).mtime, cycle, 7)) return dest;

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  console.log(`  downloading ${file}${yy}.zip`);
  const res = await fetch(`${BULK_URL}/${cycle}/${file}${yy}.zip`);
  if (!res.ok) throw new Error(`FEC download failed ${res.status}: ${file}${yy}`);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
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

  const data: FecData = { totals: {}, committees: {}, contributions: {}, outside: {}, opponents: [], candidates: {} };
  const opponentSpending = new Map<string, OpponentSpending>();
  const allCommittees = new Map<string, FecCommittee>();

  for (const cycle of cycles) {
    console.log(`FEC ${cycle}${cycle === currentCycle() ? " (current)" : ""}`);
    const [weball, pas2, cm, cn] = await Promise.all([
      download(cycle, "weball"),
      download(cycle, "pas2"),
      download(cycle, "cm"),
      download(cycle, "cn"),
    ]);

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
    const inGeneral = (bioguide: string, c: FecCandidate, special: boolean) => {
      if (!finished) return true;
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
      };
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

    for await (const r of rows(pas2)) {
      // Spending on members' opponents: any 24E/24A naming a candidate in a
      // current member's race, other than that member. That includes another
      // member, where two incumbents met in the same race.
      if (r[5] === "24E" || r[5] === "24A") {
        const race = raceOf.get(r[16]!);
        const members = race ? membersInRace.get(race) : undefined;
        const target = candidates.get(r[16]!);
        // Primary and runoff spending is about the member's own primary: the
        // same party, except where everyone runs in one top-two primary.
        // General-election spending counts only if the member was on that ballot.
        const election = r[3]?.[0];
        const primary = election === "P" || election === "R";
        const targetMember = byFecId.get(r[16]!);
        for (const [member, own] of members ?? []) {
          if (!target || member === targetMember || !running(target) || sameStateSenators(member, targetMember)) continue;
          if (primary ? own.party !== target.party && !TOP_TWO.has(own.state) : !inGeneral(member, own, election === "S")) continue;
          const key = `${r[0]}|${member}|${r[16]}|${cycle}`;
          const row = opponentSpending.get(key) ?? { committee: r[0]!, member, candidate: r[16]!, cycle, support: 0, oppose: 0 };
          if (r[5] === "24E") row.support += Number(r[14]) || 0;
          else row.oppose += Number(r[14]) || 0;
          opponentSpending.set(key, row);
          data.candidates[r[16]!] ??= candidates.get(r[16]!)!;
        }
      }

      const bioguide = byFecId.get(r[16]!);
      if (!bioguide) continue;
      const amount = Number(r[14]) || 0;

      // 24K: direct contribution, 24Z: in-kind.
      if (r[5] === "24K" || r[5] === "24Z") {
        const byMember = (data.contributions[r[0]!] ??= {});
        const byCycle = (byMember[bioguide] ??= {});
        byCycle[cycle] = (byCycle[cycle] ?? 0) + amount;
      }

      // 24E: independent expenditure supporting, 24A: opposing.
      if (r[5] === "24E" || r[5] === "24A") {
        const byMember = (data.outside[r[0]!] ??= {});
        const spending = (byMember[bioguide] ??= { support: {}, oppose: {} });
        const side = r[5] === "24E" ? spending.support : spending.oppose;
        side[cycle] = (side[cycle] ?? 0) + amount;
      }
    }
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

  for (const row of opponentSpending.values()) {
    row.support = Math.round(row.support);
    row.oppose = Math.round(row.oppose);
    if (row.support <= 0 && row.oppose <= 0) continue;
    data.opponents.push(row);
    data.committees[row.committee] ??= allCommittees.get(row.committee) ?? { id: row.committee, name: row.committee, kind: "other" };
  }

  console.log(
    `FEC totals for ${Object.keys(data.totals).length}/${legislators.length} members, ` +
      `${Object.keys(data.contributions).length} contributing committees, ` +
      `${Object.keys(data.outside).length} outside spenders, ` +
      `${new Set(data.opponents.map((o) => o.committee)).size} spending on members' opponents`
  );
  return data;
}
