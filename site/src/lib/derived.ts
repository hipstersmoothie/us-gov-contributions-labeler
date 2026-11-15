// Views derived at build time from the existing data, for the charts and the
// plain-language summaries. Nothing here changes the data's shape.
import { members, memberById, partyLetter, type Member } from "./data";
import type { SwarmPoint } from "./charts";

export const pacTotal = (m: Member) => m.committees.reduce((s, c) => s + c.total, 0);
export const raisedTotal = (m: Member) => Object.values(m.totals).reduce((s, t) => s + t.receipts, 0);

const pacByMember = new Map(members.map((m) => [m.bioguide, pacTotal(m)]));
export const chamberName = (m: Member) => (m.chamber === "senate" ? "Senate" : "House");

export function shortSeat(m: Member) {
  const p = partyLetter(m.party);
  return m.chamber === "senate" ? `${p}-${m.state}` : `${p}-${m.state}${m.district ? `-${m.district}` : ""}`;
}

/** Every member as a swarm point, laned by chamber. */
export function memberPoints(hi?: (m: Member) => boolean): SwarmPoint[] {
  return members.map((m) => ({
    id: m.bioguide,
    name: m.name,
    party: partyLetter(m.party) as SwarmPoint["party"],
    lane: chamberName(m),
    value: pacByMember.get(m.bioguide) ?? 0,
    detail: `${m.party}, ${m.chamber === "senate" ? `Senate, ${m.state}` : `House, ${shortSeat(m).slice(2)}`}`,
    hi: hi?.(m),
  }));
}

/** Top `n` member ids by PAC money in each chamber, for direct labels. */
export function topIds(points: SwarmPoint[], n: number, lanes?: string[]) {
  const out: string[] = [];
  for (const lane of lanes ?? [...new Set(points.map((p) => p.lane))]) {
    out.push(
      ...points
        .filter((p) => p.lane === lane && (p.hi ?? true))
        .sort((a, b) => b.value - a.value)
        .slice(0, n)
        .map((p) => p.id)
    );
  }
  return out;
}

/** Share of a member's chamber that took less PAC money than they did. */
export function pacPercentile(m: Member) {
  const mine = pacByMember.get(m.bioguide) ?? 0;
  const peers = members.filter((x) => x.chamber === m.chamber);
  const below = peers.filter((x) => (pacByMember.get(x.bioguide) ?? 0) < mine).length;
  return { pct: below / Math.max(peers.length - 1, 1), rank: peers.length - below, of: peers.length };
}

/** Recipients of an organization as swarm points, laned by party. */
export function recipientPoints(recipients: { id: string; total: number }[]): SwarmPoint[] {
  return recipients.flatMap((r) => {
    const m = memberById.get(r.id);
    if (!m) return [];
    const party = partyLetter(m.party) as SwarmPoint["party"];
    return [
      {
        id: m.bioguide,
        name: m.name,
        party,
        lane: `${m.party}s`,
        value: r.total,
        detail: `${m.party}, ${chamberName(m)}, ${m.state}`,
      },
    ];
  });
}

/** "one dollar in every four" style fractions for the deks. */
export function inEvery(share: number) {
  const n = Math.round(1 / share);
  const words = ["", "", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return n >= 2 && n <= 10 ? `about one dollar in every ${words[n]}` : `${Math.round(share * 100)}%`;
}

export const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
