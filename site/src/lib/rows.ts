// Flat rows for the list-page islands (see src/islands/types.ts).
import { members, organizations, donors, committeeById, displayName, partyLetter } from "./data";
import { pacTotal, raisedTotal, shortSeat } from "./derived";
import { surname } from "./format";
import { bills, shortStatus } from "./legislation";
import type { BillRow, DonorRow, MemberRow, OrgRow } from "../islands/types";

export const memberRows = (): MemberRow[] =>
  members.map((m) => ({
    id: m.bioguide,
    name: m.name,
    sortName: `${surname(m.name)} ${m.name}`,
    party: partyLetter(m.party) as MemberRow["party"],
    chamber: m.chamber,
    state: m.state,
    seat: m.chamber === "senate" ? `Senate, ${m.state}` : `House, ${shortSeat(m).slice(2)}`,
    topSector: m.sectors.find((s) => s.id !== "Unknown")?.id ?? "",
    raised: Math.round(raisedTotal(m)),
    pacs: Math.round(pacTotal(m)),
  }));

/** Smaller givers are still reachable through search and their PAC pages. */
export const ORG_MIN = 10_000;
export const orgRows = (): OrgRow[] =>
  organizations
    .filter((o) => o.total >= ORG_MIN)
    .map((o) => ({ id: o.id, name: o.name, sector: o.sector, industry: o.industry ?? "", members: o.recipients.length, total: Math.round(o.total) }));

export const donorRows = (): DonorRow[] =>
  donors.map((d) => {
    const top = committeeById.get(d.gifts[0]?.id ?? "");
    return {
      id: d.id,
      name: d.name,
      type: d.type as DonorRow["type"],
      about: d.type === "individual" ? [d.occupation, d.employer].filter(Boolean).join(", ") : "",
      top: top ? displayName(top.name) : "",
      total: Math.round(d.total),
    };
  });

export const billRows = (): BillRow[] =>
  bills.map((b) => {
    const last = b.votes.at(-1)!;
    return {
      id: b.id,
      label: b.label,
      name: b.name,
      policyArea: b.policyArea ?? "",
      status: shortStatus(b),
      law: !!b.law,
      lastVote: last.date,
      pattern: last.pattern,
      lobbying: b.lobbying.length,
    };
  });
