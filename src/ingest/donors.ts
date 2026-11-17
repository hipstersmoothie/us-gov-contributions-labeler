// Who funds the outside spenders. Super PACs can't give to campaigns, but
// they can take unlimited money and spend it for or against candidates; this
// collects the donors who gave $50k+ in all to a group that spent on current
// members (see receipts.ts).
//
// Everything comes from FEC bulk files: donations from people and companies
// are picked out while the individuals step streams itcont, and donations
// from other committees come from the "other transactions" file here.
import { normalizeOrg, slugify, titleCase } from "../lib/names.js";
import type { FecData } from "./fec.js";
import type { Committee, Organization } from "./committees.js";
import { download, mainEntry, rows } from "./individuals.js";
import { MIN_DONATION, OutsideReceipts, donorId, isCommittee, isPerson, personName, type LargeReceipt } from "./receipts.js";

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

export async function collectDonors(
  fec: FecData,
  enriched: { committees: Record<string, Committee>; organizations: Record<string, Organization> },
  cycles: number[],
  fromIndividuals: LargeReceipt[]
) {
  const spenders = outsideSpenders(fec);
  const fromCommittees = new OutsideReceipts(spenders);
  for (const cycle of cycles) {
    console.log(`Committee donations to outside spenders ${cycle}`);
    const oth = await download(cycle, "oth");
    for await (const line of rows(oth, mainEntry(oth))) fromCommittees.add(line, cycle);
  }
  const receipts = [...fromIndividuals, ...fromCommittees.atLeast(MIN_DONATION)];

  const donors: Record<string, Donor> = {};
  const orgIds = new Set(Object.keys(enriched.organizations));

  for (const r of receipts) {
    const committee = isCommittee(r);
    const person = isPerson(r);
    const committeeName = committee ? fec.committees[r.otherId]?.name : undefined;
    const name = person ? personName(r.name) : titleCase(committeeName ?? r.name);
    const state = r.state || undefined;
    const id = donorId(r);
    if (!id) continue;

    const donor = (donors[id] ??= {
      id,
      name,
      type: committee ? "committee" : person ? "individual" : "organization",
      state,
      employer: person ? titleCase(r.employer) || undefined : undefined,
      occupation: person ? titleCase(r.occupation) || undefined : undefined,
      committee: committee && enriched.committees[r.otherId] ? r.otherId : undefined,
      organization: !person && !committee && orgIds.has(slugify(r.name)) ? slugify(r.name) : undefined,
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
    `${list.length} donors of $${MIN_DONATION.toLocaleString()}+ in all to one of ${spenders.size} outside spenders: ` +
      `${list.filter((d) => d.type === "individual").length} individuals, ` +
      `${list.filter((d) => d.type === "organization").length} organizations, ` +
      `${list.filter((d) => d.type === "committee").length} committees`
  );
  return { donors };
}
