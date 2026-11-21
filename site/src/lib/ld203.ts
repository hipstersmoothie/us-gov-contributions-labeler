// Honorary expenses and gifts to presidential committees from LD-203 lobbyist
// contribution reports (data/ld203.json, from src/ingest/ld203.ts).
import fs from "node:fs";
import path from "node:path";
import { memberById, organizationById, displayName, partyLetter } from "./data";
import { normalizeOrg } from "../../../src/lib/names.ts";
import type { Ld203Data, Ld203Item, Ld203Registrant, Ld203Type, PayeeClass, HonoreeClass } from "../../../src/ingest/ld203.ts";

export type { Ld203Item, Ld203Registrant, Ld203Type, PayeeClass, HonoreeClass };

const FILE = path.resolve(process.cwd(), "../data/ld203.json");
const file: Ld203Data = fs.existsSync(FILE)
  ? JSON.parse(fs.readFileSync(FILE, "utf8"))
  : { generatedAt: new Date(0).toISOString(), since: 2023, memberSince: "2025-01-03", items: [], registrants: {} };

export const items = file.items;
export const registrants = file.registrants;
export const honorarySince = file.since;
export const memberSince = file.memberSince;
export const honoraryUpdated = new Date(file.generatedAt);
export const registrantById = (id: number): Ld203Registrant | undefined => registrants[id];

export const TYPE_LABEL: Record<Ld203Type, string> = {
  he: "Honorary expenses",
  me: "Meeting expenses",
  ple: "Presidential library gifts",
  pic: "Inaugural committee gifts",
};
export const PAYEE_LABEL: Record<PayeeClass, string> = {
  caucus: "Caucus foundations and congressional institutes",
  nonprofit: "Nonprofits, charities, universities and awards events",
  venue: "Venues and vendors",
  other: "Other payees",
  pac: "PACs and campaigns",
  party: "Party committees",
  inaugural: "Inaugural committee",
  library: "Presidential libraries",
};
export const HONOREE_LABEL: Record<HonoreeClass | "member", string> = {
  member: "A current member of Congress",
  group: "A caucus, delegation or group of members",
  executive: "The President, Cabinet or other executive officials",
  official: "A former member, staff or other official",
  other: "Someone else, or described in prose",
  blank: "No honoree named",
};

/** Honorary and meeting items: the ones a member page or the index counts. */
export const honorary = items.filter((i) => i.type === "he" || i.type === "me");
export const inaugural = items.filter((i) => i.type === "pic");
export const library = items.filter((i) => i.type === "ple");

/** The date an item counts under: its own, or the day its report was posted. */
export const itemDate = (i: Ld203Item) => i.date ?? i.posted;

/** Items naming each current member, from memberSince on, newest first. */
export const itemsByMember = new Map<string, Ld203Item[]>();
for (const i of honorary) {
  if (itemDate(i) < memberSince) continue;
  for (const b of i.members) if (memberById.has(b)) itemsByMember.set(b, [...(itemsByMember.get(b) ?? []), i]);
}
/** Every item an organization on the site filed, all types, newest first. */
export const itemsByOrg = new Map<string, Ld203Item[]>();
for (const i of items) {
  const org = registrants[i.registrant]?.organization;
  if (org && organizationById.has(org)) itemsByOrg.set(org, [...(itemsByOrg.get(org) ?? []), i]);
}

/** A member's share of an item that names several people. */
export const share = (i: Ld203Item) => i.amount / Math.max(i.honorees, 1);

/** Who paid: the registrant, or a lobbyist filing their own report. */
export function filerName(i: Ld203Item) {
  const r = registrants[i.registrant];
  const org = r?.organization ? organizationById.get(r.organization) : undefined;
  const name = org?.name ?? displayName(r?.name ?? "");
  return i.lobbyist ? `${i.lobbyist} (${name})` : name;
}
export function filerHref(i: Ld203Item) {
  const org = registrants[i.registrant]?.organization;
  return org && organizationById.has(org) ? `/organizations/${org}/` : undefined;
}
export const payeeName = (i: Ld203Item) => displayName(i.payee);

