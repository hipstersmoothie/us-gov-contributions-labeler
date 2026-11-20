// Draw a random sample of revolving-door matches to check by hand, and keep the
// verdicts in data/revolving-door-review.json (the about page reports them).
//
//   tsx src/scripts/review-revolving.ts sample 150 50   new sample: 150 member matches, 50 committee matches
//   tsx src/scripts/review-revolving.ts show            print the sample, numbered, to check
//   tsx src/scripts/review-revolving.ts wrong 8 31      mark these as wrong (the rest of the sample right)
//
// A match is right when the job, as written, was in that member's office (or on
// that committee's staff), now or earlier in their career.
import fs from "fs";
import type { RevolvingFile } from "../ingest/revolving.js";

const FILE = "data/revolving-door-review.json";
type Item = { kind: "member" | "committee"; lobbyist: string; id: string; job: string; right: boolean | null };

const [cmd, ...rest] = process.argv.slice(2);
const data = JSON.parse(fs.readFileSync("data/revolving-door.json", "utf8")) as RevolvingFile;
const names = new Map<string, string>([
  ...JSON.parse(fs.readFileSync("data/members.json", "utf8")).members.map((m: any) => [m.bioguide, `${m.name} (${m.chamber}, ${m.state})`]),
  ...JSON.parse(fs.readFileSync("data/congress-committees.json", "utf8")).committees.map((c: any) => [c.id, c.name]),
]);

// A seeded shuffle, so a sample can be redrawn the same way. mulberry32, in
// 32-bit integer arithmetic: a multiply in floats loses the low bits, and a
// shuffle that indexes with them stops being uniform.
function shuffle<T>(list: T[], seed = 20261116) {
  const random = () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

if (cmd === "sample") {
  const [nMembers = 150, nCommittees = 50] = rest.map(Number);
  const members = data.lobbyists.flatMap((l) => l.members.map((m): Item => ({ kind: "member", lobbyist: l.name, id: m.bioguide, job: m.job, right: null })));
  const committees = data.lobbyists.flatMap((l) => l.committees.map((c): Item => ({ kind: "committee", lobbyist: l.name, id: c.id, job: c.job, right: null })));
  const sample = [...shuffle(members).slice(0, nMembers), ...shuffle(committees).slice(0, nCommittees)];
  fs.writeFileSync(FILE, JSON.stringify({ drawnFrom: data.generatedAt, sample }, null, 1) + "\n");
  console.log(`${sample.length} matches sampled into ${FILE}`);
} else if (cmd === "show") {
  const { sample } = JSON.parse(fs.readFileSync(FILE, "utf8")) as { sample: Item[] };
  sample.forEach((s, i) => console.log(`${i + 1}. [${names.get(s.id) ?? s.id}] <= ${s.job}`));
} else if (cmd === "wrong") {
  const file = JSON.parse(fs.readFileSync(FILE, "utf8")) as { sample: Item[] };
  const wrong = new Set(rest.map(Number));
  file.sample.forEach((s, i) => (s.right = !wrong.has(i + 1)));
  fs.writeFileSync(FILE, JSON.stringify(file, null, 1) + "\n");
  const tally = (k: string) => `${file.sample.filter((s) => s.kind === k && s.right).length}/${file.sample.filter((s) => s.kind === k).length}`;
  console.log(`members ${tally("member")} right, committees ${tally("committee")} right`);
} else {
  console.log("usage: review-revolving.ts sample [members] [committees] | show | wrong <n>...");
}
