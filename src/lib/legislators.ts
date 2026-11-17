// Current members of Congress from github.com/unitedstates/congress-legislators
const URL =
  "https://unitedstates.github.io/congress-legislators/legislators-current.json";

interface RawLegislator {
  id: { bioguide: string; fec?: string[] };
  name: {
    first: string;
    last: string;
    middle?: string;
    nickname?: string;
    official_full?: string;
  };
  terms: {
    type: "rep" | "sen";
    state: string;
    district?: number;
    party: string;
    url?: string;
    /** Senate class: 1, 2 or 3. */
    class?: 1 | 2 | 3;
    start: string;
    end: string;
  }[];
}

export interface Legislator {
  bioguide: string;
  fec: string[];
  name: string;
  first: string;
  last: string;
  nickname?: string;
  chamber: "house" | "senate";
  state: string;
  district?: number;
  party: string;
  url?: string;
  /** Senators: which of the three staggered seats (class 1 is up in 2024, 2 in 2026, 3 in 2028). */
  senateClass?: 1 | 2 | 3;
  /** The current term, YYYY-MM-DD. A term starting 2027-01-03 or later was won in 2026 (or a special since). */
  termStart?: string;
  termEnd?: string;
}

export async function getCurrentLegislators(): Promise<Legislator[]> {
  const res = await fetch(URL);
  if (!res.ok) throw new Error(`Failed to fetch legislators: ${res.status}`);
  const raw = (await res.json()) as RawLegislator[];

  return raw.map((l) => {
    const term = l.terms.at(-1)!;
    return {
      bioguide: l.id.bioguide,
      fec: l.id.fec ?? [],
      name: l.name.official_full ?? `${l.name.first} ${l.name.last}`,
      first: l.name.first,
      last: l.name.last,
      nickname: l.name.nickname,
      chamber: term.type === "sen" ? "senate" : "house",
      state: term.state,
      district: term.district,
      party: term.party,
      url: term.url,
      senateClass: term.class,
      termStart: term.start,
      termEnd: term.end,
    };
  });
}

const HISTORICAL_URL = "https://unitedstates.github.io/congress-legislators/legislators-historical.json";

/** When each of these people's last term in Congress ended, from the historical file (members who have left). */
export async function lastTermEnds(bioguides: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!bioguides.length) return out;
  const res = await fetch(HISTORICAL_URL);
  if (!res.ok) throw new Error(`Failed to fetch historical legislators: ${res.status}`);
  const wanted = new Set(bioguides);
  for (const l of (await res.json()) as RawLegislator[]) {
    if (wanted.has(l.id.bioguide)) out.set(l.id.bioguide, l.terms.at(-1)!.end);
  }
  return out;
}