export function summarize(list: Ld203Item[]) {
  return {
    items: list.length,
    total: list.reduce((s, i) => s + i.amount, 0),
    shared: list.filter((i) => i.honorees > 1).length,
    filers: new Set(list.map((i) => i.registrant)).size,
    payees: new Set(list.map((i) => normalizeOrg(i.payee))).size,
    members: new Set(list.flatMap((i) => i.members)).size,
  };
}

/** Payees grouped across spellings, largest first, named by the spelling paid the most. */
export function topPayees(list: Ld203Item[], n = Infinity) {
  const groups = new Map<string, { total: number; items: number; spellings: Map<string, number>; cls: PayeeClass }>();
  for (const i of list) {
    const key = normalizeOrg(i.payee) || i.payee;
    const g = groups.get(key) ?? { total: 0, items: 0, spellings: new Map(), cls: i.payeeClass };
    g.total += i.amount;
    g.items++;
    g.spellings.set(i.payee, (g.spellings.get(i.payee) ?? 0) + i.amount);
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => ({ name: displayName([...g.spellings].sort((a, b) => b[1] - a[1])[0]![0]), total: g.total, items: g.items, cls: g.cls }))
    .sort((a, b) => b.total - a.total)
    .slice(0, n);
}

/** Filers, largest first, with their organization page when they have one. */
export function topFilers(list: Ld203Item[], n = Infinity) {
  const totals = new Map<number, { total: number; items: number }>();
  for (const i of list) {
    const t = totals.get(i.registrant) ?? { total: 0, items: 0 };
    t.total += i.amount;
    t.items++;
    totals.set(i.registrant, t);
  }
  return [...totals]
    .map(([id, t]) => {
      const r = registrants[id]!;
      const org = r.organization ? organizationById.get(r.organization) : undefined;
      return { id, name: org?.name ?? displayName(r.name), href: org ? `/organizations/${org.id}/` : undefined, ...t };
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, n);
}

/** Members named, by their share of the items, largest first. */
export function topMembers(list: Ld203Item[], n = Infinity) {
  const totals = new Map<string, { total: number; items: number }>();
  for (const i of list) {
    for (const b of i.members) {
      if (!memberById.has(b)) continue;
      const t = totals.get(b) ?? { total: 0, items: 0 };
      t.total += share(i);
      t.items++;
      totals.set(b, t);
    }
  }
  return [...totals]
    .map(([id, t]) => ({ m: memberById.get(id)!, ...t }))
    .sort((a, b) => b.total - a.total)
    .slice(0, n);
}

/** What the honoree text names, for the index: a member, a group, the executive branch... */
export function honoreeBreakdown(list: Ld203Item[]) {
  const out = new Map<keyof typeof HONOREE_LABEL, number>();
  for (const i of list) {
    const k = i.members.length ? "member" : i.honoreeClass;
    out.set(k, (out.get(k) ?? 0) + i.amount);
  }
  return [...out].map(([key, total]) => ({ key, label: HONOREE_LABEL[key], total })).sort((a, b) => b.total - a.total);
}

/** The members an item names, linked, or the text as filed. */
export function honoreeLinks(i: Ld203Item) {
  return i.members.map((b) => memberById.get(b)).filter((m): m is NonNullable<typeof m> => !!m).map((m) => ({ name: m.name, href: `/members/${m.bioguide}/`, party: partyLetter(m.party) }));
}

const MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
export function dateLabel(iso: string) {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
export const sinceLabel = dateLabel(memberSince);
export const retrievedLabel = dateLabel(file.generatedAt.slice(0, 10));

/** Rows shown before "more". */
export const HONORARY_SHOWN = 8;

/** lda.gov's terms ask that the retrieval date and this line go with the data. */
export const LDA_NOTE = `Retrieved from lda.gov on ${retrievedLabel}; the Senate Office of Public Records cannot vouch for the data or analyses derived from it after retrieval.`;
export const WHAT_NOTE =
  "An honorary expense is what a company, trade group or union reported paying for an event that honored or recognized a member, such as a gala, an awards dinner or a scholarship fund. The money went to the payee listed, not to the member or a campaign, and reporting it is required of every registered lobbying organization.";
