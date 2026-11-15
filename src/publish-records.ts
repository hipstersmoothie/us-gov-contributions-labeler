// Publish data/*.json as open data in the data account's atproto repo,
// data.contributions.fyi, on our own PDS (pds.contributions.fyi).
//
//   pnpm publish-records                    dry run: show what would change
//   pnpm publish-records --apply            write it
//
// What gets written (lexicons in lexicons/fyi/contributions/):
//   com.atproto.lexicon.schema/<nsid>       the lexicons themselves, for resolution
//   fyi.contributions.dataset/self          metadata, plus the complete data files as gzipped blobs
//   fyi.contributions.account/<did>         who funds this Bluesky account, keyed by its DID
//   fyi.contributions.member/<bioguide>     and one record per congressCommittee, committee,
//   ...                                     organization and donor, linked to each other by at-uri
//   app.bsky.actor.profile/self             the account's profile
//
// Only differences are written, against what the repo holds now, so an
// interrupted run picks up where it stopped when re-run.
//
// Our PDS doesn't rate-limit. Against one that does (bsky.social: 5,000
// points an hour and 35,000 a day, at 3 per create, 2 per update and 1 per
// delete), it reads the budget from the response headers, always leaves
// --reserve points unspent, and stops when they run out (or, with --wait,
// waits out the hourly window).
//
// Needs DATA_PASSWORD to apply: `railway run --service pds -- pnpm publish-records --apply`.
// DATA_PDS_URL overrides the PDS from the DID document (e.g. Railway's domain).
// Testing: --collections=schema,dataset,member --limit=5 publishes the first
// 5 members (plus the lexicons and files) and never deletes.
import "dotenv/config";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import zlib from "zlib";
import { parseArgs } from "util";
import { jsonToLex, Lexicons } from "@atproto/lexicon";
import type { CommitteeRecord, DonorRecord, Member, OrganizationRecord } from "./ingest/build.js";
import type { CongressCommittee } from "./ingest/assignments.js";

const DID = (process.env.DATA_DID ?? "did:plc:ej5cllsvxdrzdsweyfgr2nge") as `did:${string}`;
const SITE = "https://contributions.fyi";
const NS = "fyi.contributions";
const SCHEMA = "com.atproto.lexicon.schema";
const PROFILE = "app.bsky.actor.profile";
const MAX_WRITES = 200; // per applyWrites call, PDS limit
const MAX_BYTES = 500_000; // per call; the PDS allows 1 MB
const COST = { create: 3, update: 2, delete: 1 } as const;
// Not informative as a "who funds them" answer; the labeler skips them too.
const SKIP_SECTORS = new Set(["Unknown", "Party & Candidate Committees", "Retired", "Not employed"]);

const { values: args } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    wait: { type: "boolean", default: false },
    reserve: { type: "string", default: "1000" },
    collections: { type: "string" },
    limit: { type: "string" },
    "allow-deletes": { type: "boolean", default: false },
  },
});
const RESERVE = Number(args.reserve);
const LIMIT = args.limit ? Number(args.limit) : undefined;
const only = args.collections
  ?.split(",")
  .map((c) => (c === "schema" ? SCHEMA : c === "profile" ? PROFILE : c.includes(".") ? c : `${NS}.${c}`));
const included = (nsid: string) => !only || only.includes(nsid);

// --- what the repo should hold -------------------------------------------

const read = <T>(file: string) => JSON.parse(fs.readFileSync(path.join("data", file), "utf8")) as T;
const membersFile = read<{ generatedAt: string; cycles: number[]; members: Member[] }>("members.json");
const organizationsFile = read<{ organizations: OrganizationRecord[] }>("organizations.json");
const committeesFile = read<{ committees: CommitteeRecord[] }>("committees.json");
const donorsFile = read<{ donors: DonorRecord[] }>("donors.json");
const congressFile = read<{ committees: CongressCommittee[] }>("congress-committees.json");

