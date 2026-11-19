// Helpers for the Bluesky hub: flat card rows for the member finder, avatar
// faces and small formatters.
import fs from "node:fs";
import path from "node:path";
import { members, organizationById, sectorSlug, partyLetter, type Member } from "./data";
import { labelsFor, mainAccount, accountsOf, followers, profiles, LABELER_DID, memberById } from "./bluesky";
import { shortSector, surname } from "./format";
import type { CardRow, CardLabel, Face } from "../islands/bluesky/types";

export type { CardRow, CardLabel, Face };

const PROFILES_FILE = path.resolve(process.cwd(), "../data/bluesky-profiles.json");
const fetchedAt: string | undefined = fs.existsSync(PROFILES_FILE) ? JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8")).fetchedAt : undefined;
/** When follower counts were fetched: "Nov. 15, 2026". */
export const profilesAsOf = fetchedAt
  ? new Date(fetchedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
  : undefined;

export const labelerAvatar = profiles[LABELER_DID]?.avatar;

export const initials = (name: string) => `${name[0] ?? ""}${surname(name)[0] ?? ""}`;

/** "TX-30", "Senator", "TX at large". */
export function shortSeat(m: Member) {
  if (m.chamber === "senate") return `Senator, ${m.state}`;
  return m.district ? `${m.state}-${m.district}` : `${m.state} at large`;
}

/** Where a label points on this site. */
export function labelHref(l: { kind: string; id: string }) {
  if (l.kind === "sector") return `/sectors/${sectorSlug(l.id)}/`;
  if (l.kind === "contributor") return organizationById.has(l.id) ? `/organizations/${l.id}/` : undefined;
  return undefined;
}

const CARD_KIND = { sector: "s", contributor: "c", "small-donors": "d", "home-state": "d" } as const;
export function cardLabels(m: Member): CardLabel[] {
  return labelsFor(m).map((l) => ({ k: CARD_KIND[l.kind], n: l.kind === "sector" ? shortSector(l.name) : l.name, h: labelHref(l) }));
}

/** One member, flattened for a profile card. */
export function cardRow(m: Member): CardRow {
  const a = mainAccount(m);
  return {
    id: m.bioguide,
    name: m.name,
    party: partyLetter(m.party) as CardRow["party"],
    chamber: m.chamber as CardRow["chamber"],
    state: m.state,
    seat: shortSeat(m),
    district: m.chamber === "senate" ? -1 : Number(m.district ?? 0),
    ...(a
      ? {
          handle: a.handle,
          avatar: a.avatar,
          followers: followers(m),
          labels: cardLabels(m),
          more: m.accounts.length - 1 || undefined,
        }
      : {}),
  };
}


export function face(m: Member): Face {
  return { id: m.bioguide, name: m.name, party: partyLetter(m.party) as Face["party"], avatar: mainAccount(m)?.avatar };
}
/** Faces for a set of members, most-followed first. */
export function facesOf(bioguides: string[], n = 8, keepOrder = false): Face[] {
  const ms = bioguides.map((b) => memberById.get(b)).filter((m): m is Member => !!m && m.accounts.length > 0);
  if (!keepOrder) ms.sort((a, b) => followers(b) - followers(a));
  return ms.slice(0, n).map(face);
}

/** 2,210,910 -> "2.2M"; 12,345 -> "12K"; 950 -> "950". */
export function compact(n: number) {
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: n >= 1e6 ? 1 : 0 }).format(n);
}

export { accountsOf };
