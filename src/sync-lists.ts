// Keep the labeler account's Bluesky lists and starter packs in line with data/.
//
//   pnpm sync-lists                         dry run: show what would change
//   pnpm sync-lists --apply                 publish it; stops at the rate-limit budget, re-run to continue
//   pnpm sync-lists --apply --wait          or wait out each hourly window
//   pnpm sync-lists --apply --only=state-de publish just these lists/packs (comma-separated keys)
//
// Lists (curatelists): everyone, each state delegation with 2+ members on
// Bluesky, each full committee with 3+, and the top recipients of each
// sector's money. Starter packs: the Senate and two halves of the House (a
// starter pack holds at most 150 accounts), each with the labeler itself.
//
// Each list and starter pack has a record key derived from its key (a TID
// dated in 2023, before this account existed), so re-runs find their own
// records, URLs stay stable, and lists we no longer want can be told apart
// from hand-made ones. Only differences are written: an interrupted or
// rate-limited run picks up where it stopped.
//
// The PDS budgets repo writes per account: 5,000 points an hour and 35,000 a
// day, at 3 per create, 2 per update and 1 per delete. The labeler's other
// jobs write to the same repo, so this stops once 70% of the current window
// is spent (--budget).
import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import { parseArgs } from "util";
import { RichText } from "@atproto/api";
import type { Member } from "./ingest/build.js";
import type { CongressCommittee } from "./ingest/assignments.js";

const DID = (process.env.LABELER_DID ?? process.env.DID ?? "did:plc:ylmdlijvrvgbe4md6v4dyce6") as `did:${string}`;
const HANDLE = "contributions.fyi";
const SITE = "https://contributions.fyi";
const AVATAR = "design/logo/avatar.png";
// The hand-made list this replaces. Its items stay: the ingest uses them as known accounts.
const RETIRED_LIST = "3lbgx3lqlwk2d";
const SECTOR_TOP = 25;
const MIN_STATE = 2;
const MIN_COMMITTEE = 3;
const PACK_MAX = 150; // accounts per starter pack, Bluesky app limit
const SKIP_SECTORS = new Set(["Unknown", "Party & Candidate Committees", "Retired", "Not employed"]);
const MAX_WRITES = 200; // per applyWrites call, PDS limit
const COST = { create: 3, update: 2, delete: 1 } as const;
const HOURLY_POINTS = 5000;
const LIST = "app.bsky.graph.list";
const ITEM = "app.bsky.graph.listitem";
const PACK = "app.bsky.graph.starterpack";

const { values: args } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    wait: { type: "boolean", default: false },
    only: { type: "string" },
    budget: { type: "string", default: "0.7" },
    "allow-deletes": { type: "boolean", default: false },
  },
});
const BUDGET = Number(args.budget);
const only = args.only?.split(",");

const { members, cycles } = JSON.parse(fs.readFileSync("data/members.json", "utf8")) as {
  members: Member[];
  cycles: number[];
};
const { committees } = JSON.parse(fs.readFileSync("data/congress-committees.json", "utf8")) as {
  committees: CongressCommittee[];
};
const onBluesky = members.filter((m) => m.accounts.length);
if (onBluesky.length < 100) throw new Error(`Only ${onBluesky.length} members with accounts in data/; refusing to sync`);
const range = `${cycles[0]! - 1}–${cycles.at(-1)}`;

// --- what the lists should be --------------------------------------------

interface Spec {
  key: string;
  name: string;
  description: string;
  purpose: "curatelist" | "referencelist";
  dids: string[];
  pack?: { name: string; description: string };
}

const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia", PR: "Puerto Rico", GU: "Guam", VI: "U.S. Virgin Islands",
  AS: "American Samoa", MP: "Northern Mariana Islands",
};
// The House halves for starter packs: Northeast and South, Midwest and West
// (census regions; territories go with the first).
const MIDWEST_WEST = new Set(
  "IL IN IA KS MI MN MO NE ND OH SD WI AZ CO ID MT NV NM UT WY AK CA HI OR WA".split(" ")
);
// Names too long for "<name> on Bluesky" in 64 characters, or awkward.
const COMMITTEE_NAMES: Record<string, string> = {
  HSHA: "House Administration Committee",
  HSZS: "House Select Committee on China",
  SCNC: "Senate Narcotics Caucus",
  JSLC: "Joint Committee on the Library",
  JCSE: "Helsinki Commission",
};
const committeeName = (c: CongressCommittee) =>
  COMMITTEE_NAMES[c.id] ?? c.name.replace(/^(House|Senate) (Permanent |Select |Special )*Committee on (the )?/, "$1 ");

