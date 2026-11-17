// A post when a member's first Bluesky account turns up in members.json:
// "Welcome to Bluesky" if the account is new, otherwise that they're on
// Bluesky and in our lists and feeds (a newly matched account is often an
// old one).
import { memberLabels } from "../../src/lib/labels.js";
import type { Data, Member } from "../data.js";
import { fit, memberTag, title } from "../format.js";
import type { Draft } from "./types.js";

const NEW_ACCOUNT_DAYS = 30;
const APPVIEW = process.env.APPVIEW_URL ?? "https://public.api.bsky.app";

/** Official .house.gov / .senate.gov handles first, as on the site. */
export const mainAccount = (m: Member) =>
  [...m.accounts].sort((a, b) => Number(/\.(house|senate)\.gov$/.test(b.handle)) - Number(/\.(house|senate)\.gov$/.test(a.handle)))[0];

/** The account's profile from the public AppView; undefined if it can't be had (deactivated, or the AppView is down). */
export async function fetchProfile(did: string): Promise<{ handle: string; createdAt?: string } | undefined> {
  try {
    const res = await fetch(`${APPVIEW}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`);
    return res.ok ? ((await res.json()) as { handle: string; createdAt?: string }) : undefined;
  } catch {
    return undefined;
  }
}

/** Members with at least one account. */
export const membersOnBluesky = (data: Data) => data.members.filter((m) => m.accounts.length > 0);

/**
 * Posts for members on Bluesky who aren't in `seen` (bioguide ids). The
 * caller records them as seen, so a member gets one post however many
 * accounts they add, and none for an account that comes back.
 */
export async function newOnBluesky(data: Data, seen: Set<string>, profile = fetchProfile): Promise<Draft[]> {
  const on = membersOnBluesky(data);
  const drafts: Draft[] = [];
  for (const m of on.filter((m) => !seen.has(m.bioguide))) {
    const account = mainAccount(m)!;
    // Mention the handle the network has now, and wait while it has none that resolves.
    const p = await profile(account.did);
    if (!p || p.handle === "handle.invalid") continue;
    const fresh = !!p.createdAt && Date.now() - Date.parse(p.createdAt) < NEW_ACCOUNT_DAYS * 24 * 60 * 60 * 1000;
    const labels = memberLabels(m, data.orgById);
    const sectors = labels.filter((l) => l.kind === "sector").map((l) => l.name);
    const contributors = labels.filter((l) => l.kind === "contributor").map((l) => l.name);
    const who = `${title(m)} ${m.name} (${memberTag(m)})`;
    const handle = `@${p.handle}`;
    const text = fit([
      ...(fresh
        ? [{ text: `Welcome to Bluesky, ${handle}!` }, { text: `\n${who} makes ${on.length} members of Congress here.` }]
        : [{ text: `${who} is on Bluesky: ${handle}` }, { text: `\nThat makes ${on.length} members of Congress here, all in our lists and feeds.` }]),
      ...(sectors.length ? [{ text: `Top industries: ${sectors.join(", ")}.`, optional: true }] : []),
      ...(contributors.length ? [{ text: `Top contributors: ${contributors.join(", ")}.`, optional: true }] : []),
    ]);
    drafts.push({
      key: `bsky:${m.bioguide}`,
      series: "new-on-bluesky",
      text,
      link: `/members/${m.bioguide}/`,
      mentions: { [p.handle]: account.did },
      priority: 2,
    });
  }
  return drafts;
}
