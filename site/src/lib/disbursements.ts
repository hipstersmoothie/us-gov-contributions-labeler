// Where campaigns' money goes: itemized operating expenditures by purpose and
// vendor, for members' campaigns and leadership PACs (data/disbursements.json,
// from src/ingest/disbursements.ts).
import fs from "node:fs";
import path from "node:path";
import { memberById, committeeById, partyLetter, partySplit, displayName, type Member } from "./data";
import { shortSeat } from "./derived";
import type { DisbursementsData, MemberSpending, LeadershipPacSpending, SpendingSummary, Vendor, VendorLine, VendorPayer } from "../../../src/ingest/disbursements.ts";
import { BUCKETS, BUCKET_LABEL, BUCKET_SHORT, VENDOR_MIN, VENDOR_MIN_PAYERS, STAFF_LABEL, type Bucket } from "../../../src/lib/spending.ts";

export type { MemberSpending, LeadershipPacSpending, SpendingSummary, Vendor, VendorLine, VendorPayer, Bucket };
export { BUCKETS, BUCKET_LABEL, BUCKET_SHORT, VENDOR_MIN, VENDOR_MIN_PAYERS, STAFF_LABEL };

const FILE = path.resolve(process.cwd(), "../data/disbursements.json");
const file: DisbursementsData = fs.existsSync(FILE)
  ? JSON.parse(fs.readFileSync(FILE, "utf8"))
  : { generatedAt: new Date(0).toISOString(), cycles: [], members: {}, leadershipPacs: {}, vendors: [] };

export const spendingUpdated = new Date(file.generatedAt);
export const spendingCycles = file.cycles;
export const vendors = file.vendors;
export const vendorById = new Map(vendors.map((v) => [v.id, v]));
export const vendorHref = (id: string) => `/vendors/${id}/`;

export const memberSpending = (bioguide: string): MemberSpending | undefined => file.members[bioguide];
export const pacSpending = (id: string): LeadershipPacSpending | undefined => file.leadershipPacs[id];
/** Members with spending on file, for the index. */
export const spendingMembers = Object.keys(file.members).filter((id) => memberById.has(id));

/** The newest cycle with money in it. */
export function latestCycle(byCycle: Record<number, { total: number }>) {
  const years = Object.keys(byCycle).map(Number).filter((c) => byCycle[c]!.total > 0);
  return years.length ? Math.max(...years) : undefined;
}

/** Buckets as chart rows, largest first; refunds and negatives left out. */
export function bucketRows(buckets: Partial<Record<Bucket, number>>, n = 8) {
  return BUCKETS.map((b) => ({ key: b.key, label: b.label, short: b.short, value: buckets[b.key] ?? 0 }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, n);
}

/** Buckets summed over every member's campaign for one cycle. */
export function allMembersBuckets(cycle: number) {
  const out: Partial<Record<Bucket, number>> = {};
  let total = 0;
  for (const id of spendingMembers) {
    const s = file.members[id]!.byCycle[cycle];
    if (!s) continue;
    total += s.total;
    for (const [k, v] of Object.entries(s.buckets)) out[k as Bucket] = (out[k as Bucket] ?? 0) + (v ?? 0);
  }
  return { buckets: out, total };
}

const MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
/** "June 30, 2026", AP style. */
export function dateLabel(iso: string) {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/** A bucket's label as it reads mid-sentence: "advertising and media". */
export const bucketPhrase = (key: Bucket) => (key === "other" ? "purposes the filings don't make clear" : BUCKET_LABEL[key].replace(/:.*$/, "").toLowerCase());

/** Who a vendor's payer is, for tables: the member, or the leadership PAC and its sponsor. */
export function payerRow(p: VendorPayer) {
  if (p.kind === "member") {
    const m = memberById.get(p.id);
    return m ? { label: m.name, href: `/members/${m.bioguide}/`, party: partyLetter(m.party), note: shortSeat(m), value: p.total, purpose: p.purpose } : undefined;
  }
  const c = committeeById.get(p.id);
  const sponsor = sponsorOf(p.id);
  return c
    ? { label: displayName(c.name), href: `/pacs/${c.id}/`, party: sponsor ? partyLetter(sponsor.party) : undefined, note: sponsor ? `Leadership PAC of ${sponsor.name}` : "Leadership PAC", value: p.total, purpose: p.purpose }
    : undefined;
}

/** The member behind a leadership PAC. */
export function sponsorOf(committeeId: string): Member | undefined {
  const c = committeeById.get(committeeId);
  const id = c?.sponsors?.find((s) => s.bioguide)?.bioguide;
  return id ? memberById.get(id) : undefined;
}

/** A vendor's money by the party of the member (or the PAC's sponsor) who paid it. */
export function vendorPartySplit(v: Vendor) {
  return partySplit(
    v.payers.flatMap((p) => {
      const id = p.kind === "member" ? p.id : sponsorOf(p.id)?.bioguide;
      return id ? [{ id, total: p.total }] : [];
    })
  );
}

/** How many of a vendor's payers are members' campaigns, and how many leadership PACs. */
export function payerCounts(v: Vendor) {
  const members = v.payers.filter((p) => p.kind === "member" && memberById.has(p.id)).length;
  return { members, pacs: v.payers.length - members };
}

/** "5 campaigns and 2 leadership PACs". */
export function payersPhrase(v: Vendor) {
  const { members, pacs } = payerCounts(v);
  const parts = [
    members && `${members} ${members === 1 ? "member's campaign" : "members' campaigns"}`,
    pacs && `${pacs} leadership ${pacs === 1 ? "PAC" : "PACs"}`,
  ].filter(Boolean);
  return parts.join(" and ");
}

/** Payees shown on a member or PAC page before "more". */
export const VENDORS_SHOWN = 8;
/** Vendors listed on /vendors/ before "more". */
export const INDEX_SHOWN = 50;
/** Payers on a vendor's page before "more". */
export const PAYERS_SHOWN = 25;

export const MEMO_NOTE =
  "Payments made by credit card or through a payroll service are counted by what they paid for, where the campaign itemized them; the rest stays under the card or payroll company.";