const footer = `\n\nAuto-maintained from FEC and congress-legislators data by @${HANDLE}. More: ${SITE}`;
const dids = (ms: Member[]) => [...new Set(ms.flatMap((m) => m.accounts.map((a) => a.did)))];
// Starter packs follow everyone in them, so one account per member: the official one if there is.
const mainAccount = (m: Member) =>
  (m.accounts.find((a) => /\.(house|senate)\.gov$/.test(a.handle)) ?? m.accounts[0]!).did;
const byName = (a: Member, b: Member) => a.name.localeCompare(b.name);

const specs: Spec[] = [];

specs.push({
  key: "congress",
  name: "Congress on Bluesky",
  description: `Members of the House and Senate on Bluesky, including their official and campaign accounts.${footer}`,
  purpose: "curatelist",
  dids: dids(onBluesky),
});

const packs = [
  { key: "pack-senate", name: "Congress on Bluesky: Senate", who: "Every senator", filter: (m: Member) => m.chamber === "senate" },
  {
    key: "pack-house-northeast-south",
    name: "Congress on Bluesky: House, Northeast & South",
    who: "Every House member from the Northeast and South",
    filter: (m: Member) => m.chamber === "house" && !MIDWEST_WEST.has(m.state),
  },
  {
    key: "pack-house-midwest-west",
    name: "Congress on Bluesky: House, Midwest & West",
    who: "Every House member from the Midwest and West",
    filter: (m: Member) => m.chamber === "house" && MIDWEST_WEST.has(m.state),
  },
];
for (const p of packs) {
  const accounts = [DID, ...onBluesky.filter(p.filter).sort(byName).map(mainAccount)];
  if (accounts.length > PACK_MAX) {
    console.warn(`! ${p.name}: ${accounts.length} accounts, over the ${PACK_MAX} limit; keeping the first ${PACK_MAX}. Split it.`);
  }
  const description = `${p.who} on Bluesky, and @${HANDLE}, which labels them with their top funders.${footer}`;
  specs.push({
    key: p.key,
    name: p.name,
    description,
    purpose: "referencelist",
    dids: accounts.slice(0, PACK_MAX),
    pack: { name: p.name, description },
  });
}

const byState = Map.groupBy(onBluesky, (m) => m.state);
for (const [state, ms] of [...byState].sort(([a], [b]) => a.localeCompare(b))) {
  if (ms.length < MIN_STATE) continue;
  const name = STATES[state] ?? state;
  specs.push({
    key: `state-${state.toLowerCase()}`,
    name: `${name} delegation on Bluesky`,
    description: `${name}'s members of Congress on Bluesky.${footer}`,
    purpose: "curatelist",
    dids: dids(ms),
  });
}

const byBioguide = new Map(onBluesky.map((m) => [m.bioguide, m]));
// Full committees have 4-letter ids; subcommittees add a number.
for (const c of committees.filter((c) => /^[A-Z]{4}$/.test(c.id) && !/subcommittee/i.test(c.name))) {
  const ms = c.members.map((s) => byBioguide.get(s.bioguide)).filter((m) => m !== undefined);
  if (ms.length < MIN_COMMITTEE) continue;
  specs.push({
    key: `committee-${c.id.toLowerCase()}`,
    name: `${committeeName(c)} on Bluesky`,
    description: `Members of the ${c.name.replace(/^United States /, "")} on Bluesky.${footer}`,
    purpose: "curatelist",
    dids: dids(ms),
  });
}

const sectorNames = [...new Set(onBluesky.flatMap((m) => m.combinedSectors.map((s) => s.id)))]
  .filter((s) => !SKIP_SECTORS.has(s))
  .sort();
for (const sector of sectorNames) {
  const top = onBluesky
    .map((m) => ({ m, total: m.combinedSectors.find((s) => s.id === sector)?.total ?? 0 }))
    .filter((r) => r.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, SECTOR_TOP);
  specs.push({
    key: `sector-${sector.toLowerCase().replace(/&/g, "and").replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "")}`,
    name: `Top recipients of ${sector} money`,
    description:
      `The ${top.length} members of Congress on Bluesky who got the most from ${sector}, ${range}: ` +
      `PAC contributions plus donations from people who work in it.${footer}`,
    purpose: "curatelist",
    dids: dids(top.map((r) => r.m)),
  });
}

const graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].length;
for (const s of specs) {
  if (s.name.length > 64) throw new Error(`List name over 64 characters: ${s.name}`);
  if (s.pack && graphemes(s.pack.name) > 50) throw new Error(`Starter pack name over 50 graphemes: ${s.pack.name}`);
  if (graphemes(s.description) > 300) throw new Error(`Description over 300 graphemes (${graphemes(s.description)}): ${s.description}`);
}
const keys = new Set(specs.map((s) => s.key));
for (const k of only ?? []) if (!keys.has(k)) throw new Error(`--only: no list "${k}". Keys: ${[...keys].join(", ")}`);

// --- record keys --------------------------------------------------------------

// TIDs are 13 base32-sortable characters: 53 bits of microseconds, 10 of clock id.
const S32 = "234567abcdefghijklmnopqrstuvwxyz";
const encodeTid = (n: bigint) => {
  let s = "";
  for (let i = 0; i < 13; i++, n >>= 5n) s = S32[Number(n & 31n)] + s;
  return s;
};
const decodeTid = (s: string) => [...s].reduce((n, c) => n * 32n + BigInt(S32.indexOf(c)), 0n);
const EPOCH = BigInt(Date.UTC(2023, 0, 1)) * 1000n; // µs
const SPAN = 2n ** 32n; // µs, about 71 minutes
const rkeyFor = (key: string) => {
  const h = crypto.createHash("sha256").update(`fyi.contributions.list:${key}`).digest();
  return encodeTid(((EPOCH + BigInt(h.readUInt32BE(0))) << 10n) | BigInt(h.readUInt16BE(4) & 0x3ff));
};
const isManaged = (rkey: string) => {
  if (!/^[2-7a-j][2-7a-z]{12}$/.test(rkey)) return false;
  const t = decodeTid(rkey) >> 10n;
  return t >= EPOCH && t < EPOCH + SPAN;
};
let lastTid = 0n;
const nextTid = () => {
  lastTid = BigInt(Date.now()) * 1000n > lastTid ? BigInt(Date.now()) * 1000n : lastTid + 1n;
  return encodeTid((lastTid << 10n) | BigInt(crypto.randomInt(1024)));
};
const uri = (collection: string, rkey: string) => `at://${DID}/${collection}/${rkey}`;
{
  const seen = new Map<string, string>();
  for (const s of specs) {
    const r = rkeyFor(s.key);
    if (seen.has(r)) throw new Error(`Record key collision: ${s.key} and ${seen.get(r)}`);
    seen.set(r, s.key);
  }
}

// --- records ----------------------------------------------------------------

// A blob's CID: CIDv1, raw codec, sha256, base32.
const avatarBytes = fs.readFileSync(AVATAR);
const avatarCid = (() => {
  const bytes = Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), crypto.createHash("sha256").update(avatarBytes).digest()]);
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0;
  let value = 0;
  let out = "b";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) out += alphabet[(value >>> (bits -= 5)) & 31];
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
})();
const avatarBlob = { $type: "blob", ref: { $link: avatarCid }, mimeType: "image/png", size: avatarBytes.length };

function richText(text: string) {
  const rt = new RichText({ text });
  rt.detectFacetsWithoutResolution();
  const facets = (rt.facets ?? []).map((f) => ({
    ...f,
    features: f.features.map((x) =>
      x.$type === "app.bsky.richtext.facet#mention" ? { ...x, did: x.did === HANDLE ? DID : x.did } : x
    ),
  }));
  // A mention we can't resolve here would point at a handle, not a DID.
  for (const f of facets) for (const x of f.features) if ("did" in x && !String(x.did).startsWith("did:")) throw new Error(`Unresolved mention in: ${text}`);
  return facets;
}

type Value = Record<string, unknown>;
const listRecord = (s: Spec, createdAt: string): Value => ({
  $type: LIST,
  purpose: `app.bsky.graph.defs#${s.purpose}`,
  name: s.name,
  description: s.description,
  descriptionFacets: richText(s.description),
  avatar: avatarBlob,
  createdAt,
});
const packRecord = (s: Spec, existing: Value | undefined): Value => ({
  $type: PACK,
  name: s.pack!.name,
  description: s.pack!.description,
  descriptionFacets: richText(s.pack!.description),
  list: uri(LIST, rkeyFor(s.key)),
  // Feeds can be added by hand; keep them.
  ...(existing?.feeds ? { feeds: existing.feeds } : {}),
  createdAt: (existing?.createdAt as string) ?? new Date().toISOString(),
});