// Records link to each other by at-uri, where the target record exists.
// Plain at-uris rather than strongRefs: every record is regenerated from the
// same build, and pinning versions would make each change ripple through
// every record that links to it.
const keys = {
  member: new Set(membersFile.members.map((m) => m.bioguide)),
  account: new Set(membersFile.members.flatMap((m) => m.accounts.map((a) => a.did))),
  organization: new Set(organizationsFile.organizations.map((o) => o.id)),
  committee: new Set(committeesFile.committees.map((c) => c.id)),
  donor: new Set(donorsFile.donors.map((d) => d.id)),
  congressCommittee: new Set(congressFile.committees.map((c) => c.id)),
};
// The PDS rejects record keys its slur filter matches, which catches some
// names; hyphens count as word breaks to it, underscores don't. These ids get
// underscores in their record key (the id field keeps the original). If a
// publish fails with "Unacceptable slur in record key", add the id it names.
const FILTERED_IDS = new Set(["chris-coons-for-delaware-c00475392"]);
const rkey = (id: string) => (FILTERED_IDS.has(id) ? id.replaceAll("-", "_") : id);
const uri = (name: keyof typeof keys, id: string | undefined) =>
  id && keys[name].has(id) ? `at://${DID}/${NS}.${name}/${rkey(id)}` : undefined;

// Whole dollars: the atproto data model has no floats. The files keep cents.
const usd = (n: number) => Math.round(n);
const amounts = (list: { id: string; total: number }[] | undefined, to?: keyof typeof keys) =>
  list?.map((a) => ({ id: a.id, uri: to && uri(to, a.id), total: usd(a.total) }));
const byCycle = (map: Record<number, number>) =>
  Object.entries(map).map(([cycle, amount]) => ({ cycle: Number(cycle), amount: usd(amount) }));
const outsideRows = (rows: { id: string; support: number; oppose: number }[], to: keyof typeof keys) =>
  rows.map((r) => ({ id: r.id, uri: uri(to, r.id), support: usd(r.support), oppose: usd(r.oppose) }));
type Outside = { support: number; oppose: number };
// Spending on members' opponents; optional until the ingest produces it.
type Opponents = Outside & {
  spenders: (Outside & { id: string })[];
  candidates: (Outside & { id: string; name: string; party?: string; office: string; state: string; district?: number })[];
};
const outsideTotals = (o: Outside) => ({ support: usd(o.support), oppose: usd(o.oppose) });
// Drop undefined fields, as the PDS would.
const compact = <T>(value: T): T => JSON.parse(JSON.stringify(value));

const contributor = (c: Member["contributors"][number]) => ({
  ...c,
  uri: uri("organization", c.id),
  total: usd(c.total),
  pacs: usd(c.pacs),
  individuals: usd(c.individuals),
});

const toMember = (m: Member & { opponents?: Opponents }) =>
  compact({
    bioguide: m.bioguide,
    name: m.name,
    chamber: m.chamber,
    state: m.state,
    district: m.district,
    party: m.party,
    fecIds: m.fecIds,
    accounts: m.accounts.map((a) => ({ ...a, uri: uri("account", a.did) })),
    totals: Object.entries(m.totals).map(([cycle, t]) => ({
      cycle: Number(cycle),
      receipts: usd(t.receipts),
      disbursements: usd(t.disbursements),
      cashOnHand: usd(t.cashOnHand),
      individual: usd(t.individual),
      pac: usd(t.pac),
      party: usd(t.party),
      candidate: usd(t.candidate),
    })),
    sectors: amounts(m.sectors),
    organizations: amounts(m.organizations, "organization"),
    committees: amounts(m.committees, "committee"),
    outside: { ...outsideTotals(m.outside), spenders: outsideRows(m.outside.spenders, "committee") },
    opponents: m.opponents && {
      ...outsideTotals(m.opponents),
      spenders: outsideRows(m.opponents.spenders, "committee"),
      candidates: m.opponents.candidates.map((c) => ({ ...c, ...outsideTotals(c) })),
    },
    assignments: m.assignments.map((a) => ({ ...a, uri: uri("congressCommittee", a.id) })),
    individuals: m.individuals && {
      itemized: usd(m.individuals.itemized),
      donations: m.individuals.donations,
      employers: m.individuals.employers.map((e) => ({
        ...e,
        organizationUri: uri("organization", e.organization),
        total: usd(e.total),
      })),
      sectors: amounts(m.individuals.sectors),
    },
    contributors: m.contributors.map(contributor),
    combinedSectors: amounts(m.combinedSectors),
  });

