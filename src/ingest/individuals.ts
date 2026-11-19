// Itemized individual donations to members' campaigns, rolled up by employer
// and estimated sector. Only aggregates leave this step; no donor names.
//
// The FEC files are big (~4 GB zipped per cycle), so they stay cached in
// .cache/fec like the other bulk files and are streamed, never loaded whole.
import readline from "readline";
import { spawn, execFileSync } from "child_process";
import { fecBulk } from "../lib/download.js";
import { MIN_DONATION, OutsideReceipts } from "./receipts.js";
import { normalizeOrg, slugify, titleCase } from "../lib/names.js";
import { sectorForName, type Sector } from "../lib/sectors.js";
import type { Legislator } from "../lib/legislators.js";
import type { Committee, Organization } from "./committees.js";
import { districtKey, loadZipDistricts } from "../lib/districts.js";


export type IndividualSector = Sector | "Retired" | "Not employed";

export interface MemberIndividuals {
  /** Sum of itemized (>$200) donations. */
  itemized: number;
  donations: number;
  employers: { id: string; name: string; total: number; organization?: string }[];
  sectors: { id: IndividualSector; total: number }[];
  /**
   * The same itemized money by where donors live, from the address on each
   * donation. `inDistrict` (House members in a district, not at-large seats)
   * is part of `inState`, estimated from ZIP codes: a ZIP that crosses
   * district lines is split by land area.
   */
  places?: { inState: number; outOfState: number; unknown: number; inDistrict?: number };
  /**
   * Donations earmarked through a PAC (15E lines naming it as the conduit),
   * by the PAC's committee id. Part of `itemized`, but not of `employers` or
   * `sectors`: the build credits them to the PAC's organization.
   */
  earmarked?: { committee: string; total: number }[];
}

// Conduits that pass on donations for anyone: payment platforms, not groups
// donors are giving through because of who they are.
const PLATFORMS = new Set([
  "C00401224", // ActBlue
  "C00694323", // WinRed
  "C00468314", // Democracy Engine
]);

export interface EmployerGiving {
  organization: string;
  total: number;
  recipients: { id: string; total: number }[];
}

export function download(cycle: number, file: string) {
  return fecBulk(cycle, `${file}${String(cycle).slice(2)}.zip`);
}

export async function* rows(zip: string, member?: string) {
  const child = spawn("unzip", ["-p", zip, ...(member ? [member] : [])]);
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  for await (const line of lines) if (line) yield line;
}

/**
 * The individual-contribution zips also carry by-date splits of the same rows.
 * When the two disagree, read the splits: fec.gov once served an indiv22.zip
 * whose itcont.txt stopped at 4.5 GB of 12, with every split whole.
 */
export function mainEntry(zip: string) {
  const entries = execFileSync("unzip", ["-l", zip], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+\d\d-\d\d-\d{4}\s+\d\d:\d\d\s+(.+)$/.exec(line))
    .filter((m) => m !== null)
    .map((m) => ({ size: Number(m[1]), name: m[2]! }));
  const main = entries.find((e) => /^it(cont|oth)\.txt$/.test(e.name)) ?? entries.find((e) => !e.name.includes("/"));
  const splits = entries.filter((e) => e.name.startsWith("by_date/")).reduce((n, e) => n + e.size, 0);
  if (main && splits && main.size !== splits) {
    console.warn(`  ${zip}: ${main.name} is ${main.size.toLocaleString()} bytes but its by-date splits are ${splits.toLocaleString()}; reading the splits`);
    return "by_date/*";
  }
  return main?.name;
}

const NOT_AN_EMPLOYER: [RegExp, "Retired" | "Self-employed" | "Not employed" | "Not reported"][] = [
  [/^RETIRED\b/, "Retired"],
  [/^(SELF|SELF[- ]?EMPLOYED|OWNER)$/, "Self-employed"],
  [/^(NOT[- ]EMPLOYED|NONE|NO EMPLOYER|UNEMPLOYED|HOMEMAKER|STUDENT|DISABLED)$/, "Not employed"],
  [/^(|N\/?A|INFORMATION REQUESTED.*|REQUESTED|REFUSED|UNKNOWN|BEST EFFORTS.*)$/, "Not reported"],
];

