// Refresh everything in data/. Meant to be run by hand every so often.
//
//   pnpm ingest                      all steps, last 3 cycles
//   pnpm ingest --steps=accounts     just re-match Bluesky accounts
//   pnpm ingest --cycles=5           go further back
//   pnpm ingest --min-total=5000     look up fewer (only bigger) PACs
//   pnpm ingest --steps=legislation  just bills, votes and lobbying reports
//   pnpm ingest --steps=revolving    just lobbyists' former government jobs
//   pnpm ingest --steps=fara         just foreign lobbying
//
// Needs FEC_API_KEY and SEC_USER_AGENT in .env. Every step caches to .cache/,
// so an interrupted run picks up where it stopped.
import "dotenv/config";
import fs from "fs";
import { parseArgs } from "util";
import { getCurrentLegislators } from "./lib/legislators.js";
import { recentCycles } from "./lib/cycles.js";
import { discoverAccounts } from "./ingest/accounts.js";
import { ingestFec, type FecData } from "./ingest/fec.js";
import { enrichCommittees } from "./ingest/committees.js";
import { collectDonors, outsideSpenders } from "./ingest/donors.js";
import { fetchAssignments, fetchPhotos } from "./ingest/assignments.js";
import { ingestIndividuals } from "./ingest/individuals.js";
import { fetchLobbyingSpend } from "./ingest/lobbying.js";
import { buildData, type Account, type OrganizationRecord } from "./ingest/build.js";
import type { CongressCommittee } from "./ingest/assignments.js";
import { ingestLegislation, ldaQuarters, congressFor } from "./ingest/legislation.js";
import { ingestBundling } from "./ingest/bundling.js";
import { ingestRevolving } from "./ingest/revolving.js";
import { ingestFara } from "./ingest/fara.js";

const STEPS = [
  "accounts", "assignments", "fec", "bundling", "committees", "lobbying", "individuals", "donors", "legislation", "revolving", "fara",
] as const;
const FEC_FILE = ".cache/fec/data.json";
const ENRICHED_FILE = ".cache/enrich/result.json";
const DONORS_FILE = ".cache/donors/result.json";
const ASSIGNMENTS_FILE = ".cache/assignments.json";
const INDIVIDUALS_FILE = ".cache/individuals.json";
const LOBBYING_FILE = ".cache/enrich/lobbying-result.json";
const BUNDLING_FILE = ".cache/bundling.json";

const { values: args } = parseArgs({
  options: {
    steps: { type: "string", default: STEPS.join(",") },
    cycles: { type: "string", default: "3" },
    "min-total": { type: "string", default: "1000" },
    "lobbying-minutes": { type: "string", default: "20" },
    // A full Congress of lobbying reports is about an hour the first time.
    "legislation-minutes": { type: "string", default: "90" },
  },
});

const steps = new Set(args.steps.split(","));
const cycles = recentCycles(Number(args.cycles));

function readJson<T>(file: string): T | undefined {
  return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as T) : undefined;
}
function writeJson(file: string, data: unknown, pretty = true) {
  fs.mkdirSync(file.split("/").slice(0, -1).join("/"), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, pretty ? 2 : undefined) + "\n");
}
function required<T>(value: T | undefined, step: string): T {
  if (value === undefined) throw new Error(`No cached ${step} data; run with --steps=${step}`);
  return value;
}

const legislators = await getCurrentLegislators();
console.log(`Cycles ${cycles.join(", ")}; ${legislators.length} current members`);

// Bills and votes, lobbyists' former jobs and foreign lobbying only need what's
// already in data/, so they can be refreshed on their own without rebuilding
// everything else.
const STANDALONE = new Set(["legislation", "revolving", "fara"]);
if ([...steps].every((s) => STANDALONE.has(s))) {
  const { organizations } = required(readJson<{ organizations: OrganizationRecord[] }>("data/organizations.json"), "committees");
  await writeStandalone(organizations);
  process.exit(0);
}
async function writeStandalone(organizations: OrganizationRecord[]) {
  if (steps.has("legislation")) await writeLegislation(organizations);
  if (!steps.has("revolving") && !steps.has("fara")) return;
  // Both read the LD-1 and LD-2 filings the legislation step caches.
  const { filings } = await ldaQuarters(congressFor().years, Number(args["legislation-minutes"]));
  if (steps.has("revolving")) {
    const committees = required(readJson<{ committees: CongressCommittee[] }>("data/congress-committees.json"), "assignments");
    writeJson("data/revolving-door.json", await ingestRevolving(legislators, committees.committees, organizations, filings), false);
  }
  if (steps.has("fara")) {
    writeJson("data/fara.json", await ingestFara(legislators, cycles, organizations, filings), false);
  }
}
async function writeLegislation(organizations: OrganizationRecord[]) {
  const legislation = await ingestLegislation(legislators, organizations, {
    lobbyingMinutes: Number(args["legislation-minutes"]),
  });
  writeJson("data/legislation.json", legislation, false);
}

