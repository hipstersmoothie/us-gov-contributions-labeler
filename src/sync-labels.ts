// Bring the live labels in line with data/members.json.
//
//   pnpm sync-labels           dry run: show what would change
//   pnpm sync-labels --apply   publish it
//   pnpm sync-labels --apply --max-accounts=40
//                              publish only if at most 40 accounts change and
//                              none loses all its labels (exits 3 otherwise);
//                              for unattended runs
//
// Each member's Bluesky accounts get their top 3 sectors and top 3
// contributors, counted by organization: an organization's PAC plus
// donations from its employees. Labels that no longer apply (changed rankings, former
// members, mismatched accounts) are negated. Only differences are sent, so
// re-running is a no-op.
//
// Works from any machine: reads current labels from the labeler's public
// endpoint and writes through its authenticated emitEvent endpoint.
// Needs LABELER_DID and LABELER_PASSWORD in .env to apply.
import "dotenv/config";
import fs from "fs";
import { parseArgs } from "util";
import { AtpAgent } from "@atproto/api";
import {
  getLabelerLabelDefinitions,
  setLabelerLabelDefinitions,
} from "@skyware/labeler/scripts";
import { fetchLiveLabels, labelerServiceUrl, memberLabels, PER_KIND } from "./lib/labels.js";
import type { Member, OrganizationRecord } from "./ingest/build.js";

const LABELER_DID = (process.env.LABELER_DID ?? process.env.DID ?? "did:plc:ylmdlijvrvgbe4md6v4dyce6") as `did:${string}`;
const METHODOLOGY =
  "The organizations themselves did not donate; the money came from their PACs and from their employees, " +
  "members or owners. Individual donations are counted by the employer donors listed.";
const SITE_URL = process.env.SITE_URL;

const { values: args } = parseArgs({
  options: { apply: { type: "boolean", default: false }, "max-accounts": { type: "string" } },
});

const { members, cycles } = JSON.parse(fs.readFileSync("data/members.json", "utf8")) as {
  members: Member[];
  cycles: number[];
};
const { organizations } = JSON.parse(fs.readFileSync("data/organizations.json", "utf8")) as {
  organizations: OrganizationRecord[];
};
const orgById = new Map(organizations.map((o) => [o.id, o]));
const range = `${cycles[0]! - 1}–${cycles.at(-1)}`;
const more = SITE_URL ? `\n\nDetails: ${SITE_URL}` : "";

// --- what the labels should be ------------------------------------------

interface Definition {
  value: string;
  name: string;
  description: string;
}
const definitions = new Map<string, Definition>();
const desired = new Map<string, Set<string>>();

for (const m of members) {
  if (!m.accounts.length) continue;
  const labels: Definition[] = memberLabels(m, orgById).map((l) => ({
    value: l.value,
    name: l.name,
    description:
      l.kind === "sector"
        ? `${l.fullName}: one of the top ${PER_KIND} sectors funding this member of Congress's campaign, ${range}, per FEC filings.` +
          `\n\n${METHODOLOGY}${more}`
        : `${l.fullName} is one of the top ${PER_KIND} contributors to this member of Congress's campaign, ${range}, per FEC filings.` +
          `\n\n${METHODOLOGY}${more}`,
  }));

  for (const l of labels) {
    definitions.set(l.value, l);
    for (const account of m.accounts) {
      const vals = desired.get(account.did) ?? new Set<string>();
      vals.add(l.value);
      desired.set(account.did, vals);
    }
  }
}

// --- what they are now --------------------------------------------------

const serviceUrl = await labelerServiceUrl(LABELER_DID);
const live = await fetchLiveLabels(serviceUrl, LABELER_DID);
console.log(`Labeler ${serviceUrl}: ${live.events.toLocaleString()} label events`);

const changes: { did: string; create: string[]; negate: string[] }[] = [];
for (const did of new Set([...desired.keys(), ...live.active.keys()])) {
  const want = desired.get(did) ?? new Set<string>();
  const have = live.active.get(did) ?? new Set<string>();
  const create = [...want].filter((v) => !have.has(v));
  const negate = [...have].filter((v) => !want.has(v));
  if (create.length || negate.length) changes.push({ did, create, negate });
}

