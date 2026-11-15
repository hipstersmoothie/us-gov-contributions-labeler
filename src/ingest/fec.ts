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
}

export interface OutsideSpending {
  support: Record<number, number>;
  oppose: Record<number, number>;
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

export async function ingestFec(legislators: Legislator[], cycles: number[]) {
  const byFecId = new Map<string, string>();
  for (const l of legislators) for (const id of l.fec) byFecId.set(id, l.bioguide);

  const data: FecData = { totals: {}, committees: {}, contributions: {}, outside: {} };
  const allCommittees = new Map<string, FecCommittee>();

  for (const cycle of cycles) {
    console.log(`FEC ${cycle}${cycle === currentCycle() ? " (current)" : ""}`);
    const [weball, pas2, cm] = await Promise.all([
      download(cycle, "weball"),
      download(cycle, "pas2"),
      download(cycle, "cm"),
    ]);

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

  console.log(
    `FEC totals for ${Object.keys(data.totals).length}/${legislators.length} members, ` +
      `${Object.keys(data.contributions).length} contributing committees, ` +
      `${Object.keys(data.outside).length} outside spenders`
  );
  return data;
}
