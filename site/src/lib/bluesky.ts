// Everything the site knows about the Bluesky side, at build time: the
// labels on each member's accounts, the lists, starter packs and feeds the
// labeler account publishes, and cached public profile data. The lists and
// labels come from the same code that publishes them (src/lib), so links and
// labels here always match what's live.
import fs from "node:fs";
import path from "node:path";
import { members, cycles, congressCommittees, organizationById, memberById, type Member } from "./data";
import { buildSpecs, specUrl, rkeyFor, HANDLE, LABELER_DID, STATES, type Spec } from "../../../src/lib/list-specs.ts";
import { memberLabels, PER_KIND, type MemberLabel } from "../../../src/lib/labels.ts";
import { FEEDS, feedMembership } from "../../../feeds/feeds.ts";

export { HANDLE, LABELER_DID, STATES, PER_KIND, type MemberLabel };

export const BSKY = "https://bsky.app";
export const LABELER_URL = `${BSKY}/profile/${HANDLE}`;
export const DATA_HANDLE = "data.contributions.fyi";
export const DATA_REPO_URL = `${BSKY}/profile/${DATA_HANDLE}`;
export const profileUrl = (handle: string) => `${BSKY}/profile/${handle}`;

// --- profiles (pnpm bluesky-profiles) ---------------------------------------

export interface Profile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
  followersCount?: number;
  postsCount?: number;
}
const PROFILES_FILE = path.resolve(process.cwd(), "../data/bluesky-profiles.json");
const cache: { fetchedAt?: string; labeler: { likeCount: number }; profiles: Record<string, Profile> } = fs.existsSync(PROFILES_FILE)
  ? JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8"))
  : { labeler: { likeCount: 0 }, profiles: {} };
export const profiles = cache.profiles;
export const labelerLikes = cache.labeler.likeCount;
export const labelerFollowers = profiles[LABELER_DID]?.followersCount ?? 0;

/** A member's accounts with whatever profile data we have, the official one first. */
export function accountsOf(m: Member) {
  return [...m.accounts]
    .sort((a, b) => Number(/\.(house|senate)\.gov$/.test(b.handle)) - Number(/\.(house|senate)\.gov$/.test(a.handle)))
    .map((a) => ({ ...a, ...profiles[a.did], handle: a.handle, url: profileUrl(a.handle) }));
}
export const mainAccount = (m: Member) => accountsOf(m)[0];
/** The most followers on any of a member's accounts. */
export const followers = (m: Member) => Math.max(0, ...m.accounts.map((a) => profiles[a.did]?.followersCount ?? 0));

// --- labels -----------------------------------------------------------------

export const labelsFor = (m: Member): MemberLabel[] => memberLabels(m, organizationById);

// --- lists and starter packs ------------------------------------------------

export interface Output {
  key: string;
  kind: "labeler" | "feed" | "list" | "pack" | "data";
  name: string;
  /** One line on what it is. */
  blurb: string;
  url: string;
  group: string;
  /** Members (not accounts) it covers. */
  count: number;
  bioguides: string[];
  /** A site page it belongs with: a state filter, committee, sector. */
  ref?: string;
  href?: string;
}

const specs = buildSpecs(members, congressCommittees, cycles);
const sectorSlug = (s: string) => s.toLowerCase().replace(/&/g, "and").replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "");

const GROUP: Record<Spec["group"], string> = {
  everyone: "Everyone",
  pack: "Starter packs",
  state: "State delegations",
  committee: "Committees",
  sector: "Top recipients by industry",
};
function specOutput(s: Spec): Output {
  const blurb =
    s.group === "sector"
      ? `The ${s.bioguides.length} members on Bluesky who got the most from ${s.ref}`
      : s.group === "pack"
        ? `Follow all ${s.bioguides.length} at once, plus @${HANDLE}`
        : s.group === "state"
          ? `${s.bioguides.length} members on Bluesky`
          : s.group === "committee"
            ? `${s.bioguides.length} members on Bluesky`
            : `All ${s.bioguides.length} members we've matched to an account`;
  const href =
    s.group === "committee" ? `/committees/${s.ref}/` : s.group === "sector" ? `/sectors/${sectorSlug(s.ref!)}/` : s.group === "state" ? `/members/?state=${s.ref}` : undefined;
  return {
    key: s.key,
    kind: s.pack ? "pack" : "list",
    name: s.group === "committee" ? s.name.replace(/ on Bluesky$/, "") : s.group === "state" ? STATES[s.ref!] ?? s.ref! : s.group === "sector" ? s.ref! : s.name,
    blurb,
    url: specUrl(s),
    group: GROUP[s.group],
    count: s.bioguides.length,
    bioguides: s.bioguides,
    ref: s.ref,
    href,
  };
}
export const lists = specs.filter((s) => !s.pack).map(specOutput);
export const packs = specs.filter((s) => s.pack).map(specOutput);
export const listsByGroup = Map.groupBy(lists, (l) => l.group);

