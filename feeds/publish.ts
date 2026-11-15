// Publish the app.bsky.feed.generator records for feeds.ts in the labeler
// account's repo.
//
//   pnpm feeds:publish           dry run: show the records
//   pnpm feeds:publish --apply   write them (needs LABELER_PASSWORD)
//
// Refuses to write unless https://<FEEDGEN_HOSTNAME>/.well-known/did.json
// serves the service DID: Bluesky resolves it to find the feed generator.
import "dotenv/config";
import fs from "fs";
import { parseArgs } from "util";
import { AtpAgent, RichText } from "@atproto/api";
import { FEEDS, PUBLISHER_DID } from "./feeds.js";

const HOSTNAME = process.env.FEEDGEN_HOSTNAME ?? "feeds.contributions.fyi";
const SERVICE_DID = `did:web:${HOSTNAME}`;
const AVATAR = new URL("../design/logo/avatar.png", import.meta.url);

const { values: args } = parseArgs({
  options: { apply: { type: "boolean", default: false }, prune: { type: "boolean", default: false } },
});

const records = FEEDS.map((f) => {
  const rt = new RichText({ text: f.description });
  rt.detectFacetsWithoutResolution();
  if ([...new Intl.Segmenter().segment(f.displayName)].length > 24) throw new Error(`${f.rkey}: displayName too long`);
  if (rt.graphemeLength > 300) throw new Error(`${f.rkey}: description is ${rt.graphemeLength} graphemes`);
  return { rkey: f.rkey, displayName: f.displayName, description: rt.text, descriptionFacets: rt.facets };
});

for (const r of records) {
  console.log(`at://${PUBLISHER_DID}/app.bsky.feed.generator/${r.rkey}\n  ${r.displayName}\n  ${r.description}\n`);
}
console.log(`Service: ${SERVICE_DID}`);

const didDoc = await fetch(`https://${HOSTNAME}/.well-known/did.json`)
  .then((r) => (r.ok ? (r.json() as Promise<{ id?: string }>) : undefined))
  .catch(() => undefined);
if (didDoc?.id !== SERVICE_DID) {
  console.error(`https://${HOSTNAME}/.well-known/did.json doesn't serve ${SERVICE_DID} yet; not publishing.`);
  process.exit(1);
}

if (!args.apply) {
  console.log("\nDry run. Re-run with --apply to publish.");
  process.exit(0);
}

const password = process.env.LABELER_PASSWORD;
if (!password) throw new Error("LABELER_PASSWORD is required to apply");
const agent = new AtpAgent({ service: "https://bsky.social" });
await agent.login({ identifier: PUBLISHER_DID, password });

const { data: upload } = await agent.uploadBlob(fs.readFileSync(AVATAR), { encoding: "image/png" });

const existing = new Map<string, { createdAt?: string }>();
let cursor: string | undefined;
do {
  const { data } = await agent.com.atproto.repo.listRecords({
    repo: PUBLISHER_DID,
    collection: "app.bsky.feed.generator",
    limit: 100,
    cursor,
  });
  for (const r of data.records) existing.set(r.uri.split("/").pop()!, r.value as { createdAt?: string });
  cursor = data.cursor;
} while (cursor);

for (const r of records) {
  await agent.com.atproto.repo.putRecord({
    repo: PUBLISHER_DID,
    collection: "app.bsky.feed.generator",
    rkey: r.rkey,
    record: {
      $type: "app.bsky.feed.generator",
      did: SERVICE_DID,
      displayName: r.displayName,
      description: r.description,
      descriptionFacets: r.descriptionFacets,
      avatar: upload.blob,
      createdAt: existing.get(r.rkey)?.createdAt ?? new Date().toISOString(),
    },
  });
  console.log(`${existing.has(r.rkey) ? "Updated" : "Created"} https://bsky.app/profile/contributions.fyi/feed/${r.rkey}`);
}

// Feeds that were removed from feeds.ts.
const stale = [...existing.keys()].filter((k) => !records.some((r) => r.rkey === k));
if (stale.length && !args.prune) console.log(`Not in feeds.ts: ${stale.join(", ")} (--prune to delete)`);
for (const rkey of args.prune ? stale : []) {
  await agent.com.atproto.repo.deleteRecord({ repo: PUBLISHER_DID, collection: "app.bsky.feed.generator", rkey });
  console.log(`Deleted ${rkey}`);
}
