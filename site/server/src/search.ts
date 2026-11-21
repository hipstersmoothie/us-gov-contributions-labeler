// Ranking for the search index (site/src/lib/search.ts builds the rows): the
// site's search box runs it in the browser, the MCP server's search tool here.
// "h", companies members own, is only in the MCP server's index.
export type SearchType = "m" | "c" | "o" | "p" | "d" | "b" | "f" | "t" | "r" | "n" | "h" | "v";
export type SearchRow = [type: SearchType, id: string, label: string, detail: string, weight: number];

const PATH: Record<SearchType, string> = { m: "members", c: "committees", o: "organizations", p: "pacs", d: "donors", b: "bills", f: "foreign-lobbying", t: "travel/sponsors", r: "races", n: "candidates", h: "holdings/companies", v: "vendors" };
export const urlFor = (type: SearchType, id: string) => `/${PATH[type]}/${id}/`;
/** What the MCP server's tools call each type. */
export const TYPE_NAMES: Record<SearchType, string> = {
  m: "member",
  n: "candidate",
  r: "race",
  o: "organization",
  p: "pac",
  d: "donor",
  t: "trip_sponsor",
  v: "vendor",
  b: "bill",
  c: "congress_committee",
  f: "country",
  h: "company",
};

export interface Hit {
  type: SearchType;
  id: string;
  url: string;
  label: string;
  detail: string;
  score: number;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");

/** Every term must appear in the label; prefix and word-start matches rank first, then money. */
export function search(rows: SearchRow[], query: string, perType = Infinity): Hit[] {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const counts = new Map<SearchType, number>();
  const hits: Hit[] = [];
  for (const [type, id, label, detail, weight] of rows) {
    const n = norm(label);
    if (!terms.every((t) => n.includes(t))) continue;
    const first = terms[0]!;
    const rank = n.startsWith(first) ? 0 : n.includes(` ${first}`) ? 1 : 2;
    hits.push({ type, id, url: urlFor(type, id), label, detail, score: rank * 1e10 - weight });
  }
  hits.sort((a, b) => a.score - b.score || a.label.length - b.label.length);
  return hits.filter((h) => {
    const c = counts.get(h.type) ?? 0;
    counts.set(h.type, c + 1);
    return c < perType;
  });
}