// --- what the repo holds now ---------------------------------------------------

async function resolvePds(did: string) {
  const res = await fetch(`https://plc.directory/${did}`);
  if (!res.ok) throw new Error(`Couldn't resolve ${did}: ${res.status}`);
  const doc = (await res.json()) as { service?: { id: string; serviceEndpoint: string }[] };
  const pds = doc.service?.find((s) => s.id === "#atproto_pds")?.serviceEndpoint;
  if (!pds) throw new Error(`${did} has no PDS`);
  return pds;
}
const pds = await resolvePds(DID);

async function listRecords(collection: string) {
  const records = new Map<string, Value>();
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ repo: DID, collection, limit: "100", ...(cursor ? { cursor } : {}) });
    const res = await fetch(`${pds}/xrpc/com.atproto.repo.listRecords?${qs}`);
    if (!res.ok) throw new Error(`listRecords ${collection} failed: ${res.status} ${await res.text()}`);
    const page = (await res.json()) as { records: { uri: string; value: Value }[]; cursor?: string };
    for (const r of page.records) records.set(r.uri.split("/").pop()!, r.value);
    cursor = page.records.length ? page.cursor : undefined;
  } while (cursor);
  return records;
}

const [haveLists, haveItems, havePacks] = await Promise.all([listRecords(LIST), listRecords(ITEM), listRecords(PACK)]);
const itemsByList = new Map<string, { rkey: string; subject: string }[]>();
for (const [rkey, v] of haveItems) {
  const list = v.list as string;
  itemsByList.set(list, [...(itemsByList.get(list) ?? []), { rkey, subject: v.subject as string }]);
}

// Key order doesn't matter to the PDS, so compare with sorted keys.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

// --- the plan ----------------------------------------------------------------

type Write =
  | { $type: "com.atproto.repo.applyWrites#create"; collection: string; rkey: string; value: Value }
  | { $type: "com.atproto.repo.applyWrites#update"; collection: string; rkey: string; value: Value }
  | { $type: "com.atproto.repo.applyWrites#delete"; collection: string; rkey: string };
const action = (w: Write) => w.$type.split("#")[1] as keyof typeof COST;
const create = (collection: string, rkey: string, value: Value): Write => ({ $type: "com.atproto.repo.applyWrites#create", collection, rkey, value });
const update = (collection: string, rkey: string, value: Value): Write => ({ $type: "com.atproto.repo.applyWrites#update", collection, rkey, value });
const del = (collection: string, rkey: string): Write => ({ $type: "com.atproto.repo.applyWrites#delete", collection, rkey });

/** Writes that bring one record in line; nothing if it already is. */
function put(collection: string, rkey: string, value: Value, existing: Value | undefined) {
  if (!existing) return [create(collection, rkey, value)];
  return canonical(existing) === canonical(value) ? [] : [update(collection, rkey, value)];
}

interface Step {
  label: string;
  writes: Write[];
}
const plan: Step[] = [];

for (const s of specs) {
  if (only && !only.includes(s.key)) continue;
  const rkey = rkeyFor(s.key);
  const listUri = uri(LIST, rkey);
  const existing = haveLists.get(rkey);
  const writes = put(LIST, rkey, listRecord(s, (existing?.createdAt as string) ?? new Date().toISOString()), existing);

  const want = new Set(s.dids);
  const kept = new Set<string>();
  for (const item of itemsByList.get(listUri) ?? []) {
    // Not wanted any more, or a duplicate.
    if (!want.has(item.subject) || kept.has(item.subject)) writes.push(del(ITEM, item.rkey));
    else kept.add(item.subject);
  }
  for (const did of s.dids) {
    if (!kept.has(did)) writes.push(create(ITEM, nextTid(), { $type: ITEM, subject: did, list: listUri, createdAt: new Date().toISOString() }));
  }
  // After the items, so a new starter pack isn't empty.
  if (s.pack) writes.push(...put(PACK, rkey, packRecord(s, havePacks.get(rkey)), havePacks.get(rkey)));
  plan.push({ label: s.key, writes });
}

