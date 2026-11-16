// After the accounts step, unattended: keep new accepted matches, but never
// drop an account. Any account in the committed data/accounts.json that the
// matcher no longer returns is put back and listed, for a person to decide.
//
//   npx tsx src/scripts/refresh/accounts-guard.ts      compares against git HEAD
import fs from "fs";
import { execFileSync } from "child_process";

type Entry = { bioguide: string; name: string; accounts: { did: string; handle: string }[] };

const before = JSON.parse(execFileSync("git", ["show", "HEAD:data/accounts.json"], { encoding: "utf8", maxBuffer: 1 << 26 })) as Entry[];
const after = JSON.parse(fs.readFileSync("data/accounts.json", "utf8")) as Entry[];

const byMember = new Map(after.map((e) => [e.bioguide, e]));
const had = new Set(before.flatMap((e) => e.accounts.map((a) => a.did)));
const has = new Set(after.flatMap((e) => e.accounts.map((a) => a.did)));

const added = after.flatMap((e) => e.accounts.filter((a) => !had.has(a.did)).map((a) => `${a.handle} (${e.name})`));
const kept: string[] = [];
for (const e of before) {
  const dropped = e.accounts.filter((a) => !has.has(a.did));
  if (!dropped.length) continue;
  kept.push(...dropped.map((a) => `${a.handle} (${e.name})`));
  const now = byMember.get(e.bioguide);
  if (now) now.accounts.push(...dropped);
  else after.push({ ...e, accounts: dropped });
}

if (kept.length) fs.writeFileSync("data/accounts.json", JSON.stringify(after, null, 2) + "\n");
console.log(`${added.length} new accounts${added.length ? `: ${added.join(", ")}` : ""}`);
console.log(`${kept.length} accounts the matcher dropped, kept for review${kept.length ? `: ${kept.join(", ")}` : ""}`);