export const stateList = (state: string) => lists.find((l) => l.key === `state-${state.toLowerCase()}`);
export const committeeList = (id: string) => lists.find((l) => l.key === `committee-${id.toLowerCase()}`);
export const sectorList = (sector: string) => lists.find((l) => l.key === `sector-${sectorSlug(sector)}`);
export const everyoneList = lists.find((l) => l.key === "congress")!;

// --- feeds ------------------------------------------------------------------

const { byFeed } = feedMembership(members);
const didToBioguide = new Map(members.flatMap((m) => m.accounts.map((a) => [a.did, m.bioguide])));
export const feeds: Output[] = FEEDS.map((f) => {
  const bioguides = [...new Set((byFeed.get(f.rkey) ?? []).map((d) => didToBioguide.get(d)!))];
  const sector = f.description.match(/include (.+?): PAC money/)?.[1];
  return {
    key: `feed-${f.rkey}`,
    kind: "feed",
    name: f.displayName,
    blurb: sector ? `Posts from members whose top ${PER_KIND} funding sectors include ${sector}` : f.description.split(". ")[0]!,
    url: `${BSKY}/profile/${HANDLE}/feed/${f.rkey}`,
    group: sector ? "Funded by an industry" : "By chamber",
    count: bioguides.length,
    bioguides,
    ref: sector,
    href: sector ? `/sectors/${sectorSlug(sector)}/` : undefined,
  };
});
export const sectorFeed = (sector: string) => feeds.find((f) => f.ref === sector);

export const labeler: Output = {
  key: "labeler",
  kind: "labeler",
  name: `@${HANDLE}`,
  blurb: `Labels each member's account with their top ${PER_KIND} funding sectors and top ${PER_KIND} contributors`,
  url: LABELER_URL,
  group: "Labeler",
  count: members.filter((m) => m.accounts.length).length,
  bioguides: members.filter((m) => m.accounts.length).map((m) => m.bioguide),
};
export const dataRepo: Output = {
  key: "data",
  kind: "data",
  name: `@${DATA_HANDLE}`,
  blurb: "Every number on this site as open atproto records",
  url: DATA_REPO_URL,
  group: "Open data",
  count: members.length,
  bioguides: [],
  href: "/open-data/",
};

/** Everything we publish, for the directory. */
export const outputs: Output[] = [labeler, ...feeds, ...packs, ...lists, dataRepo];

// --- coverage ---------------------------------------------------------------

export const onBluesky = members.filter((m) => m.accounts.length);
export const accountCount = new Set(onBluesky.flatMap((m) => m.accounts.map((a) => a.did))).size;
export function coverage(filter: (m: Member) => boolean = () => true) {
  const all = members.filter(filter);
  const on = all.filter((m) => m.accounts.length);
  return { on: on.length, of: all.length };
}
export const coverageBy = {
  senateD: coverage((m) => m.chamber === "senate" && m.party !== "Republican"),
  senateR: coverage((m) => m.chamber === "senate" && m.party === "Republican"),
  houseD: coverage((m) => m.chamber === "house" && m.party !== "Republican"),
  houseR: coverage((m) => m.chamber === "house" && m.party === "Republican"),
  D: coverage((m) => m.party === "Democrat"),
  R: coverage((m) => m.party === "Republican"),
  I: coverage((m) => m.party === "Independent"),
};
export { memberById, rkeyFor };
