// Match every current member of Congress to their Bluesky account(s).
//
// Writes:
//   data/accounts.json  - accepted matches (bioguide -> accounts)
//   data/review.json    - plausible matches that need a human to confirm
//
// Manual corrections live in data/account-overrides.json.
import fs from "fs";
import {
  getListMembers,
  getProfiles,
  isVerified,
  resolveHandle,
  searchActors,
  type Profile,
} from "../lib/bsky.js";
import { mapLimit } from "../lib/async.js";
import type { Legislator } from "../lib/legislators.js";

const LABELER_LIST =
  "at://did:plc:ylmdlijvrvgbe4md6v4dyce6/app.bsky.graph.list/3lbgx3lqlwk2d";
const OVERRIDES_FILE = "data/account-overrides.json";
const DM_LEADS_FILE = "dm-leads.local.json";

type Source =
  | "official-domain"
  | "gov-handle"
  | "verified"
  | "labeler-list"
  | "previous-data"
  | "dm"
  | "search"
  | "override";

interface Candidate {
  profile: Profile;
  sources: Set<Source>;
}

interface Overrides {
  [bioguide: string]: { include?: string[]; exclude?: string[] };
}

const TITLES = new Set([
  "rep", "representative", "sen", "senator", "congressman",
  "congresswoman", "congressmember", "leader", "whip", "speaker",
  "dr", "jr", "sr", "ii", "iii", "iv", "us", "u", "s", "the",
]);

const POLITICAL =
  /congress|senat|represent|\brep\b|house|district|caucus|committee|serving/i;

// Bridges and bots that mirror an official account rather than being one.
const MIRROR_HANDLE = /\.(brid\.gy|govpeeps\.us)$/;
const NOT_OFFICIAL = /parody|fan ?(club|account|page)|not affiliated|unofficial|satire/i;

function tokens(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, " ")
    .split(/[\s-]+/)
    .filter((t) => t && !TITLES.has(t));
}

// Short forms that aren't a prefix of the formal name (Chris/Christopher is
// handled by the prefix check below).
const NICKNAMES: Record<string, string[]> = {
  robert: ["bob", "bobby"],
  william: ["bill", "billy"],
  james: ["jim", "jimmy"],
  michael: ["mike"],
  richard: ["dick", "rick"],
  edward: ["ted", "ed"],
  charles: ["chuck"],
  thomas: ["tom"],
  joseph: ["joe"],
  elizabeth: ["liz", "beth"],
  margaret: ["maggie", "peggy"],
  jesus: ["chuy"],
};

function nameScore(profile: Profile, l: Legislator) {
  const display = tokens(profile.displayName ?? "");
  const displaySet = new Set(display);
  const handle = profile.handle.toLowerCase().replace(/[^a-z]/g, "");
  const last = tokens(l.last);
  const firsts = [l.first, l.nickname]
    .filter(Boolean)
    .flatMap((n) => tokens(n!))
    .flatMap((t) => [t, ...(NICKNAMES[t] ?? [])]);

  const lastMatch =
    last.every((t) => displaySet.has(t)) || handle.includes(last.join(""));
  const firstMatch = firsts.some(
    (f) =>
      displaySet.has(f) ||
      handle.includes(f) ||
      display.some((t) => t.length >= 3 && f.startsWith(t))
  );

  return { lastMatch, firstMatch };
}

