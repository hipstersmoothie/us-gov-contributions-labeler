// Current members of Congress from github.com/unitedstates/congress-legislators
const URL =
  "https://unitedstates.github.io/congress-legislators/legislators-current.json";

interface RawLegislator {
  id: { bioguide: string; fec?: string[]; opensecrets?: string };
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
  }[];
}

export interface Legislator {
  bioguide: string;
  fec: string[];
  opensecrets?: string;
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
      opensecrets: l.id.opensecrets,
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
    };
  });
}