const partyOrgs = new Set(
  organizationsFile.organizations.filter((o) => o.sector === "Party & Candidate Committees").map((o) => o.id)
);
const sumCycles = (m: Member, k: "receipts" | "individual" | "pac") =>
  usd(Object.values(m.totals).reduce((n, t) => n + t[k], 0));

// One per Bluesky account, so a client can ask "who funds this account?"
// with nothing but its DID.
const toAccounts = (m: Member) =>
  m.accounts.map((a) =>
    compact({
      did: a.did,
      handle: a.handle,
      member: uri("member", m.bioguide),
      bioguide: m.bioguide,
      name: m.name,
      chamber: m.chamber,
      state: m.state,
      district: m.district,
      party: m.party,
      cycles: membersFile.cycles,
      totals: {
        receipts: sumCycles(m, "receipts"),
        individual: sumCycles(m, "individual"),
        pac: sumCycles(m, "pac"),
        outsideSupport: usd(m.outside.support),
        outsideOppose: usd(m.outside.oppose),
      },
      topSectors: amounts(m.combinedSectors.filter((s) => !SKIP_SECTORS.has(s.id)).slice(0, 5)),
      topContributors: m.contributors.filter((c) => !partyOrgs.has(c.id)).slice(0, 5).map(contributor),
      url: `${SITE}/members/${m.bioguide}/`,
    })
  );

const toOrganization = (o: OrganizationRecord) =>
  compact({
    id: o.id,
    name: o.name,
    sector: o.sector,
    industry: o.industry,
    classifiedBy: o.classifiedBy,
    committees: o.committees,
    committeeUris: o.committees.map((id) => uri("committee", id)).filter(Boolean),
    sec: o.sec,
    lobbying: o.lobbying,
    total: usd(o.total),
    byCycle: byCycle(o.byCycle),
    recipients: amounts(o.recipients, "member"),
    outsideGifts: amounts(o.outsideGifts, "committee"),
    employees: o.employees && { total: usd(o.employees.total), recipients: amounts(o.employees.recipients, "member") },
    lobbyingSpend: o.lobbyingSpend && {
      total: usd(o.lobbyingSpend.total),
      byYear: Object.entries(o.lobbyingSpend.byYear).map(([year, amount]) => ({ year: Number(year), amount: usd(amount) })),
    },
  });

const toCommittee = (c: CommitteeRecord & { opponents?: Outside & { targets: (Outside & { id: string })[] } }) =>
  compact({
    id: c.id,
    name: c.name,
    connectedOrg: c.connectedOrg,
    orgType: c.orgType,
    kind: c.kind,
    state: c.state,
    organization: c.organization,
    organizationUri: uri("organization", c.organization),
    sector: c.sector,
    industry: c.industry,
    sponsors: c.sponsors?.map((s) => ({ ...s, uri: uri("member", s.bioguide) })),
    total: usd(c.total),
    byCycle: byCycle(c.byCycle),
    recipients: amounts(c.recipients, "member"),
    outside: c.outside && { ...outsideTotals(c.outside), targets: outsideRows(c.outside.targets, "member") },
    opponents: c.opponents && { ...outsideTotals(c.opponents), targets: outsideRows(c.opponents.targets, "member") },
    donors: amounts(c.donors, "donor"),
  });