const accounts = steps.has("accounts")
  ? await discoverAccounts(legislators)
  : required(readJson<{ bioguide: string; accounts: Account[] }[]>("data/accounts.json"), "accounts");

let assignments = readJson<Awaited<ReturnType<typeof fetchAssignments>>>(ASSIGNMENTS_FILE);
if (steps.has("assignments")) {
  assignments = await fetchAssignments();
  writeJson(ASSIGNMENTS_FILE, assignments, false);
  await fetchPhotos(legislators);
}

let fec = readJson<FecData>(FEC_FILE);
if (steps.has("fec")) {
  fec = await ingestFec(legislators, cycles);
  writeJson(FEC_FILE, fec, false);
}

let bundling = readJson<Awaited<ReturnType<typeof ingestBundling>>>(BUNDLING_FILE);
if (steps.has("bundling")) {
  bundling = await ingestBundling(legislators, cycles);
  writeJson(BUNDLING_FILE, bundling, false);
}

let enriched = readJson<Awaited<ReturnType<typeof enrichCommittees>>>(ENRICHED_FILE);
if (steps.has("committees")) {
  enriched = await enrichCommittees(required(fec, "fec"), legislators, {
    minTotal: Number(args["min-total"]),
  });
  writeJson(ENRICHED_FILE, enriched, false);
}

let lobbying = readJson<Awaited<ReturnType<typeof fetchLobbyingSpend>>>(LOBBYING_FILE);
if (steps.has("lobbying")) {
  const fecData = required(fec, "fec");
  const givingById = new Map<string, number>();
  for (const [committeeId, byMember] of Object.entries(fecData.contributions)) {
    const org = required(enriched, "committees").committees[committeeId]?.organization;
    if (!org) continue;
    const total = Object.values(byMember).flatMap((c) => Object.values(c)).reduce((a, b) => a + b, 0);
    givingById.set(org, (givingById.get(org) ?? 0) + total);
  }
  lobbying = await fetchLobbyingSpend(required(enriched, "committees").organizations, cycles, {
    budgetMinutes: Number(args["lobbying-minutes"]),
    givingById,
  });
  writeJson(LOBBYING_FILE, lobbying, false);
}

let individuals = readJson<Awaited<ReturnType<typeof ingestIndividuals>>>(INDIVIDUALS_FILE);
if (steps.has("individuals")) {
  individuals = await ingestIndividuals(
    legislators,
    cycles,
    required(enriched, "committees").organizations,
    outsideSpenders(required(fec, "fec"))
  );
  writeJson(INDIVIDUALS_FILE, individuals, false);
}

let donors = readJson<Awaited<ReturnType<typeof collectDonors>>>(DONORS_FILE);
if (steps.has("donors")) {
  donors = await collectDonors(
    required(fec, "fec"),
    required(enriched, "committees"),
    cycles,
    required(individuals, "individuals").largeReceipts
  );
  writeJson(DONORS_FILE, donors, false);
}

const data = buildData(
  legislators,
  cycles,
  accounts,
  required(fec, "fec"),
  required(enriched, "committees"),
  donors,
  assignments,
  individuals,
  lobbying,
  bundling
);
writeJson("data/members.json", data.members);
writeJson("data/committees.json", data.committees);
writeJson("data/organizations.json", data.organizations);
writeJson("data/donors.json", data.donors);
writeJson("data/congress-committees.json", data.congressCommittees);
await writeStandalone(data.organizations.organizations);
console.log(
  `Wrote ${data.members.members.length} members, ` +
    `${data.organizations.organizations.length} organizations, ` +
    `${data.committees.committees.length} committees, ` +
    `${data.donors.donors.length} large donors`
);
