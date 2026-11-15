// Who funds the outside spenders. Super PACs can't give to campaigns, but
// they can take unlimited money and spend it for or against candidates; this
// collects the large ($50k+) donations behind every group that spent on
// current members.
//
// Everything comes from FEC bulk files: donations from people and companies
// are picked out while the individuals step streams itcont, and donations
// from other committees come from the "other transactions" file here.
import { normalizeOrg, slugify, titleCase } from "../lib/names.js";
import type { FecData } from "./fec.js";
import type { Committee, Organization } from "./committees.js";
import { download, largeReceipt, mainEntry, rows, type LargeReceipt } from "./individuals.js";

export const MIN_DONATION = 50_000;

export interface Donor {
  id: string;
  name: string;
  type: "individual" | "organization" | "committee";
  state?: string;
  employer?: string;
  occupation?: string;
  /** Matching organization or committee page, if we have one. */
  organization?: string;
  committee?: string;
  /** Outside spender id -> cycle -> amount */
  gifts: Record<string, Record<number, number>>;
}

/** Groups that spent for or against current members, minus parties and campaigns. */
export function outsideSpenders(fec: FecData) {
  // Groups that only spent on members' opponents count too.
  const ids = new Set([...Object.keys(fec.outside), ...(fec.opponents ?? []).map((o) => o.committee)]);
  return new Set(
    [...ids].filter((id) => {
      const kind = fec.committees[id]?.kind;
      return kind !== "party" && kind !== "candidate";
    })
  );
}

/** "MUSK, ELON R. MR." -> "Elon Musk" */
function personName(raw: string) {
  const [last, rest = ""] = raw.split(",").map((s) => s.trim());
  const first = rest
    .split(/\s+/)
    .filter((t) => t.replace(/\./g, "").length > 1 && !/^(MR|MRS|MS|DR|JR|SR|II|III|IV)\.?$/i.test(t))
    .join(" ");
  return titleCase(`${first} ${last}`.trim());
}

export async function collectDonors(
  fec: FecData,
  enriched: { committees: Record<string, Committee>; organizations: Record<string, Organization> },
  cycles: number[],
  fromIndividuals: LargeReceipt[]
) {
  const spenders = outsideSpenders(fec);
  const receipts = [...fromIndividuals];

  for (const cycle of cycles) {
    console.log(`Committee donations to outside spenders ${cycle}`);
    const oth = await download(cycle, "oth");
    for await (const line of rows(oth, mainEntry(oth))) {
      const r = largeReceipt(line, spenders, cycle);
      if (r) receipts.push(r);
    }
  }

  const donors: Record<string, Donor> = {};
  const orgIds = new Set(Object.keys(enriched.organizations));

  for (const r of receipts) {
    const isCommittee = r.otherId.startsWith("C") || ["COM", "PAC", "PTY", "CCM"].includes(r.entityType);
    const isPerson = !isCommittee && r.entityType === "IND";
    const committeeName = isCommittee ? fec.committees[r.otherId]?.name : undefined;
    const name = isPerson ? personName(r.name) : titleCase(committeeName ?? r.name);
    const state = r.state || undefined;

    const id =
      isCommittee && r.otherId.startsWith("C")
        ? r.otherId.toLowerCase()
        : isPerson
          ? `${slugify(name)}-${(state ?? "us").toLowerCase()}`
          : slugify(r.name);
    if (!id || id === "unknown" || id.startsWith("unknown-")) continue;

    const donor = (donors[id] ??= {
      id,
      name,
      type: isCommittee ? "committee" : isPerson ? "individual" : "organization",
      state,
      employer: isPerson ? titleCase(r.employer) || undefined : undefined,
      occupation: isPerson ? titleCase(r.occupation) || undefined : undefined,
      committee: isCommittee && enriched.committees[r.otherId] ? r.otherId : undefined,
      organization: !isPerson && !isCommittee && orgIds.has(slugify(r.name)) ? slugify(r.name) : undefined,
      gifts: {},
    });
    const byCycle = (donor.gifts[r.recipient] ??= {});
    byCycle[r.cycle] = (byCycle[r.cycle] ?? 0) + r.amount;
  }

  // The same person often files from more than one state (they moved, or
  // gave from a second home). Same name and same employer is the same donor;
  // same name alone isn't, since common names belong to different people.
  const byNameEmployer = new Map<string, Donor>();
  for (const d of Object.values(donors)) {
    if (d.type !== "individual" || !d.employer) continue;
    const key = `${d.name}|${normalizeOrg(d.employer)}`;
    const keep = byNameEmployer.get(key);
    if (!keep) {
      byNameEmployer.set(key, d);
      continue;
    }
    for (const [spender, byCycle] of Object.entries(d.gifts)) {
      const into = (keep.gifts[spender] ??= {});
      for (const [cycle, amount] of Object.entries(byCycle)) into[Number(cycle)] = (into[Number(cycle)] ?? 0) + amount;
    }
    delete donors[d.id];
  }

  const list = Object.values(donors);
  console.log(
    `${list.length} donors of $${MIN_DONATION.toLocaleString()}+ to ${spenders.size} outside spenders: ` +
      `${list.filter((d) => d.type === "individual").length} individuals, ` +
      `${list.filter((d) => d.type === "organization").length} organizations, ` +
      `${list.filter((d) => d.type === "committee").length} committees`
  );
  return { donors };
}
