// Lobbyist bundling, from the campaigns' and leadership PACs' Form 3L reports
// (src/ingest/bundling.ts): each member's bundlers are on members.json, and the
// same bundlers are summed here across members for the /bundling/ page.
import type { BundlerRow } from "../../../src/ingest/build.ts";
import { members, committeeById, committeeLabel, organizationById } from "./data";

export const bundledMembers = members
  .filter((m) => m.bundling)
  .map((m) => ({ id: m.bioguide, total: m.bundling!.total, bundlers: m.bundling!.bundlers.length }))
  .sort((a, b) => b.total - a.total);

export const bundlingTotal = bundledMembers.reduce((sum, m) => sum + m.total, 0);

const byId = new Map<string, Omit<BundlerRow, "filings"> & { members: number }>();
for (const m of members) {
  for (const { filings: _, ...b } of m.bundling?.bundlers ?? []) {
    const row = byId.get(b.id);
    if (row) {
      row.total += b.total;
      row.members++;
    } else byId.set(b.id, { ...b, members: 1 });
  }
}
/** Every bundler, with what it bundled for all current members. */
export const bundlers = [...byId.values()].sort((a, b) => b.total - a.total);

/** A lobbyist PAC under the name of its committee page; a lobbyist as filed. */
export const bundlerName = (b: { name: string; committee?: string }) =>
  b.committee && committeeById.has(b.committee) ? committeeLabel(b.committee) : b.name;

/** "Lobbyist PAC", or the lobbyist's occupation and employer. */
export const bundlerNote = (b: { type: string; occupation?: string; employer?: string }) =>
  b.type === "pac" ? "Lobbyist PAC" : [b.occupation ? `Lobbyist, ${b.occupation.toLowerCase()}` : "Lobbyist", b.employer].filter(Boolean).join(" · ");

/** The organization's bundling section, else the PAC's page. */
export const bundlerHref = (b: { organization?: string; committee?: string }) => {
  const org = b.organization ? organizationById.get(b.organization) : undefined;
  if (org) return `/organizations/${org.id}/${org.bundled ? "#bundled" : ""}`;
  return b.committee && committeeById.has(b.committee) ? `/pacs/${b.committee}/` : undefined;
};