if (!only) {
  // Our lists and packs that are no longer wanted (a state or committee
  // dropped below the minimum, a sector disappeared), with their items.
  const wanted = new Set(specs.map((s) => rkeyFor(s.key)));
  const staleLists = [...haveLists.keys()].filter((r) => isManaged(r) && !wanted.has(r));
  const stalePacks = [...havePacks.keys()].filter((r) => isManaged(r) && !wanted.has(r));
  const writes = [
    ...stalePacks.map((r) => del(PACK, r)),
    ...staleLists.flatMap((r) => (itemsByList.get(uri(LIST, r)) ?? []).map((i) => del(ITEM, i.rkey))),
    ...staleLists.map((r) => del(LIST, r)),
  ];
  // A truncated data file shouldn't wipe the lists.
  if (staleLists.length > Math.max(5, specs.length * 0.2) && !args["allow-deletes"]) {
    console.warn(`! Skipping deletion of ${staleLists.length} lists no longer in data/ (more than 20%); re-run with --allow-deletes if intended`);
  } else if (writes.length) {
    plan.push({ label: `remove ${staleLists.length} lists, ${stalePacks.length} starter packs`, writes });
  }

  // Point the old hand-made list at its replacement. Its items stay.
  const old = haveLists.get(RETIRED_LIST);
  if (old) {
    const description = `No longer updated. Follow "Congress on Bluesky" instead: https://bsky.app/profile/${HANDLE}/lists/${rkeyFor("congress")}`;
    const value = { ...old, name: "US Government Officials (archived)", description, descriptionFacets: richText(description) };
    const writes = put(LIST, RETIRED_LIST, value, old);
    if (writes.length) plan.push({ label: "archive the old list", writes });
  }
}

// --- report ------------------------------------------------------------------

const all = plan.flatMap((p) => p.writes);
const cost = (writes: Write[]) => writes.reduce((n, w) => n + COST[action(w)], 0);
const count = (writes: Write[], a: keyof typeof COST) => writes.filter((w) => action(w) === a).length;
const summary = (writes: Write[]) =>
  `${count(writes, "create")} create, ${count(writes, "update")} update, ${count(writes, "delete")} delete (${cost(writes)} points)`;
const link = (s: Spec) =>
  s.pack ? `https://bsky.app/starter-pack/${HANDLE}/${rkeyFor(s.key)}` : `https://bsky.app/profile/${HANDLE}/lists/${rkeyFor(s.key)}`;

console.log(`Repo ${DID} on ${pds}: ${haveLists.size} lists, ${haveItems.size} list items, ${havePacks.size} starter packs\n`);
for (const s of specs) {
  if (only && !only.includes(s.key)) continue;
  const step = plan.find((p) => p.label === s.key)!;
  const status = step.writes.length ? summary(step.writes) : "up to date";
  console.log(`${s.pack ? "pack" : "list"}  ${s.name} (${s.dids.length})  ${status}\n      ${link(s)}`);
}
for (const p of plan.filter((p) => !keys.has(p.label))) console.log(`${p.label}: ${summary(p.writes)}`);
const total = cost(all);
console.log(
  `\n${specs.length} lists (${specs.filter((s) => s.pack).length} for starter packs). ${summary(all)}.\n` +
    `At ${Math.floor(5000 * BUDGET)} points an hour (${BUDGET * 100}% of 5,000), that's ~${Math.ceil(total / (5000 * BUDGET))} hour(s).`
);

if (!args.apply) {
  console.log("\nDry run. Re-run with --apply to publish.");
  process.exit(0);
}
if (!all.length) {
  console.log("\nNothing to change.");
  process.exit(0);
}

// --- apply -------------------------------------------------------------------

const password = process.env.LABELER_PASSWORD;
if (!password) throw new Error("LABELER_PASSWORD is required to apply");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function xrpc<T>(
  method: string,
  opts: { body?: unknown; raw?: Buffer; encoding?: string; auth?: "access" | "refresh" } = {}
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const token = opts.auth === "refresh" ? session.refreshJwt : opts.auth === "access" ? session.accessJwt : undefined;
    const res = await fetch(`${pds}/xrpc/${method}`, {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(opts.raw ? { "content-type": opts.encoding! } : opts.body ? { "content-type": "application/json" } : {}),
      },
      body: opts.raw ?? (opts.body ? JSON.stringify(opts.body) : undefined),
    });
    if (method === "com.atproto.repo.applyWrites") noteRateLimit(res.headers);
    if (res.ok) return (await res.json()) as T;

    const text = await res.text();
    const error = (() => {
      try {
        return JSON.parse(text).error as string;
      } catch {
        return undefined;
      }
    })();
    if (error === "ExpiredToken" && opts.auth === "access" && attempt === 0) {
      session = await xrpc("com.atproto.server.refreshSession", { auth: "refresh" });
      continue;
    }
    if (res.status >= 500 && attempt < 4) {
      await sleep(2000 * 2 ** attempt);
      continue;
    }
    throw Object.assign(new Error(`${method} failed: ${res.status} ${text}`), { status: res.status });
  }
}