const toDonor = (d: DonorRecord) =>
  compact({
    id: d.id,
    name: d.name,
    type: d.type,
    state: d.state,
    employer: d.employer,
    occupation: d.occupation,
    organization: d.organization,
    committee: d.committee,
    organizationUri: uri("organization", d.organization),
    committeeUri: uri("committee", d.committee),
    total: usd(d.total),
    gifts: d.gifts.map((g) => ({ id: g.id, uri: uri("committee", g.id), total: usd(g.total), byCycle: byCycle(g.byCycle) })),
  });

const toCongressCommittee = (c: CongressCommittee) =>
  compact({
    ...c,
    parentUri: uri("congressCommittee", c.parent),
    members: c.members.map((m) => ({ ...m, uri: uri("member", m.bioguide) })),
  });

type Value = Record<string, unknown>;
interface Collection {
  nsid: string;
  records: Map<string, Value>;
}

const collection = (name: string, entries: [string, object][]): Collection => ({
  nsid: `${NS}.${name}`,
  records: new Map(entries.map(([key, value]) => [rkey(key), { $type: `${NS}.${name}`, ...value }])),
});

// In the order they're published: the most useful first, so a run that
// stops on a rate limit has done those.
const entities = [
  collection("member", membersFile.members.map((m) => [m.bioguide, toMember(m)])),
  collection("account", membersFile.members.flatMap((m) => toAccounts(m).map((a) => [a.did, a] as [string, object]))),
  collection("congressCommittee", congressFile.committees.map((c) => [c.id, toCongressCommittee(c)])),
  collection("committee", committeesFile.committees.map((c) => [c.id, toCommittee(c)])),
  collection("organization", organizationsFile.organizations.map((o) => [o.id, toOrganization(o)])),
  collection("donor", donorsFile.donors.map((d) => [d.id, toDonor(d)])),
];
for (const c of entities) {
  if (!c.records.size) throw new Error(`No ${c.nsid} records in data/; refusing to publish an empty collection`);
}

const profile: Collection = {
  nsid: PROFILE,
  records: new Map([
    [
      "self",
      {
        $type: PROFILE,
        displayName: "contributions.fyi data",
        createdAt: "2026-11-15T16:20:00.000Z",
        description:
          "Open data: who funds Congress. Campaign contributions, outside spending and big donors for every member, " +
          `as fyi.contributions.* records in this repo. How to download: ${SITE}/open-data/ · Labels: @contributions.fyi`,
      },
    ],
  ]),
};

const lexiconDir = "lexicons/fyi/contributions";
const schemas: Collection = {
  nsid: SCHEMA,
  records: new Map(
    fs
      .readdirSync(lexiconDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const doc = JSON.parse(fs.readFileSync(path.join(lexiconDir, f), "utf8"));
        return [doc.id as string, { $type: SCHEMA, ...doc }];
      })
  ),
};

// Check every record against the lexicons before anything is written.
const lexicons = new Lexicons([...schemas.records.values()].map(({ $type: _, ...doc }) => doc as never));
const validate = (nsid: string, rkey: string, value: Value) => {
  try {
    lexicons.assertValidRecord(nsid, jsonToLex(value));
  } catch (err) {
    throw new Error(`${nsid}/${rkey} doesn't match its lexicon: ${(err as Error).message}`);
  }
};
for (const c of entities) for (const [rkey, value] of c.records) validate(c.nsid, rkey, value);

// The complete files, as served to the website: minified, gzipped.
const files = [
  { name: "members.json", entity: "member", count: membersFile.members.length, description: "Members of Congress, with sectors, contributors, outside spending, committee seats and individual donations." },
  { name: "organizations.json", entity: "organization", count: organizationsFile.organizations.length, description: "Companies, unions and groups behind PACs." },
  { name: "committees.json", entity: "committee", count: committeesFile.committees.length, description: "PACs and other FEC committees, with recipients, outside spending and big donors." },
  { name: "donors.json", entity: "donor", count: donorsFile.donors.length, description: "Donors of $50,000 or more to super PACs and other outside spenders." },
  { name: "congress-committees.json", entity: "congressCommittee", count: congressFile.committees.length, description: "Committees of Congress and their members." },
].map((f) => {
  const json = Buffer.from(JSON.stringify(read(f.name)));
  return { ...f, sha256: crypto.createHash("sha256").update(json).digest("hex"), json };
});

