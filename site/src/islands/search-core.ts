// Client-side search over the compact index from src/lib/search.ts, ranked
// as the MCP server's search tool ranks it (server/src/search.ts).
import type { SearchRow, SearchType } from "../lib/search";
import type { Hit } from "../../server/src/search.ts";
export { search, urlFor, type Hit } from "../../server/src/search.ts";

export const TYPE_LABEL: Record<SearchType, string> = {
  m: "Members of Congress",
  c: "Congressional committees",
  o: "Organizations",
  p: "PACs and outside groups",
  d: "Big donors",
  b: "Bills",
  f: "Foreign lobbying by country",
  t: "Trip sponsors",
  v: "Campaign vendors",
  r: "House and Senate races",
  n: "Candidates",
  h: "Companies members own",
};
export const TYPE_ORDER: SearchType[] = ["m", "n", "r", "o", "p", "d", "v", "t", "b", "c", "f"];

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
