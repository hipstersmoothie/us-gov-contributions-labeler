// Client-side search over the compact index from src/lib/search.ts.
import type { SearchRow, SearchType } from "../lib/search";

export const TYPE_LABEL: Record<SearchType, string> = {
  m: "Members of Congress",
  c: "Congressional committees",
  o: "Organizations",
  p: "PACs and outside groups",
  d: "Big donors",
  b: "Bills",
  f: "Foreign lobbying by country",
  t: "Trip sponsors",
  r: "House and Senate races",
  n: "Candidates",
};
export const TYPE_ORDER: SearchType[] = ["m", "n", "r", "o", "p", "d", "t", "b", "c", "f"];

const PATH: Record<SearchType, string> = { m: "members", c: "committees", o: "organizations", p: "pacs", d: "donors", b: "bills", f: "foreign-lobbying", t: "travel/sponsors", r: "races", n: "candidates" };
export const urlFor = (type: SearchType, id: string) => `/${PATH[type]}/${id}/`;

export interface Hit {
  type: SearchType;
  url: string;
  label: string;
  detail: string;
  score: number;
}

const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

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
    hits.push({ type, url: urlFor(type, id), label, detail, score: rank * 1e10 - weight });
  }
  hits.sort((a, b) => a.score - b.score || a.label.length - b.label.length);
  return hits.filter((h) => {
    const c = counts.get(h.type) ?? 0;
    counts.set(h.type, c + 1);
    return c < perType;
  });
}

export function group(hits: Hit[]) {
  return TYPE_ORDER.map((type) => ({ type, title: TYPE_LABEL[type], hits: hits.filter((h) => h.type === type) })).filter(
    (g) => g.hits.length
  );
}

let cache: Promise<SearchRow[]> | undefined;
/** The quick index, fetched once per page on first use. */
export function loadQuick() {
  cache ??= fetch("/search-quick.json").then((r) => r.json());
  return cache;
}