const METHODOLOGY =
  "Direct contributions from PACs and other political committees to current members of Congress, plus " +
  "independent expenditures for and against them and donations of $50,000 or more to the outside spenders, from FEC bulk data. " +
  "Each PAC is traced to the organization behind it (FEC connected organization, SEC EDGAR industry codes, lobbying " +
  "disclosures, then keywords in the name) and given one of a fixed set of sectors. Contributor totals are counted by " +
  "organization: an organization's PAC money plus itemized donations from people who list it as their employer. " +
  `Details: ${SITE}/about/`;

const LICENSE =
  "The FEC, SEC and Lobbying Disclosure Act records this is built from are US government works in the public domain. " +
  "contributions.fyi's own additions (sector and industry classifications, organization matching, Bluesky account " +
  "matching and the compiled totals) are dedicated to the public domain under CC0 1.0 " +
  "(https://creativecommons.org/publicdomain/zero/1.0/). Attribution to contributions.fyi is appreciated, not required.";

function datasetRecord(blobs: Map<string, unknown>, recordsComplete: boolean): Value {
  return {
    $type: `${NS}.dataset`,
    name: "contributions.fyi",
    description: "Who funds Congress: campaign contributions, outside spending and big donors for current members of Congress.",
    generatedAt: membersFile.generatedAt,
    cycles: membersFile.cycles,
    methodology: METHODOLOGY,
    files: files.map((f) => ({
      name: `${f.name}.gz`,
      description: f.description,
      blob: blobs.get(f.name),
      records: f.count,
      sha256: f.sha256,
    })),
    collections: entities.map((c) => ({ nsid: c.nsid, records: c.records.size })),
    recordsComplete,
    sources: [
      { name: "FEC bulk data", url: "https://www.fec.gov/data/browse-data/?tab=bulk-data", usedFor: "Campaign totals, PAC contributions, outside spending, individual and super PAC donations" },
      { name: "FEC API", url: "https://api.open.fec.gov/developers/", usedFor: "Leadership PAC sponsors" },
      { name: "congress-legislators", url: "https://github.com/unitedstates/congress-legislators", usedFor: "Current members, ids, committee seats" },
      { name: "SEC EDGAR", url: "https://www.sec.gov/edgar", usedFor: "Industry codes for public companies" },
      { name: "Lobbying disclosures", url: "https://lda.gov/api/", usedFor: "Lobbying issues and spending, which PACs belong to which organizations" },
      { name: "Bluesky", url: "https://bsky.app", usedFor: "Matching members to their accounts" },
    ],
    license: LICENSE,
    links: [
      { name: "Website", url: SITE },
      { name: "How to download", url: `${SITE}/open-data/` },
      { name: "Bluesky labeler", url: "https://bsky.app/profile/contributions.fyi" },
    ],
    updatedAt: new Date().toISOString(),
  };
}

// --- what it holds now -----------------------------------------------------

async function resolvePds(did: string) {
  const res = await fetch(`https://plc.directory/${did}`);
  if (!res.ok) throw new Error(`Couldn't resolve ${did}: ${res.status}`);
  const doc = (await res.json()) as { service?: { id: string; serviceEndpoint: string }[] };
  const pds = doc.service?.find((s) => s.id === "#atproto_pds")?.serviceEndpoint;
  if (!pds) throw new Error(`${did} has no PDS`);
  return pds;
}

const pds = process.env.DATA_PDS_URL ?? (await resolvePds(DID));

