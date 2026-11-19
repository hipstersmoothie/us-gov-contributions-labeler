// A state's delegation added up, for the state pages, the states index and
// their link-preview cards.
import { organizationById, partyLetter, committeeLabel, committeeHref, spenderType } from "./data";
import { surname } from "./format";
import { pacTotal, raisedTotal } from "./derived";
import { delegationMembers, type Delegation } from "./districts";

const NOT_INDUSTRY = new Set(["Unknown", "Party & Candidate Committees", "Retired", "Not employed"]);

export interface StateSummary {
  d: Delegation;
  members: ReturnType<typeof delegationMembers>;
  pac: number;
  raised: number;
  counts: { D: number; I: number; R: number };
  vacant: number;
  /** PAC and employee money by industry, across the delegation. */
  industries: { id: string; total: number; members: number }[];
  /** Organizations (their PACs and employees) and employers without a PAC. */
  contributors: { id: string; name: string; total: number; pacs: number; individuals: number; earmarked: number; members: number; href?: string }[];
  /** Outside spending naming the delegation's members, by group; support and opposition apart. */
  outside: { support: number; oppose: number; opponents: { support: number; oppose: number }; spenders: { id: string; label: string; href: string; note: string; support: number; oppose: number }[] };
}

export function summarizeState(d: Delegation): StateSummary {
  const ms = delegationMembers(d);
  const counts = { D: 0, I: 0, R: 0 };
  for (const m of ms) counts[partyLetter(m.party) as keyof typeof counts]++;

  const industries = new Map<string, { id: string; total: number; members: number }>();
  for (const m of ms) {
    for (const s of m.combinedSectors?.length ? m.combinedSectors : m.sectors) {
      if (NOT_INDUSTRY.has(s.id) || s.total <= 0) continue;
      const row = industries.get(s.id) ?? { id: s.id, total: 0, members: 0 };
      row.total += s.total;
      row.members++;
      industries.set(s.id, row);
    }
  }

  const contributors = new Map<string, StateSummary["contributors"][number]>();
  for (const m of ms) {
    for (const c of m.contributors ?? []) {
      const row = contributors.get(c.id) ?? {
        id: c.id,
        name: c.name,
        total: 0,
        pacs: 0,
        individuals: 0,
        earmarked: 0,
        members: 0,
        href: organizationById.has(c.id) ? `/organizations/${c.id}/` : undefined,
      };
      row.total += c.total;
      row.pacs += c.pacs;
      row.individuals += c.individuals;
      row.earmarked += c.earmarked ?? 0;
      row.members++;
      contributors.set(c.id, row);
    }
  }

  const spenders = new Map<string, { support: number; oppose: number; on: string[] }>();
  const outside = { support: 0, oppose: 0, opponents: { support: 0, oppose: 0 } };
  for (const m of ms) {
    outside.support += m.outside.support;
    outside.oppose += m.outside.oppose;
    outside.opponents.support += m.opponents?.support ?? 0;
    outside.opponents.oppose += m.opponents?.oppose ?? 0;
    for (const x of m.outside.spenders) {
      const row = spenders.get(x.id) ?? { support: 0, oppose: 0, on: [] };
      row.support += x.support;
      row.oppose += x.oppose;
      row.on.push(surname(m.name));
      spenders.set(x.id, row);
    }
  }

  return {
    d,
    members: ms,
    outside: {
      ...outside,
      spenders: [...spenders]
        .sort((a, b) => b[1].support + b[1].oppose - (a[1].support + a[1].oppose))
        .map(([id, x]) => ({
          id,
          label: committeeLabel(id),
          href: committeeHref(id),
          note: [spenderType(id), x.on.length <= 2 ? `on ${x.on.join(" and ")}` : `on ${x.on.length} members`].filter(Boolean).join(" · "),
          support: x.support,
          oppose: x.oppose,
        })),
    },
    pac: ms.reduce((s, m) => s + pacTotal(m), 0),
    raised: ms.reduce((s, m) => s + raisedTotal(m), 0),
    counts,
    vacant: d.house.filter((h) => !h.member).length,
    industries: [...industries.values()].sort((a, b) => b.total - a.total),
    contributors: [...contributors.values()].sort((a, b) => b.total - a.total),
  };
}

/** "2 senators and 9 representatives", "1 delegate". */
export function makeup(s: StateSummary) {
  const reps = s.d.house.length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (!s.d.senators.length) return s.d.state === "PR" ? "1 resident commissioner" : "1 delegate";
  return `${plural(s.d.senators.length, "senator", "senators")} and ${plural(reps, "representative", "representatives")}`;
}

/** "6 Republicans and 5 Democrats". */
export function partyCounts(c: StateSummary["counts"]) {
  const words: [number, string, string][] = [
    [c.R, "Republican", "Republicans"],
    [c.D, "Democrat", "Democrats"],
    [c.I, "independent", "independents"],
  ];
  const parts = words
    .filter(([n]) => n > 0)
    .sort((a, b) => b[0] - a[0])
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`);
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
