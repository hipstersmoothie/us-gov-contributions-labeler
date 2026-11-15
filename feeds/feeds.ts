// The feeds, and which members' accounts belong in each.
//
// Membership comes from data/members.json: a member's top sectors are the
// same top 3 the labeler puts on their account (combinedSectors, skipping the
// non-industries), so a feed and the labels always agree.

export const PUBLISHER_DID = "did:plc:ylmdlijvrvgbe4md6v4dyce6";
export const SITE_URL = "https://contributions.fyi";

const TOP_SECTORS = 3;
// Same as sync-labels: not industries, or not informative.
const SKIP_SECTORS = new Set(["Unknown", "Party & Candidate Committees", "Retired", "Not employed"]);

export interface Member {
  name: string;
  chamber: "house" | "senate";
  accounts: { did: string; handle: string }[];
  combinedSectors: { id: string; total: number }[];
}

export interface Feed {
  /** Record key of the app.bsky.feed.generator record (keep it ≤ 15 chars). */
  rkey: string;
  /** At most 24 characters. */
  displayName: string;
  description: string;
  includes: (m: Member) => boolean;
}

export function topSectors(m: Member) {
  return m.combinedSectors
    .filter((s) => !SKIP_SECTORS.has(s.id))
    .slice(0, TOP_SECTORS)
    .map((s) => s.id);
}

const ONLY_POSTS = "Original posts and quote posts, newest first; no replies or reposts.";

function sectorFeed(rkey: string, sector: string, short: string): Feed {
  return {
    rkey,
    displayName: `Funded by ${short}`,
    description:
      `Posts from members of Congress whose top ${TOP_SECTORS} funding sectors include ${sector}: ` +
      `PAC money plus donations from the industry's employees, per FEC filings. ${ONLY_POSTS} ` +
      `Who funds whom: ${SITE_URL}`,
    includes: (m) => topSectors(m).includes(sector),
  };
}

export const FEEDS: Feed[] = [
  {
    rkey: "congress",
    displayName: "Congress",
    description: `Posts from current members of the US House and Senate. ${ONLY_POSTS} Who funds them: ${SITE_URL}`,
    includes: () => true,
  },
  {
    rkey: "senate",
    displayName: "Senate",
    description: `Posts from current US senators. ${ONLY_POSTS} Who funds them: ${SITE_URL}`,
    includes: (m) => m.chamber === "senate",
  },
  {
    rkey: "house",
    displayName: "House",
    description: `Posts from current members of the US House of Representatives. ${ONLY_POSTS} Who funds them: ${SITE_URL}`,
    includes: (m) => m.chamber === "house",
  },
  sectorFeed("finance", "Finance, Insurance & Real Estate", "Finance"),
  sectorFeed("health", "Health", "Health"),
  sectorFeed("labor", "Labor", "Labor"),
  sectorFeed("law-lobbying", "Lawyers & Lobbyists", "Law & Lobbying"),
  sectorFeed("tech", "Communications & Technology", "Tech"),
  sectorFeed("energy", "Energy & Natural Resources", "Energy"),
];

/** Each feed's author DIDs, plus every DID worth ingesting. */
export function feedMembership(members: Member[]) {
  const byFeed = new Map<string, string[]>();
  for (const feed of FEEDS) {
    byFeed.set(feed.rkey, [...new Set(members.filter(feed.includes).flatMap((m) => m.accounts.map((a) => a.did)))]);
  }
  const all = new Set(members.flatMap((m) => m.accounts.map((a) => a.did)));
  return { byFeed, all };
}