async function listRecords(nsid: string) {
  const records = new Map<string, Value>();
  let cursor: string | undefined;
  do {
    const qs = new URLSearchParams({ repo: DID, collection: nsid, limit: "100", ...(cursor ? { cursor } : {}) });
    const res = await fetch(`${pds}/xrpc/com.atproto.repo.listRecords?${qs}`);
    if (!res.ok) throw new Error(`listRecords ${nsid} failed: ${res.status} ${await res.text()}`);
    const page = (await res.json()) as { records: { uri: string; value: Value }[]; cursor?: string };
    for (const r of page.records) records.set(r.uri.split("/").pop()!, r.value);
    cursor = page.records.length ? page.cursor : undefined;
  } while (cursor);
  return records;
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

type Write =
  | { $type: "com.atproto.repo.applyWrites#create"; collection: string; rkey: string; value: Value }
  | { $type: "com.atproto.repo.applyWrites#update"; collection: string; rkey: string; value: Value }
  | { $type: "com.atproto.repo.applyWrites#delete"; collection: string; rkey: string };
const action = (w: Write) => w.$type.split("#")[1] as keyof typeof COST;

function diff(want: Collection, have: Map<string, Value>, { limit }: { limit?: number } = {}) {
  const writes: Write[] = [];
  const entries = [...want.records].slice(0, limit);
  for (const [rkey, value] of entries) {
    const existing = have.get(rkey);
    if (!existing) writes.push({ $type: "com.atproto.repo.applyWrites#create", collection: want.nsid, rkey, value });
    else if (canonical(existing) !== canonical(value))
      writes.push({ $type: "com.atproto.repo.applyWrites#update", collection: want.nsid, rkey, value });
  }
  const gone = [...have.keys()].filter((rkey) => !want.records.has(rkey));
  if (limit === undefined && gone.length) {
    // A truncated data file shouldn't wipe the collection.
    if (gone.length > Math.max(50, have.size * 0.1) && !args["allow-deletes"]) {
      console.warn(`  ${want.nsid}: skipping ${gone.length} deletes (more than 10%); re-run with --allow-deletes if intended`);
    } else {
      for (const rkey of gone) writes.push({ $type: "com.atproto.repo.applyWrites#delete", collection: want.nsid, rkey });
    }
  }
  return writes;
}

console.log(`Repo ${DID} on ${pds}`);

const ownSchemas = new Map([...(await listRecords(SCHEMA))].filter(([rkey]) => rkey.startsWith(`${NS}.`)));
const schemaWrites = included(SCHEMA) ? diff(schemas, ownSchemas) : [];
const profileWrites = included(PROFILE) ? diff(profile, await listRecords(PROFILE)) : [];

const plan: { nsid: string; writes: Write[] }[] = [];
for (const c of entities) {
  if (!included(c.nsid)) continue;
  const have = await listRecords(c.nsid);
  plan.push({ nsid: c.nsid, writes: diff(c, have, { limit: LIMIT }) });
}

type Dataset = { files?: { name: string; sha256: string; blob: unknown }[] };
let dataset = (await listRecords(`${NS}.dataset`)).get("self") as Dataset | undefined;
const datasetIncluded = included(`${NS}.dataset`);
const existingFile = (name: string) => dataset?.files?.find((e) => e.name === `${name}.gz`);
const staleFiles = files.filter((f) => existingFile(f.name)?.sha256 !== f.sha256);

const entityWrites = plan.flatMap((p) => p.writes);
const cost = (writes: Write[]) => writes.reduce((n, w) => n + COST[action(w)], 0);
const count = (writes: Write[], a: keyof typeof COST) => writes.filter((w) => action(w) === a).length;
const summary = (writes: Write[]) =>
  `${count(writes, "create")} create, ${count(writes, "update")} update, ${count(writes, "delete")} delete (${cost(writes).toLocaleString()} points)`;

console.log(`\n${SCHEMA}: ${summary(schemaWrites)}`);
console.log(`${PROFILE}: ${summary(profileWrites)}`);
if (datasetIncluded) console.log(`${NS}.dataset: ${staleFiles.length} of ${files.length} files changed${staleFiles.length ? ` (${staleFiles.map((f) => f.name).join(", ")})` : ""}`);
for (const p of plan) console.log(`${p.nsid}: ${summary(p.writes)}`);
const total = cost(schemaWrites) + cost(profileWrites) + cost(entityWrites) + (datasetIncluded && staleFiles.length ? 4 : 0);
const perHour = 5000 - RESERVE;
console.log(
  `\n${entityWrites.length + schemaWrites.length + profileWrites.length} writes, ${total.toLocaleString()} rate-limit points. ` +
    `Our PDS doesn't limit writes; at bsky.social's limits that would take ~${Math.ceil(total / perHour)} hour(s).`
);

if (!args.apply) {
  console.log("\nDry run. Re-run with --apply to publish.");
  process.exit(0);
}

// --- apply -------------------------------------------------------------------

const password = process.env.DATA_PASSWORD;
if (!password) throw new Error("DATA_PASSWORD is required to apply");

async function xrpc<T>(
  method: string,
  opts: { body?: unknown; raw?: Buffer; encoding?: string; auth?: "access" | "refresh" } = {}
): Promise<T & { headers: Headers }> {
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
    noteRateLimit(method, res.headers);
    if (res.ok) return { ...((await res.json()) as T), headers: res.headers };

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

// The tightest of the hourly and daily windows, as of the last write.
// A PDS that sends no rate-limit headers (ours) doesn't limit writes.
const budget = { remaining: undefined as number | undefined, resetAt: 0, window: 0, unlimited: false };
function noteRateLimit(method: string, headers: Headers) {
  if (method !== "com.atproto.repo.applyWrites") return;
  const remaining = headers.get("ratelimit-remaining");
  budget.unlimited = remaining === null;
  if (remaining === null) return;
  budget.remaining = Number(remaining);
  budget.resetAt = Number(headers.get("ratelimit-reset")) * 1000;
  budget.window = Number(headers.get("ratelimit-policy")?.match(/w=(\d+)/)?.[1] ?? 0);
}

let session = await xrpc<{ accessJwt: string; refreshJwt: string }>("com.atproto.server.createSession", {
  body: { identifier: DID, password },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// The headers report whichever limit is tightest: this account's hourly or
// daily write points, or the PDS's per-IP request limit (3,000 per 5 minutes).
// Treating that as the write budget is always on the safe side.
const windowName = () => (budget.window >= 86400 ? "daily" : budget.window >= 3600 ? "hourly" : "5-minute per-IP");
const when = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

/**
 * How much we may send now: one write when we don't know the budget (a window
 * may have reset since we last heard), else the points above the reserve.
 * Waits out the hourly window with --wait; null means stop.
 */
async function available(): Promise<{ writes: number; points: number } | null> {
  for (;;) {
    if (budget.unlimited) return { writes: MAX_WRITES, points: Infinity };
    if (budget.remaining === undefined || Date.now() >= budget.resetAt) return { writes: 1, points: Infinity };
    const spare = budget.remaining - RESERVE;
    if (spare >= COST.create) return { writes: MAX_WRITES, points: spare };

    console.log(`  ${budget.remaining} points left in the ${windowName()} window (keeping ${RESERVE} in reserve); it resets at ${when(budget.resetAt)}.`);
    if (!args.wait || budget.resetAt - Date.now() > 65 * 60_000) return null;
    console.log(`  Waiting until then (--wait).`);
    await sleep(budget.resetAt - Date.now() + 5000);
    budget.remaining = undefined;
  }
}

/** Send writes in budget-sized batches. Returns how many were applied. */
async function applyAll(writes: Write[]) {
  let done = 0;
  while (done < writes.length) {
    const allowed = await available();
    if (!allowed) break;

    const batch: Write[] = [];
    let bytes = 0;
    let points = 0;
    for (const w of writes.slice(done)) {
      const size = JSON.stringify(w).length;
      if (batch.length >= allowed.writes || (batch.length && bytes + size > MAX_BYTES) || points + COST[action(w)] > allowed.points) break;
      batch.push(w);
      bytes += size;
      points += COST[action(w)];
    }
    if (!batch.length) break;

    try {
      await xrpc("com.atproto.repo.applyWrites", { auth: "access", body: { repo: DID, writes: batch } });
    } catch (err) {
      // Shouldn't happen with the reserve, unless something else spent the budget.
      if (String(err).includes("slur in record key") && batch.length > 1) {
        for (const w of batch) {
          await xrpc("com.atproto.repo.applyWrites", { auth: "access", body: { repo: DID, writes: [w] } }).catch((e) => {
            if (String(e).includes("slur in record key")) console.error(`  The PDS rejected the record key ${w.collection}/${w.rkey}: add it to FILTERED_IDS.`);
          });
        }
      }
      if ((err as { status?: number }).status === 429) {
        console.log(`  Rate limited; ${budget.remaining ?? "?"} points left, resets at ${when(budget.resetAt)}.`);
        budget.remaining = 0;
        budget.resetAt = Math.max(budget.resetAt, Date.now() + 60_000);
        continue;
      }
      throw err;
    }
    done += batch.length;
    console.log(`  ${done}/${writes.length}${budget.unlimited ? "" : ` (${budget.remaining} left in the ${windowName()} window)`}`);
  }
  return done;
}

let stopped = false;

if (schemaWrites.length) {
  console.log(`\nLexicon schemas`);
  stopped = (await applyAll(schemaWrites)) < schemaWrites.length;
}

if (profileWrites.length && !stopped) {
  console.log(`\nProfile`);
  stopped = (await applyAll(profileWrites)) < profileWrites.length;
}

// The dataset record: upload changed files, then point the record at them.
// recordsComplete stays false until the per-entity collections match.
const complete = (pending: boolean) => !pending && !only && LIMIT === undefined;
async function putDataset(recordsComplete: boolean) {
  const blobs = new Map<string, unknown>();
  for (const f of files) {
    const existing = existingFile(f.name);
    if (existing && existing.sha256 === f.sha256) {
      blobs.set(f.name, existing.blob);
      continue;
    }
    const gz = zlib.gzipSync(f.json, { level: 9 });
    const { blob } = await xrpc<{ blob: unknown }>("com.atproto.repo.uploadBlob", {
      auth: "access",
      raw: gz,
      encoding: "application/gzip",
    });
    console.log(`  uploaded ${f.name}.gz (${(gz.length / 1e6).toFixed(1)} MB)`);
    blobs.set(f.name, blob);
  }
  const value = datasetRecord(blobs, recordsComplete);
  validate(`${NS}.dataset`, "self", value);
  const strip = (v: unknown) => canonical({ ...(v as object), updatedAt: undefined });
  if (dataset && strip(dataset) === strip(value)) return true;
  const op = dataset ? "update" : "create";
  const applied = await applyAll([{ $type: `com.atproto.repo.applyWrites#${op}`, collection: `${NS}.dataset`, rkey: "self", value }]);
  if (applied) dataset = value as Dataset;
  return applied === 1;
}

if (datasetIncluded && !stopped) {
  console.log(`\n${NS}.dataset`);
  stopped = !(await putDataset(complete(entityWrites.length > 0)));
}

for (const p of plan) {
  if (stopped || !p.writes.length) continue;
  console.log(`\n${p.nsid}`);
  stopped = (await applyAll(p.writes)) < p.writes.length;
}

if (!stopped && datasetIncluded && entityWrites.length && complete(false)) {
  console.log(`\n${NS}.dataset: records complete`);
  stopped = !(await putDataset(true));
}

console.log(
  stopped
    ? `\nStopped at the rate limit. Re-run after ${when(budget.resetAt)} to continue where this left off.`
    : `\nDone.`
);
