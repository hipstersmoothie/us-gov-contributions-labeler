// Views derived at build time from the existing data, for the charts and the
// plain-language summaries. Nothing here changes the data's shape.
import { members, memberById, partyLetter, generatedAt, type Member } from "./data";
import type { Seat, SwarmPoint } from "./charts";
import { moneyAuto } from "./format";

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
    href: `/members/${m.bioguide}/`,
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
        href: `/members/${m.bioguide}/`,
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

/** "Pelosi's", "Jeffries'". */
export const possessive = (name: string) => (name.endsWith("s") ? `${name}'` : `${name}'s`);

// How each sector reads in a sentence about who backs a member.
const BACKERS: Record<string, string> = {
  Agribusiness: "agribusiness",
  "Communications & Technology": "tech and telecom companies",
  Construction: "the construction industry",
  Defense: "defense contractors",
  Education: "educators and schools",
  "Energy & Natural Resources": "energy companies",
  "Finance, Insurance & Real Estate": "finance and real estate",
  Health: "the health care industry",
  "Ideological & Single-Issue": "ideological and single-issue groups",
  Labor: "labor unions",
  "Lawyers & Lobbyists": "lawyers and lobbyists",
  "Misc Business": "business groups",
  Transportation: "transportation companies",
};

/** The member's top two industries, PAC and employee money combined, in words. */
export function backersPhrase(m: Member) {
  const source = m.combinedSectors?.length ? m.combinedSectors : m.sectors;
  const top = source.filter((s) => BACKERS[s.id] && s.total > 0).slice(0, 2).map((s) => BACKERS[s.id]!);
  if (top.length < 2) return top[0];
  // "labor unions and health care", but "health care, followed by finance and real estate".
  return top.some((t) => t.includes(" and ")) ? `${top[0]}, followed by ${top[1]}` : `${top[0]} and ${top[1]}`;
}

/** "2023–24", or "2025–26 (so far)" for a cycle that hasn't ended yet. */
export function cycleLabel(cycle: number) {
  const label = `${cycle - 1}–${String(cycle).slice(2)}`;
  // A cycle ends after its general election in November of the even year.
  const ended = generatedAt > new Date(Date.UTC(cycle, 11, 31));
  return ended ? label : `${label} (so far)`;
}

/** Every seat in a chamber, highlighted where `amounts` has the member. */
export function chamberSeats(chamber: "house" | "senate", amounts: Map<string, number>): Seat[] {
  return members
    .filter((m) => m.chamber === chamber)
    .map((m) => {
      const amount = amounts.get(m.bioguide);
      return {
        id: m.bioguide,
        name: m.name,
        party: partyLetter(m.party) as Seat["party"],
        detail: `${m.party}, ${m.chamber === "senate" ? m.state : shortSeat(m).slice(2)}`,
        hi: amount !== undefined && amount > 0,
        amount: amount ? moneyAuto(amount) : "Nothing",
        href: `/members/${m.bioguide}/`,
      };
    });
}

// --- donor makeup -------------------------------------------------------------------

/** Who a member's money came from, summed over the dataset's cycles. */
export interface DonorMakeup {
  /** Individual contributions of $200 or less a year, which campaigns report only as a total. */
  small: number;
  /** Itemized individual contributions (over $200), as the campaigns reported them. */
  itemized: number;
  /** Itemized money by donor address: in the district (House), elsewhere in the state, out of state. */
  inDistrict?: number;
  restOfState: number;
  outOfState: number;
  /** The candidate's own contributions and loans to the campaign. */
  selfGiven: number;
  selfLoans: number;
  receipts: number;
}

export function donorMakeup(m: Member): DonorMakeup | undefined {
  const totals = Object.values(m.totals);
  const sum = (f: (t: (typeof totals)[number]) => number | undefined) => totals.reduce((s, t) => s + Math.max(f(t) ?? 0, 0), 0);
  const small = sum((t) => t.unitemized);
  const itemized = sum((t) => t.itemized);
  const places = m.individuals?.places;
  if (small + itemized <= 0 || !places) return undefined;
  const inDistrict = places.inDistrict === undefined ? undefined : Math.min(places.inDistrict, places.inState);
  return {
    small,
    itemized,
    inDistrict,
    restOfState: Math.max(places.inState - (inDistrict ?? 0), 0),
    outOfState: Math.max(places.outOfState, 0),
    selfGiven: sum((t) => t.candidate),
    selfLoans: sum((t) => t.candidateLoans),
    receipts: sum((t) => t.receipts),
  };
}

export const makeupShares = (d: DonorMakeup) => {
  const placed = (d.inDistrict ?? 0) + d.restOfState + d.outOfState;
  return {
    small: d.small / (d.small + d.itemized),
    inState: placed ? ((d.inDistrict ?? 0) + d.restOfState) / placed : undefined,
    inDistrict: placed && d.inDistrict !== undefined ? d.inDistrict / placed : undefined,
    self: d.receipts ? (d.selfGiven + d.selfLoans) / d.receipts : undefined,
  };
};

type Shares = ReturnType<typeof makeupShares>;
const medianOf = (values: number[]) => {
  const s = values.sort((a, b) => a - b);
  if (!s.length) return undefined;
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const makeupMedians = new Map<string, Record<keyof Shares, number | undefined>>();
/** The typical member of the chamber, share by share (each its own median). */
export function chamberMakeupMedians(chamber: Member["chamber"]) {
  let out = makeupMedians.get(chamber);
  if (!out) {
    const shares = members
      .filter((x) => x.chamber === chamber)
      .flatMap((x) => {
        const d = donorMakeup(x);
        return d ? [makeupShares(d)] : [];
      });
    const pick = (k: keyof Shares) => medianOf(shares.flatMap((s) => (s[k] === undefined ? [] : [s[k]!])));
    out = { small: pick("small"), inState: pick("inState"), inDistrict: pick("inDistrict"), self: pick("self") };
    makeupMedians.set(chamber, out);
  }
  return out;
}
