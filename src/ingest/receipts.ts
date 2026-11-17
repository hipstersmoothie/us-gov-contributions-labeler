// Donations to outside spenders, totaled by donor. A donor is listed for a
// spender once everything they gave it adds up to MIN_DONATION, however many
// checks that took; a single-check cutoff missed people and PACs who give in
// installments, and the smaller gifts of everyone it did list.
import { slugify, titleCase } from "../lib/names.js";

export const MIN_DONATION = 50_000;

/** Donations from one donor to one outside spender in one cycle, added up. */
export interface LargeReceipt {
  recipient: string;
  cycle: number;
  /** Who gave, as their largest gift in this cycle reports it. */
  entityType: string;
  name: string;
  state: string;
  employer: string;
  occupation: string;
  /** Contributing committee, if the donor is one. */
  otherId: string;
  amount: number;
}

type Who = Pick<LargeReceipt, "entityType" | "name" | "state" | "otherId">;

export const isCommittee = (r: Who) => r.otherId.startsWith("C") || ["COM", "PAC", "PTY", "CCM"].includes(r.entityType);
export const isPerson = (r: Who) => !isCommittee(r) && r.entityType === "IND";

/** "MUSK, ELON R. MR." -> "Elon Musk" */
export function personName(raw: string) {
  const [last, rest = ""] = raw.split(",").map((s) => s.trim());
  const first = rest
    .split(/\s+/)
    .filter((t) => t.replace(/\./g, "").length > 1 && !/^(MR|MRS|MS|DR|JR|SR|II|III|IV)\.?$/i.test(t))
    .join(" ");
  return titleCase(`${first} ${last}`.trim());
}

/** Committees by FEC id, people by name and state, anyone else by name. */
export function donorId(r: Who) {
  const id =
    isCommittee(r) && r.otherId.startsWith("C")
      ? r.otherId.toLowerCase()
      : isPerson(r)
        ? `${slugify(personName(r.name))}-${(r.state || "us").toLowerCase()}`
        : slugify(r.name);
  return !id || id === "unknown" || id.startsWith("unknown-") ? undefined : id;
}

export class OutsideReceipts {
  private byKey = new Map<string, LargeReceipt & { largest: number }>();

  constructor(private spenders: Set<string>) {}

  /**
   * Count an itcont/itoth row if it's a donation to an outside spender:
   * transaction types 10-19, not a memo entry (those repeat money already
   * counted on another line).
   */
  add(line: string, cycle: number) {
    const recipient = line.slice(0, line.indexOf("|"));
    if (!this.spenders.has(recipient)) return;
    const r = line.split("|");
    const amount = Number(r[14]) || 0;
    if (!amount || !r[5]?.startsWith("1") || r[18] === "X") return;
    const who = { entityType: r[6] ?? "", name: r[7] ?? "", state: r[9] ?? "", otherId: r[15] ?? "" };
    const id = donorId(who);
    if (!id) return;
    const key = `${id}|${recipient}|${cycle}`;
    const sum = this.byKey.get(key);
    if (sum && amount <= sum.largest) {
      sum.amount += amount;
      return;
    }
    this.byKey.set(key, {
      ...who,
      recipient,
      cycle,
      employer: r[11] ?? "",
      occupation: r[12] ?? "",
      amount: (sum?.amount ?? 0) + amount,
      largest: amount,
    });
  }

  /** Each cycle's total, for donors who gave a spender at least `min` over all the cycles. */
  atLeast(min: number): LargeReceipt[] {
    const pairTotal = new Map<string, number>();
    const pair = (key: string) => key.slice(0, key.lastIndexOf("|"));
    for (const [key, r] of this.byKey) pairTotal.set(pair(key), (pairTotal.get(pair(key)) ?? 0) + r.amount);
    return [...this.byKey]
      .filter(([key]) => pairTotal.get(pair(key))! >= min)
      .map(([, { largest: _, ...r }]) => r);
  }
}
