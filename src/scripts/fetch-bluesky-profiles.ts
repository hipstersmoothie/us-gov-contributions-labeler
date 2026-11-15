// Public Bluesky profile data for the site: each matched member account's
// avatar, display name and follower count, plus the labeler's own profile.
// Read-only, from the public AppView; no login.
//
//   pnpm bluesky-profiles   writes data/bluesky-profiles.json
import fs from "fs";
import type { Member } from "../ingest/build.js";
import { LABELER_DID } from "../lib/list-specs.js";

const APPVIEW = "https://public.api.bsky.app/xrpc";
const BATCH = 25; // getProfiles limit

interface Profile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
  followersCount?: number;
  postsCount?: number;
}

const { members } = JSON.parse(fs.readFileSync("data/members.json", "utf8")) as { members: Member[] };
const dids = [LABELER_DID, "data.contributions.fyi", ...new Set(members.flatMap((m) => m.accounts.map((a) => a.did)))];

const profiles: Record<string, Profile> = {};
for (let i = 0; i < dids.length; i += BATCH) {
  const qs = new URLSearchParams(dids.slice(i, i + BATCH).map((d) => ["actors", d]));
  const res = await fetch(`${APPVIEW}/app.bsky.actor.getProfiles?${qs}`);
  if (!res.ok) throw new Error(`getProfiles failed: ${res.status} ${await res.text()}`);
  const { profiles: page } = (await res.json()) as { profiles: Profile[] };
  for (const p of page) {
    profiles[p.did] = {
      did: p.did,
      handle: p.handle,
      displayName: p.displayName,
      avatar: p.avatar,
      followersCount: p.followersCount,
      postsCount: p.postsCount,
    };
  }
}

const labelerRes = await fetch(`${APPVIEW}/app.bsky.labeler.getServices?dids=${LABELER_DID}&detailed=true`);
const labeler = labelerRes.ok ? ((await labelerRes.json()) as { views: { likeCount?: number }[] }).views[0] : undefined;

fs.writeFileSync(
  "data/bluesky-profiles.json",
  JSON.stringify({ fetchedAt: new Date().toISOString(), labeler: { likeCount: labeler?.likeCount ?? 0 }, profiles }, null, 1)
);
console.log(`Wrote ${Object.keys(profiles).length} profiles to data/bluesky-profiles.json`);