function hostOf(url?: string) {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

function classify(c: Candidate, l: Legislator) {
  const { lastMatch, firstMatch } = nameScore(c.profile, l);
  const s = c.sources;
  const text = `${c.profile.displayName ?? ""} ${c.profile.description ?? ""}`;

  if (s.has("override") || s.has("official-domain")) return "accepted";
  if (c.profile.handle === "handle.invalid" || !lastMatch) return null;
  if (MIRROR_HANDLE.test(c.profile.handle) || NOT_OFFICIAL.test(text)) return null;
  const political = POLITICAL.test(text);
  if (!firstMatch) return political || s.has("dm") ? "review" : null;

  if (s.has("gov-handle")) return "accepted";
  if (s.has("labeler-list") || s.has("previous-data")) return "accepted";
  if (s.has("verified") && political) return "accepted";
  if (political || s.has("dm")) return "review";
  return null;
}

function readJson<T>(file: string, fallback: T): T {
  return fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf8")) as T)
    : fallback;
}

export async function discoverAccounts(legislators: Legislator[]) {
  const overrides = readJson<Overrides>(OVERRIDES_FILE, {});
  const dmLeads = readJson<string[]>(DM_LEADS_FILE, []);
  console.log(`${legislators.length} current legislators`);

  // Profiles we already know about, keyed by DID, with where they came from.
  const known = new Map<string, Candidate>();
  const addKnown = (profiles: Profile[], source: Source) => {
    for (const p of profiles) {
      const c = known.get(p.did) ?? { profile: p, sources: new Set() };
      c.sources.add(source);
      known.set(p.did, c);
    }
  };

  addKnown(await getListMembers(LABELER_LIST), "labeler-list");
  addKnown(
    await getProfiles(Object.keys(readJson("contributions.json", {}))),
    "previous-data"
  );
  if (dmLeads.length) addKnown(await getProfiles(dmLeads), "dm");
  console.log(`${known.size} previously known accounts`);

  const results = await mapLimit(legislators, 6, async (l) => {
    const candidates = new Map<string, Candidate>();
    const add = (p: Profile, source: Source) => {
      const c =
        candidates.get(p.did) ??
        { profile: p, sources: new Set(known.get(p.did)?.sources ?? []) };
      c.sources.add(source);
      if (isVerified(p)) c.sources.add("verified");
      if (/\.(house|senate)\.gov$/.test(p.handle)) c.sources.add("gov-handle");
      candidates.set(p.did, c);
    };

    const host = hostOf(l.url);
    const officialDid = host ? await resolveHandle(host) : null;

    const queries = new Set([
      l.name,
      `${l.nickname ?? l.first} ${l.last}`,
    ]);
    const searched = (
      await Promise.all([...queries].map((q) => searchActors(q, 15)))
    ).flat();

    const overrideIds = overrides[l.bioguide]?.include ?? [];
    const extra = await getProfiles(
      [officialDid, ...overrideIds].filter((x): x is string => !!x)
    );

    for (const p of searched) add(p, "search");
    for (const c of known.values()) add(c.profile, [...c.sources][0]!);
    for (const p of extra) {
      if (p.did === officialDid) add(p, "official-domain");
      if (overrideIds.includes(p.did) || overrideIds.includes(p.handle)) {
        add(p, "override");
      }
    }

    const excluded = new Set(overrides[l.bioguide]?.exclude ?? []);
    const accepted: Candidate[] = [];
    const review: Candidate[] = [];
    for (const c of candidates.values()) {
      if (excluded.has(c.profile.did) || excluded.has(c.profile.handle)) continue;
      const verdict = classify(c, l);
      if (verdict === "accepted") accepted.push(c);
      else if (verdict === "review") review.push(c);
    }

    return { legislator: l, accepted, review };
  });

  const toAccount = (c: Candidate) => ({
    did: c.profile.did,
    handle: c.profile.handle,
    displayName: c.profile.displayName,
    sources: [...c.sources].sort(),
  });
  const toMember = (l: Legislator) => ({
    bioguide: l.bioguide,
    name: l.name,
    chamber: l.chamber,
    state: l.state,
    district: l.district,
    party: l.party,
  });

  // A DID can only belong to one member; if it was accepted for someone, it
  // shouldn't show up as a review candidate for anyone else.
  const claimed = new Set(results.flatMap((r) => r.accepted.map((c) => c.profile.did)));

  const accounts = results
    .filter((r) => r.accepted.length)
    .map((r) => ({ ...toMember(r.legislator), accounts: r.accepted.map(toAccount) }));

  const review = results
    .map((r) => ({
      ...toMember(r.legislator),
      matched: r.accepted.length > 0,
      candidates: r.review
        .filter((c) => !claimed.has(c.profile.did))
        .map((c) => ({ ...toAccount(c), description: c.profile.description })),
    }))
    .filter((r) => r.candidates.length);

  const unclaimed = [...known.values()].filter((c) => !claimed.has(c.profile.did));
  const describe = (c: Candidate) => ({ ...toAccount(c), description: c.profile.description });

  // Accounts we used to label that no longer match a current member.
  const stale = unclaimed
    .filter((c) => c.sources.has("labeler-list") || c.sources.has("previous-data"))
    .map(describe);
  // Accounts people DM'd us about that we couldn't tie to a member.
  const unmatchedDmLeads = unclaimed
    .filter((c) => c.sources.size === 1 && c.sources.has("dm"))
    .map(describe);

  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/accounts.json", JSON.stringify(accounts, null, 2) + "\n");
  fs.writeFileSync(
    "data/review.json",
    JSON.stringify({ review, stale, unmatchedDmLeads }, null, 2) + "\n"
  );

  const unmatched = results.filter((r) => !r.accepted.length);
  console.log(
    `Matched ${accounts.length}/${legislators.length} members ` +
      `(${accounts.reduce((n, a) => n + a.accounts.length, 0)} accounts)`
  );
  console.log(`${unmatched.length} unmatched, ${review.length} with review candidates`);
  console.log(`${stale.length} previously labeled accounts no longer match a current member`);

  return accounts;
}