const OCCUPATION_RULES: [RegExp, Sector][] = [
  [/ATTORNEY|LAWYER|LEGAL|PARALEGAL|JUDGE/, "Lawyers & Lobbyists"],
  [/LOBBY/, "Lawyers & Lobbyists"],
  [/PHYSICIAN|DOCTOR|\bMD\b|NURSE|DENTIST|SURGEON|PHARMACIST|PSYCHIATRIST|PSYCHOLOGIST|THERAPIST|VETERINAR/, "Health"],
  [/REAL ESTATE|REALTOR|BROKER|INVEST|BANKER|FINANC|ACCOUNTANT|\bCPA\b|INSURANCE|PORTFOLIO|TRADER|ACTUARY/, "Finance, Insurance & Real Estate"],
  [/FARMER|RANCHER|GROWER|AGRICULTUR/, "Agribusiness"],
  [/PROFESSOR|TEACHER|EDUCATOR|PRINCIPAL|LIBRARIAN/, "Education"],
  [/CONTRACTOR|BUILDER|ARCHITECT|DEVELOPER \(REAL|CONSTRUCTION/, "Construction"],
  [/SOFTWARE|PROGRAMMER|DATA SCIENTIST/, "Communications & Technology"],
  [/PILOT|TRUCK/, "Transportation"],
];

export interface EmployerInfo {
  name: string;
  organization?: string;
  sector?: Sector;
}

/**
 * Sorts itemized donations by who the donor works for. `classify` gives the
 * donation's estimated sector and, for donors with an employer, the
 * normalized employer key (undefined when the employer field normalizes to
 * nothing: such donations count toward totals but no sector).
 */
export function donationClassifier(organizations: Record<string, Organization>) {
  const orgSector = new Map(Object.values(organizations).map((o) => [o.id, o.sector]));
  // employer key -> display name / matched org, computed once per key
  const employerInfo = new Map<string, EmployerInfo>();
  const occupationSector = new Map<string, Sector | undefined>();
  const classifyOccupation = (occupation: string) => {
    if (!occupationSector.has(occupation)) {
      occupationSector.set(occupation, OCCUPATION_RULES.find(([re]) => re.test(occupation))?.[1]);
    }
    return occupationSector.get(occupation);
  };
  const classify = (employerRaw: string, occupation: string): { sector: IndividualSector | undefined; employer?: string } | undefined => {
    const notEmployer = NOT_AN_EMPLOYER.find(([re]) => re.test(employerRaw))?.[1];
    if (notEmployer) {
      return {
        sector:
          notEmployer === "Retired"
            ? "Retired"
            : classifyOccupation(occupation) ?? (notEmployer === "Not employed" ? "Not employed" : undefined),
      };
    }
    const key = normalizeOrg(employerRaw);
    if (!key) return undefined;
    let info = employerInfo.get(key);
    if (!info) {
      const slug = slugify(employerRaw);
      const organization = orgSector.has(slug) ? slug : undefined;
      info = {
        name: titleCase(employerRaw),
        organization,
        sector: organization ? orgSector.get(organization) : sectorForName(employerRaw),
      };
      employerInfo.set(key, info);
    }
    return { sector: info.sector ?? classifyOccupation(occupation), employer: key };
  };
  return { classify, employerInfo };
}

export async function ingestIndividuals(
  legislators: Legislator[],
  cycles: number[],
  organizations: Record<string, Organization>,
  /** Outside spenders whose large donors we want. */
  spenders: Set<string>,
  /** Committees we have organizations for: earmarks through them are credited to the organization. */
  committees: Record<string, Committee>
) {
  const outsideReceipts = new OutsideReceipts(spenders);
  const byFecId = new Map<string, string>();
  for (const l of legislators) for (const id of l.fec) byFecId.set(id, l.bioguide);
  const { classify, employerInfo } = donationClassifier(organizations);

  // bioguide -> employer key -> amount
  const byMember = new Map<string, Map<string, number>>();
  // bioguide -> sector -> amount
  const sectors = new Map<string, Map<IndividualSector, number>>();
  // bioguide -> conduit committee id -> amount
  const earmarked = new Map<string, Map<string, number>>();
  const totals = new Map<string, { itemized: number; donations: number }>();
  const legislatorById = new Map(legislators.map((l) => [l.bioguide, l]));
  const places = new Map<string, { inState: number; outOfState: number; unknown: number }>();
  // House members' in-state money by ZIP, placed in districts at the end.
  const inStateZips = new Map<string, Map<string, number>>();

  for (const cycle of cycles) {
    console.log(`Individual donations ${cycle}`);
    const [ccl, indiv] = await Promise.all([download(cycle, "ccl"), download(cycle, "indiv")]);

    // Members' own campaign committees (principal + authorized), this cycle.
    const campaignOf = new Map<string, string>();
    for await (const line of rows(ccl)) {
      const [candId, , , cmteId, , designation] = line.split("|");
      const bioguide = byFecId.get(candId!);
      if (bioguide && (designation === "P" || designation === "A")) campaignOf.set(cmteId!, bioguide);
    }

    let seen = 0;
    let kept = 0;
    for await (const line of rows(indiv, mainEntry(indiv))) {
      if (++seen % 10_000_000 === 0) console.log(`  ${(seen / 1e6).toFixed(0)}M rows, ${kept.toLocaleString()} kept`);
      // Cheap pre-filter before splitting the whole row.
      const bioguide = campaignOf.get(line.slice(0, line.indexOf("|")));
      if (!bioguide) {
        outsideReceipts.add(line, cycle);
        continue;
      }

      const r = line.split("|");
      const type = r[5]!;
      // 15: contribution, 15E: earmarked (ActBlue/WinRed), 15J: share of a
      // joint fundraiser, 22Y: refund.
      if (!["15", "15E", "15J", "22Y"].includes(type)) continue;
      if (r[18] === "X" && type !== "15J") continue;
      if (r[6] && r[6] !== "IND") continue;

      const amount = (Number(r[14]) || 0) * (type === "22Y" ? -1 : 1);
      const employerRaw = (r[11] ?? "").trim().toUpperCase();
      const occupation = (r[12] ?? "").trim().toUpperCase();
      kept++;

      const home = legislatorById.get(bioguide)!;
      const place = places.get(bioguide) ?? { inState: 0, outOfState: 0, unknown: 0 };
      const state = r[9] ?? "";
      if (!/^[A-Z]{2}$/.test(state) || state === "ZZ") place.unknown += amount;
      else if (state !== home.state) place.outOfState += amount;
      else {
        place.inState += amount;
        const zip = (r[10] ?? "").slice(0, 5);
        if (home.chamber === "house" && home.district && /^\d{5}$/.test(zip)) {
          let z = inStateZips.get(bioguide);
          if (!z) inStateZips.set(bioguide, (z = new Map()));
          z.set(zip, (z.get(zip) ?? 0) + amount);
        }
      }
      places.set(bioguide, place);

      const t = totals.get(bioguide) ?? { itemized: 0, donations: 0 };
      t.itemized += amount;
      t.donations += type === "22Y" ? 0 : 1;
      totals.set(bioguide, t);

      // Earmarked through a PAC (other than a payment platform): the PAC's
      // money in the rankings, not the donor's employer's.
      const conduit = type === "15E" ? r[15] ?? "" : "";
      if (conduit && !PLATFORMS.has(conduit) && committees[conduit]) {
        let e = earmarked.get(bioguide);
        if (!e) earmarked.set(bioguide, (e = new Map()));
        e.set(conduit, (e.get(conduit) ?? 0) + amount);
        continue;
      }

      const classified = classify(employerRaw, occupation);
      if (!classified) continue;
      const { sector, employer } = classified;
      if (employer) {
        let m = byMember.get(bioguide);
        if (!m) byMember.set(bioguide, (m = new Map()));
        m.set(employer, (m.get(employer) ?? 0) + amount);
      }

      let s = sectors.get(bioguide);
      if (!s) sectors.set(bioguide, (s = new Map()));
      const sk = sector ?? "Unknown";
      s.set(sk, (s.get(sk) ?? 0) + amount);
    }
    console.log(`  ${(seen / 1e6).toFixed(1)}M rows, ${kept.toLocaleString()} to current members`);
  }

  // In-district money: each in-state ZIP's donations, times the share of the
  // ZIP inside the member's district. ZIPs the Census file doesn't know (PO
  // boxes, businesses) stay out of the district figure.
  const zipDistricts = await loadZipDistricts();
  const inDistrict = new Map<string, number>();
  for (const [bioguide, zips] of inStateZips) {
    const l = legislatorById.get(bioguide)!;
    const key = districtKey(l.state, l.district);
    let sum = 0;
    for (const [zip, amount] of zips) sum += amount * (zipDistricts.get(zip)?.get(key) ?? 0);
    inDistrict.set(bioguide, sum);
  }

  const members: Record<string, MemberIndividuals> = {};
  const employerTotals = new Map<string, Map<string, number>>();
  for (const [bioguide, t] of totals) {
    const employers = [...(byMember.get(bioguide) ?? [])]
      .filter(([, total]) => total > 0)
      .sort((a, b) => b[1] - a[1]);
    for (const [key, total] of employers) {
      const org = employerInfo.get(key)?.organization;
      if (!org) continue;
      let e = employerTotals.get(org);
      if (!e) employerTotals.set(org, (e = new Map()));
      e.set(bioguide, (e.get(bioguide) ?? 0) + total);
    }
    members[bioguide] = {
      itemized: Math.round(t.itemized),
      donations: t.donations,
      employers: employers.slice(0, 50).map(([key, total]) => ({
        id: key,
        name: employerInfo.get(key)!.name,
        total: Math.round(total),
        organization: employerInfo.get(key)!.organization,
      })),
      sectors: [...(sectors.get(bioguide) ?? [])]
        .map(([id, total]) => ({ id, total: Math.round(total) }))
        .filter((s) => s.total > 0)
        .sort((a, b) => b.total - a.total),
      places: (({ inState, outOfState, unknown }) => ({
        inState: Math.round(inState),
        outOfState: Math.round(outOfState),
        unknown: Math.round(unknown),
        inDistrict: inDistrict.has(bioguide) ? Math.round(inDistrict.get(bioguide)!) : undefined,
      }))(places.get(bioguide)!),
      earmarked: earmarked.has(bioguide)
        ? [...earmarked.get(bioguide)!]
            .map(([committee, total]) => ({ committee, total: Math.round(total) }))
            .filter((e) => e.total > 0)
            .sort((a, b) => b.total - a.total)
        : undefined,
    };
  }

  // Employee giving for organizations we already have pages for.
  const employers: Record<string, EmployerGiving> = {};
  for (const [organization, recipients] of employerTotals) {
    const list = [...recipients].map(([id, total]) => ({ id, total: Math.round(total) })).sort((a, b) => b.total - a.total);
    employers[organization] = { organization, total: list.reduce((s, r) => s + r.total, 0), recipients: list };
  }

  console.log(
    `Individual donations for ${Object.keys(members).length} members; ` +
      `employee giving matched to ${Object.keys(employers).length} organizations`
  );
  // The donors step adds committees' donations and builds the list.
  const largeReceipts = outsideReceipts.atLeast(MIN_DONATION);
  console.log(`${largeReceipts.length.toLocaleString()} donor-cycle totals to outside spenders from donors who gave one $${MIN_DONATION.toLocaleString()}+ in all`);
  return { members, employers, largeReceipts };
}