// The headers describe whichever window is tightest: this account's hourly
// or daily write points, or the PDS's per-IP request limit.
const budget = { limit: 0, remaining: undefined as number | undefined, resetAt: 0, window: 0, policy: "" };
function noteRateLimit(headers: Headers) {
  const remaining = headers.get("ratelimit-remaining");
  if (remaining === null) return;
  budget.limit = Number(headers.get("ratelimit-limit"));
  budget.remaining = Number(remaining);
  budget.resetAt = Number(headers.get("ratelimit-reset")) * 1000;
  budget.policy = headers.get("ratelimit-policy") ?? "";
  budget.window = Number(budget.policy.match(/w=(\d+)/)?.[1] ?? 0);
}
const windowName = () => (budget.window >= 86400 ? "daily" : budget.window >= 3600 ? "hourly" : `${budget.window}s`);
const when = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/**
 * How much we may send now: one write when we don't know the budget (a
 * window may have reset since we last heard), else what's left above the
 * floor. Waits out the hourly window with --wait; null means stop.
 */
async function available(): Promise<{ writes: number; points: number } | null> {
  for (;;) {
    if (budget.remaining === undefined || Date.now() >= budget.resetAt) return { writes: 1, points: Infinity };
    // The per-IP window counts requests, not points; while it's the tightest,
    // the hourly points left are at least what it shows, so hold that to the hourly floor.
    const floor = Math.ceil((budget.window >= 3600 ? budget.limit : HOURLY_POINTS) * (1 - BUDGET));
    const spare = budget.remaining - floor;
    if (spare >= COST.create) return { writes: MAX_WRITES, points: spare };

    console.log(`  ${budget.remaining}/${budget.limit} points left in the ${windowName()} window, keeping ${floor}; it resets at ${when(budget.resetAt)}.`);
    if (!args.wait || budget.resetAt - Date.now() > 65 * 60_000) return null;
    console.log(`  Waiting until then (--wait).`);
    await sleep(budget.resetAt - Date.now() + 5000);
    budget.remaining = undefined;
  }
}

let session = await xrpc<{ accessJwt: string; refreshJwt: string }>("com.atproto.server.createSession", {
  body: { identifier: DID, password },
});

// Lists reference the avatar by CID; upload it so the PDS has it.
if (all.some((w) => w.collection === LIST && action(w) !== "delete")) {
  const { blob } = await xrpc<{ blob: { ref: { $link: string } } }>("com.atproto.repo.uploadBlob", {
    auth: "access",
    raw: avatarBytes,
    encoding: "image/png",
  });
  if (blob.ref.$link !== avatarCid) throw new Error(`Avatar CID mismatch: PDS says ${blob.ref.$link}, we computed ${avatarCid}`);
}

let applied = 0;
let stopped = false;
for (const step of plan) {
  if (!step.writes.length) continue;
  console.log(`\n${step.label}`);
  let done = 0;
  while (done < step.writes.length) {
    const allowed = await available();
    if (!allowed) {
      stopped = true;
      break;
    }
    const batch: Write[] = [];
    let points = 0;
    for (const w of step.writes.slice(done)) {
      if (batch.length >= allowed.writes || points + COST[action(w)] > allowed.points) break;
      batch.push(w);
      points += COST[action(w)];
    }
    try {
      await xrpc("com.atproto.repo.applyWrites", { auth: "access", body: { repo: DID, writes: batch } });
    } catch (err) {
      // Shouldn't happen with the floor, unless something else spent the budget.
      if ((err as { status?: number }).status === 429) {
        console.log(`  Rate limited (${budget.policy}); resets at ${when(budget.resetAt)}.`);
        budget.remaining = 0;
        budget.resetAt = Math.max(budget.resetAt, Date.now() + 60_000);
        continue;
      }
      throw err;
    }
    done += batch.length;
    applied += batch.length;
    console.log(`  ${done}/${step.writes.length}  (${budget.remaining}/${budget.limit} left in the ${windowName()} window: ${budget.policy})`);
  }
  if (stopped) break;
}

console.log(
  stopped
    ? `\nApplied ${applied} of ${all.length} writes, then stopped at the rate-limit budget. Re-run after ${when(budget.resetAt)} to continue.`
    : `\nDone: ${applied} writes.`
);
