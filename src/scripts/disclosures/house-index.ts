// Match the House Clerk's yearly filing index to current members' bioguide ids
// and count filings by type and by how they were filed.
//
//   tsx src/scripts/disclosures/house-index.ts
import fs from "fs";
import path from "path";
import { CACHE, cachedFetch, currentMembers, fold, writeJson } from "./common.js";

const YEARS = [2024, 2025, 2026];

export interface HouseFiling {
  docId: string;
  year: number;
  type: string;
  filed: string; // YYYY-MM-DD
  last: string;
  first: string;
  stateDst: string;
  bioguide?: string;
  /** From the DocID: electronic filings are 8-digit; paper ones are 7-digit 8xxxxxx/9xxxxxx. */
  medium: "electronic" | "paper";
}

const TYPES: Record<string, string> = {
  O: "Annual", P: "Periodic transaction (PTR)", A: "Amendment", X: "Extension",
  C: "Candidate", D: "Candidate (new filer?)", W: "Waiver/withdrawal", T: "Termination",
  H: "New filer", B: "?", G: "?", E: "?",
};

function isoDate(us: string) {
  // Waivers have no filing date.
  if (!us) return "";
  const [m, d, y] = us.split("/");
  return `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
}

export async function loadHouseIndex(): Promise<HouseFiling[]> {
  const members = currentMembers().filter((m) => m.chamber === "house");
  const filings: HouseFiling[] = [];

  for (const year of YEARS) {
    const zip = `house/${year}FD.zip`;
    await cachedFetch(
      `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.zip`,
      zip
    );
    const txt = path.join(CACHE, `house/${year}/${year}FD.txt`);
    if (!fs.existsSync(txt)) throw new Error(`unzip ${zip} into house/${year}/ first`);
    const lines = fs.readFileSync(txt, "utf8").replace(/^﻿/, "").trim().split(/\r?\n/);
    for (const line of lines.slice(1)) {
      const [, last, first, , type, stateDst, , filed, docId] = line.split("\t");
      filings.push({
        docId: docId!.trim(),
        year,
        type: type!,
        filed: isoDate(filed!),
        last: last!,
        first: first!,
        stateDst: stateDst!,
        medium: docId!.trim().length === 8 ? "electronic" : "paper",
      });
    }
  }

  // Last name + state, then district or first name to break ties. Districts
  // move with redistricting, so state is the anchor.
  for (const f of filings) {
    const state = f.stateDst.slice(0, 2);
    const dst = Number(f.stateDst.slice(2));
    const lastF = fold(f.last);
    const sameLast = members.filter(
      (m) => m.state === state && (fold(m.last) === lastF || fold(m.last).includes(lastF) || lastF.includes(fold(m.last)))
    );
    // "Aumua Amata" (Radewagen), "Hinson Arenholz": the surname sits elsewhere in the name.
    if (!sameLast.length) {
      const whole = fold(`${f.first}${f.last}`);
      sameLast.push(
        ...members.filter((m) => m.state === state && (whole.includes(fold(m.last)) || fold(`${m.first}${m.last}`).includes(lastF)))
      );
    }
    let pick = sameLast.length === 1 ? sameLast[0] : undefined;
    if (sameLast.length > 1) {
      pick =
        sameLast.find((m) => m.district === dst) ??
        sameLast.find((m) => fold(f.first).startsWith(fold(m.nickname ?? m.first).slice(0, 3)));
    }
    // A sitting member's own filings are O/P/A/X/T; candidate filings (C, D)
    // under a member's name are their challengers or their own campaign.
    if (pick && !["C", "D"].includes(f.type)) f.bioguide = pick.bioguide;
  }
  return filings;
}

if (process.argv[1]?.endsWith("house-index.ts")) {
  const filings = await loadHouseIndex();
  writeJson("house/index.json", filings);
  const members = currentMembers().filter((m) => m.chamber === "house");

  for (const year of YEARS) {
    const ys = filings.filter((f) => f.year === year);
    console.log(`\n${year}: ${ys.length} filings`);
    for (const t of ["O", "P", "A", "X"]) {
      const ts = ys.filter((f) => f.type === t);
      const matched = ts.filter((f) => f.bioguide);
      const paper = matched.filter((f) => f.medium === "paper");
      console.log(
        `  ${TYPES[t]!.padEnd(28)} ${String(ts.length).padStart(4)}  matched to a current member ${matched.length}` +
          `  (${new Set(matched.map((f) => f.bioguide)).size} members), paper ${paper.length} (${((paper.length / matched.length) * 100).toFixed(1)}%)`
      );
    }
  }

  // Current members with no annual report for 2025 in the index
  const annual = new Set(filings.filter((f) => f.year === 2025 && f.type === "O").map((f) => f.bioguide));
  const missing = members.filter((m) => !annual.has(m.bioguide));
  console.log(`\nHouse members with no 2025 annual (O) matched: ${missing.length}`);
  console.log(missing.map((m) => `${m.first} ${m.last} ${m.state}${m.district}`).join("; "));

  // Unmatched O/P filers in 2025-2026 who share a state with current members
  const unmatched = filings.filter((f) => f.year >= 2025 && ["O", "P"].includes(f.type) && !f.bioguide);
  console.log(`\nUnmatched 2025-26 O/P filings: ${unmatched.length}`);
  console.log([...new Set(unmatched.map((f) => `${f.first} ${f.last} ${f.stateDst}`))].slice(0, 40).join("; "));

  const traders = new Map<string, number>();
  for (const f of filings.filter((f) => f.type === "P" && f.bioguide && f.year >= 2025))
    traders.set(f.bioguide!, (traders.get(f.bioguide!) ?? 0) + 1);
  console.log(`\nCurrent House members with any PTR in 2025-26: ${traders.size} of ${members.length}`);
  const paperFilers = new Set(filings.filter((f) => f.type === "P" && f.medium === "paper" && f.year >= 2025).map((f) => f.bioguide));
  console.log(`  ...who filed at least one PTR on paper: ${paperFilers.size}`);
}
