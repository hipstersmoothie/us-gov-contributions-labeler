// Sanity checks on a refreshed data/, against what's committed (git HEAD),
// before an unattended run pushes it. Prints the headline numbers either way;
// exits 1 with the reasons if anything looks wrong.
//
//   npx tsx src/scripts/refresh/check-data.ts
import fs from "fs";
import { execFileSync } from "child_process";
import type { Member } from "../../ingest/build.js";

const MAX_MEMBER_CHANGE = 3;
const MAX_DROP = 0.05;
const MAX_SHRINK = 0.25;

const committed = (file: string) => {
  try {
    return execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8", maxBuffer: 1 << 30 });
  } catch {
    return undefined;
  }
};

const problems: string[] = [];

// Files that shrank a lot, or stopped parsing.
const files = execFileSync("git", ["ls-files", "data/*.json"], { encoding: "utf8" }).split("\n").filter(Boolean);
for (const file of files) {
  const old = committed(file);
  if (!old || !fs.existsSync(file)) {
    if (old) problems.push(`${file} is missing`);
    continue;
  }
  const now = fs.readFileSync(file, "utf8");
  try {
    JSON.parse(now);
  } catch {
    problems.push(`${file} isn't valid JSON`);
    continue;
  }
  if (old.length > 10_000 && now.length < old.length * (1 - MAX_SHRINK)) {
    problems.push(`${file} shrank from ${old.length.toLocaleString()} to ${now.length.toLocaleString()} bytes`);
  }
}

// Organization ids that went away while files this run doesn't rebuild
// (legislation, revolving door, 527s...) still point at them.
const orgIds = (text: string) => new Set((JSON.parse(text) as { organizations: { id: string }[] }).organizations.map((o) => o.id));
const oldOrgs = orgIds(committed("data/organizations.json") ?? '{"organizations":[]}');
const newOrgs = orgIds(fs.readFileSync("data/organizations.json", "utf8"));
const gone = [...oldOrgs].filter((id) => !newOrgs.has(id));
console.log(`organizations: ${oldOrgs.size} → ${newOrgs.size}, ${gone.length} ids gone`);
// races-<year>.json and former-members.json are rewritten in the same run, and their
// pages only link an organization that still has one.
const raceFiles = fs.readdirSync("data").filter((f) => /^races-\d{4}\.json$/.test(f)).map((f) => `data/${f}`);
const rebuiltTogether = new Set(["data/organizations.json", "data/members.json", "data/committees.json", "data/donors.json", "data/former-members.json", ...raceFiles]);
for (const file of files.filter((f) => !rebuiltTogether.has(f) && fs.existsSync(f))) {
  const text = fs.readFileSync(file, "utf8");
  const dangling = gone.filter((id) => text.includes(`"${id}"`));
  if (dangling.length) problems.push(`${file} still refers to ${dangling.length} organizations that are gone (${dangling.slice(0, 5).join(", ")})`);
}

// Members and money, for the cycles both versions cover.
type MembersFile = { cycles: number[]; members: Member[] };
const before = JSON.parse(committed("data/members.json") ?? "{}") as MembersFile;
const after = JSON.parse(fs.readFileSync("data/members.json", "utf8")) as MembersFile;
const memberChange = after.members.length - before.members.length;
console.log(`members: ${before.members.length} → ${after.members.length}`);
// A new Congress replaces dozens of members at once. That's expected when
// everyone who left is now in former-members.json and everyone who arrived
// was a candidate in the election (data/races-<year>.json), in the month
// after the new Congress is sworn in.
const beforeIds = new Set(before.members.map((m) => m.bioguide));
const afterIds = new Set(after.members.map((m) => m.bioguide));
const left = [...beforeIds].filter((id) => !afterIds.has(id));
const arrived = [...afterIds].filter((id) => !beforeIds.has(id));
const former = new Set(fs.existsSync("data/former-members.json") ? (JSON.parse(fs.readFileSync("data/former-members.json", "utf8")).members as { bioguide: string }[]).map((m) => m.bioguide) : []);
// Everyone who ran in an election, and when its winners take office.
const elections = raceFiles.map((f) => JSON.parse(fs.readFileSync(f, "utf8")) as { newCongress: string; races: { candidates: { bioguide?: string }[] }[] });
const ranInAnElection = new Set(elections.flatMap((e) => e.races.flatMap((r) => r.candidates.flatMap((c) => (c.bioguide ? [c.bioguide] : [])))));
const today = new Date().toISOString().slice(0, 10);
// Within a month after a new Congress is sworn in.
const newCongressNow = elections.some((e) => today >= e.newCongress && today <= `${e.newCongress.slice(0, 5)}02-${e.newCongress.slice(8)}`);
const turnover = left.every((id) => former.has(id)) && arrived.every((id) => ranInAnElection.has(id));
if (left.length || arrived.length) console.log(`  left: ${left.length} (all in former-members.json: ${left.every((id) => former.has(id))}); arrived: ${arrived.length} (all candidates in an election: ${arrived.every((id) => ranInAnElection.has(id))})`);
if (Math.abs(memberChange) > MAX_MEMBER_CHANGE || left.length + arrived.length > 2 * MAX_MEMBER_CHANGE) {
  if (turnover && newCongressNow) console.log("  a new Congress: turnover accounted for");
  else problems.push(`member count changed by ${memberChange} (${left.length} left, ${arrived.length} arrived)`);
}

const cycles = after.cycles.filter((c) => before.cycles.includes(c));
// Money of members in both versions, so members leaving (a new Congress) isn't a drop.
const both = (m: Member) => beforeIds.has(m.bioguide) && afterIds.has(m.bioguide);
const money = (f: MembersFile, key: "pac" | "individual" | "receipts" | "itemized", cycle: number) =>
  f.members.filter(both).reduce((n, m) => n + (m.totals[cycle]?.[key] ?? 0), 0);
const employerMoney = (f: MembersFile) => f.members.filter(both).reduce((n, m) => n + (m.individuals?.itemized ?? 0), 0);
const fmt = (n: number) => `$${(n / 1e6).toFixed(1)}M`;
const pct = (a: number, b: number) => (a ? `${b >= a ? "+" : ""}${(((b - a) / a) * 100).toFixed(1)}%` : "new");

for (const key of ["pac", "individual", "receipts"] as const) {
  const a = cycles.reduce((n, c) => n + money(before, key, c), 0);
  const b = cycles.reduce((n, c) => n + money(after, key, c), 0);
  const perCycle = cycles.map((c) => `${c} ${fmt(money(before, key, c))} → ${fmt(money(after, key, c))}`).join(", ");
  console.log(`${key}: ${fmt(a)} → ${fmt(b)} (${pct(a, b)}); ${perCycle}`);
  if (a && b < a * (1 - MAX_DROP)) problems.push(`total ${key} money dropped ${pct(a, b)}`);
}
const ea = employerMoney(before);
const eb = employerMoney(after);
console.log(`itemized individual donations (bulk file): ${fmt(ea)} → ${fmt(eb)} (${pct(ea, eb)})`);
// Summed over all cycles, so only comparable while the cycles are the same.
if (ea && eb < ea * (1 - MAX_DROP) && before.cycles.join() === after.cycles.join()) problems.push(`itemized individual donations dropped ${pct(ea, eb)}`);

if (problems.length) {
  console.log(`\nNot pushing:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("data looks sane");