const handleByDid = new Map(members.flatMap((m) => m.accounts.map((a) => [a.did, `${a.handle} (${m.name})`])));
const sum = (k: "create" | "negate") => changes.reduce((n, c) => n + c[k].length, 0);
console.log(
  `${desired.size} accounts should be labeled, ${[...live.active.values()].filter((v) => v.size).length} currently are.\n` +
    `${changes.length} accounts change: ${sum("create")} labels to add, ${sum("negate")} to remove.\n` +
    `${definitions.size} label definitions.`
);

fs.mkdirSync(".cache", { recursive: true });
fs.writeFileSync(
  ".cache/label-plan.json",
  JSON.stringify(changes.map((c) => ({ ...c, account: handleByDid.get(c.did) ?? "no longer matched" })), null, 2)
);
console.log("Full plan in .cache/label-plan.json");
for (const c of changes.slice(0, 5)) {
  console.log(`  ${handleByDid.get(c.did) ?? c.did}: +${c.create.join(", +")} ${c.negate.map((v) => `-${v}`).join(" ")}`);
}
// Accounts that have labels now and would have none after this.
const losingAll = changes.filter((c) => c.negate.length && !desired.get(c.did)?.size);
if (losingAll.length) {
  console.log(`${losingAll.length} accounts would lose all their labels:`);
  for (const c of losingAll) console.log(`  ${handleByDid.get(c.did) ?? c.did}`);
}

if (!args.apply) {
  console.log("\nDry run. Re-run with --apply to publish.");
  process.exit(0);
}

if (args["max-accounts"] !== undefined) {
  const max = Number(args["max-accounts"]);
  const held = [
    changes.length > max && `${changes.length} accounts change (limit ${max})`,
    losingAll.length && `${losingAll.length} accounts would lose all their labels`,
  ].filter(Boolean);
  if (held.length) {
    console.log(`\nNot applying: ${held.join("; ")}. Review .cache/label-plan.json and apply by hand.`);
    process.exit(3);
  }
}

// --- apply --------------------------------------------------------------

const password = process.env.LABELER_PASSWORD;
if (!password) throw new Error("LABELER_PASSWORD is required to apply");
const credentials = { identifier: LABELER_DID, password };

const toDefinition = (d: Definition) => ({
  identifier: d.value,
  severity: "inform" as const,
  blurs: "none" as const,
  defaultSetting: "warn" as const,
  adultOnly: false,
  // Bluesky caps label names at 64 graphemes.
  locales: [{ lang: "en", name: d.name.length > 64 ? `${d.name.slice(0, 63).trimEnd()}…` : d.name, description: d.description }],
});

// Keep definitions for labels we're about to negate until they're gone, so
// clients never see a label without a definition.
const existing = (await getLabelerLabelDefinitions(credentials)) ?? [];
const interim = new Map(existing.map((d) => [d.identifier, d]));
for (const d of definitions.values()) interim.set(d.value, toDefinition(d));
await setLabelerLabelDefinitions(credentials, [...interim.values()]);
console.log(`Declared ${interim.size} label definitions`);

const agent = new AtpAgent({ service: "https://bsky.social" });
await agent.login(credentials);

let done = 0;
for (const c of changes) {
  // Service-auth tokens are short-lived; get one per request.
  const { data } = await agent.com.atproto.server.getServiceAuth({
    aud: LABELER_DID,
    lxm: "tools.ozone.moderation.emitEvent",
  });
  const res = await fetch(`${serviceUrl}/xrpc/tools.ozone.moderation.emitEvent`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${data.token}` },
    body: JSON.stringify({
      event: {
        $type: "tools.ozone.moderation.defs#modEventLabel",
        createLabelVals: c.create,
        negateLabelVals: c.negate,
      },
      subject: { $type: "com.atproto.admin.defs#repoRef", did: c.did },
      createdBy: LABELER_DID,
    }),
  });
  if (!res.ok) throw new Error(`emitEvent for ${c.did} failed: ${res.status} ${await res.text()}`);
  if (++done % 25 === 0) console.log(`  ${done}/${changes.length}`);
}

await setLabelerLabelDefinitions(credentials, [...definitions.values()].map(toDefinition));
console.log(`Applied ${changes.length} changes; ${definitions.size} label definitions remain.`);
