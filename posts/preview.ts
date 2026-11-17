// What each series would post, from the local data/ directory. Nothing is
// posted or recorded.
//
//   pnpm posts:preview                   every series
//   pnpm posts:preview member-elect      one series
//   pnpm posts:preview --since=HEAD~5    new-on-bluesky: members on Bluesky now who weren't at that commit
//   pnpm posts:preview --pages           also fetch each linked page's card, as the post would show it
import { execFileSync } from "child_process";
import { parseArgs } from "util";
import { readLocal, type Member } from "./data.js";
import { fetchPage } from "./bsky.js";
import { graphemes } from "./format.js";
import { memberElect } from "./series/member-elect.js";
import { newOnBluesky } from "./series/new-on-bluesky.js";
import type { Draft } from "./series/types.js";

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: { since: { type: "string" }, pages: { type: "boolean" } },
});
const only = positionals[0];
const SITE_URL = (process.env.SITE_URL ?? "https://contributions.fyi").replace(/\/$/, "");

const data = readLocal();
const drafts: Draft[] = [];
const { drafts: elect, skipped } = memberElect(data);
drafts.push(...elect);

if (args.since) {
  const before = JSON.parse(execFileSync("git", ["show", `${args.since}:data/members.json`], { maxBuffer: 1 << 30, encoding: "utf8" })) as {
    members: Member[];
  };
  const seen = new Set(before.members.filter((m) => m.accounts.length > 0).map((m) => m.bioguide));
  drafts.push(...(await newOnBluesky(data, seen)));
} else if (!only || only === "new-on-bluesky") {
  skipped.push("new-on-bluesky: pass --since=<git ref> to compare members.json against");
}

for (const d of drafts.filter((d) => !only || d.series === only).sort((a, b) => a.priority - b.priority)) {
  console.log(`── ${d.key} (${graphemes(d.text)} graphemes) → ${SITE_URL}${d.link}`);
  console.log(d.text);
  if (args.pages) {
    try {
      const page = await fetchPage(`${SITE_URL}${d.link}`, d.expect);
      console.log(`  [card] ${d.title ?? page.title}\n         ${d.description ?? page.description}\n         ${page.image ?? "(no image)"}`);
    } catch (err) {
      console.log(`  [card] not ready: ${err instanceof Error ? err.message : err}`);
    }
  }
  console.log();
}
for (const s of skipped) console.log(`Not yet: ${s}`);
