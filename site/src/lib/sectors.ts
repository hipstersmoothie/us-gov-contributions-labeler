// Per-sector rollups shared by the sector pages and the home page.
import { SECTORS } from "../../../src/lib/sectors.ts";
import { members, organizations, sectorSlug, partySplit } from "./data";

export interface SectorSummary {
  name: string;
  slug: string;
  total: number;
  organizations: typeof organizations;
  recipients: { id: string; total: number }[];
  split: ReturnType<typeof partySplit>;
}

export const sectors: SectorSummary[] = SECTORS.map((name) => {
  const recipients = members
    .map((m) => ({ id: m.bioguide, total: m.sectors.find((s) => s.id === name)?.total ?? 0 }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total);
  return {
    name,
    slug: sectorSlug(name),
    total: recipients.reduce((s, r) => s + r.total, 0),
    organizations: organizations.filter((o) => o.sector === name),
    recipients,
    split: partySplit(recipients),
  };
})
  .filter((s) => s.total > 0)
  .sort((a, b) => b.total - a.total);
