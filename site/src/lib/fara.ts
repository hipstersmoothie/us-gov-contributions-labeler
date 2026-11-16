// Foreign lobbying under FARA, from ../data/fara.json (src/ingest/fara.ts):
// foreign principals by country, the US firms and people registered as their
// agents, and those agents' donations to current members.
//
// Registering as a foreign agent, and giving to campaigns while registered, is
// legal and disclosed. FARA doesn't tie a donation to a client, so donations are
// shown by agent and firm, never by country.
import fs from "node:fs";
import path from "node:path";
import type { FaraFile, FaraCountry, FaraRegistrant, FaraPrincipal, FaraGift } from "../../../src/ingest/fara.ts";

export type { FaraCountry as Country, FaraRegistrant as Registrant, FaraPrincipal as Principal, FaraGift as Gift };

const file = path.resolve(process.cwd(), "../data/fara.json");
const data: FaraFile = fs.existsSync(file)
  ? JSON.parse(fs.readFileSync(file, "utf8"))
  : { generatedAt: "", fetched: "", cycles: [], since: "", countries: [], registrants: [], principals: [], gifts: {} };

export const faraSince = data.since;
export const faraFetched = data.fetched;
export const countries = data.countries;
export const registrants = data.registrants;
export const principals = data.principals;
export const faraGifts = data.gifts;

export const countryById = new Map(countries.map((c) => [c.id, c]));
export const registrantById = new Map(registrants.map((r) => [r.id, r]));

export const principalsByCountry = new Map<string, FaraPrincipal[]>();
export const principalsByRegistrant = new Map<string, FaraPrincipal[]>();
export const registrantsByOrg = new Map<string, FaraRegistrant[]>();
export const principalsByOrg = new Map<string, FaraPrincipal[]>();
for (const p of principals) {
  principalsByCountry.set(p.country, [...(principalsByCountry.get(p.country) ?? []), p]);
  principalsByRegistrant.set(p.registrant, [...(principalsByRegistrant.get(p.registrant) ?? []), p]);
  if (p.organization) principalsByOrg.set(p.organization, [...(principalsByOrg.get(p.organization) ?? []), p]);
}
for (const r of registrants) if (r.organization) registrantsByOrg.set(r.organization, [...(registrantsByOrg.get(r.organization) ?? []), r]);

/** Countries a registrant has active principals in, most principals first. */
export function registrantCountries(id: string) {
  const counts = new Map<string, number>();
  for (const p of principalsByRegistrant.get(id) ?? []) if (!p.terminated) counts.set(p.country, (counts.get(p.country) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).map(([c]) => countryById.get(c)!).filter(Boolean);
}

/** Agents' donations by registrant: total, and to how many members. */
export const giftsByRegistrant = new Map<string, { total: number; members: Set<string>; agents: Set<string> }>();
for (const [bioguide, gifts] of Object.entries(data.gifts)) {
  for (const g of gifts) {
    const e = giftsByRegistrant.get(g.registrant) ?? { total: 0, members: new Set(), agents: new Set() };
    e.total += g.total;
    e.members.add(bioguide);
    e.agents.add(g.agent);
    giftsByRegistrant.set(g.registrant, e);
  }
}
export const memberGiftTotals = Object.entries(data.gifts)
  .map(([id, gifts]) => ({ id, total: gifts.reduce((s, g) => s + g.total, 0), agents: gifts.length }))
  .sort((a, b) => b.total - a.total);
export const giftsTotal = memberGiftTotals.reduce((s, m) => s + m.total, 0);
export const givingAgents = new Set(Object.values(data.gifts).flatMap((l) => l.map((g) => `${g.registrant}:${g.agent}`))).size;

/** The registrant's filings on efile.fara.gov. */
export const faraDocsUrl = (id: string) => `https://efile.fara.gov/ords/fara/f?p=1381:200:::NO:RP,200:P200_REG_NUMBER:${id}`;
/** A member's FEC receipts from one person. */
export const fecReceiptsUrl = (committee: string, agent: string) => {
  const parts = agent.split(" ");
  return (
    "https://www.fec.gov/data/receipts/individual-contributions/?" +
    new URLSearchParams({ committee_id: committee, contributor_name: `${parts.at(-1)}, ${parts[0]}` })
  );
};

/** "2021-03-04" -> "March 2021" */
export const monthYear = (iso: string) =>
  new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export const activeRegistrants = new Set(principals.filter((p) => !p.terminated).map((p) => p.registrant)).size;
export const activePrincipals = principals.filter((p) => !p.terminated).length;
