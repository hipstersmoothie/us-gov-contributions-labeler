// Certified election results, entered by hand from each state's official
// certification, and checked against the source before they're used.
//
//   pnpm race-results status [year]          races still without a result, by state, with candidates' FEC ids
//   pnpm race-results add <year> <race> <winner FEC id>... --source "the Delaware Department of Elections" \
//        --url https://elections.delaware.gov/... --date 2026-11-12 [--evidence <url>] [--runoff] [--note "..."]
//   pnpm race-results check [year]           fetch every source and look for each winner's name in it
//   pnpm race-results import <year> <file>   add a batch (research notes, JSON: { states: { XX: { certifiedBy, sourceUrl,
//                                            certifiedDate, races: { "XX-01": { status, winners } } } } }); only
//                                            entries that pass validation and the source check are written
//
// Every entry needs the certifying office, an https link on an official
// (.gov/.us, or a state's results vendor) site, and the certification date.
// When the certification doesn't name the winners (board minutes, a press
// release, a scanned certificate), --evidence links the state's official
// results that do; the winner's name has to be in one of the two.
// The races step ignores entries that don't validate, and leaves a race
// pending when an entry disagrees with another official source (the FEC's
// results compilation, or who was sworn in).
// Never enter a result from news reports or unofficial returns.
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { parseArgs } from "util";
import { USER_AGENT } from "../lib/download.js";
import { isOfficialUrl, loadElection, racesFile, resultsFile, type RaceResult, type RacesFile } from "../ingest/races.js";
import { pdfText } from "./disclosures/pdf.js";

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: { source: { type: "string" }, url: { type: "string" }, evidence: { type: "string" }, date: { type: "string" }, runoff: { type: "boolean" }, note: { type: "string" } },
});
const [command = "status", ...rest] = positionals;
// Piped into head: stop quietly.
process.stdout.on("error", (e: NodeJS.ErrnoException) => (e.code === "EPIPE" ? process.exit(0) : Promise.reject(e)));
const latestYear = () => Math.max(...fs.readdirSync("data").flatMap((f) => (/^races-(\d{4})\.json$/.test(f) ? [Number(f.slice(6, 10))] : [])));

type Entry = Omit<RaceResult, "confirmedBy" | "conflict"> & { status: "certified" | "runoff"; winners: string[]; source: string; sourceUrl: string; date: string };
type ResultsFile = { _doc?: string; results: Record<string, Entry> };
const readResults = (year: number): ResultsFile =>
  fs.existsSync(resultsFile(year)) ? JSON.parse(fs.readFileSync(resultsFile(year), "utf8")) : { results: {} };
function writeResults(year: number, file: ResultsFile) {
  const sorted = Object.fromEntries(Object.entries(file.results).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(resultsFile(year), JSON.stringify({ ...file, results: sorted }, null, 2) + "\n");
}
const readRaces = (year: number): RacesFile => JSON.parse(fs.readFileSync(racesFile(year), "utf8"));
const lastName = (raw: string) => raw.split(",")[0]!.trim();

/** Why an entry can't be used, or undefined. */
function invalid(races: RacesFile, race: string, e: Partial<Entry>) {
  const r = races.races.find((x) => x.id === race);
  if (!r) return `no race ${race} in ${racesFile(races.year)}`;
  const ids = new Set([...r.candidates.map((c) => c.id), ...r.others.map((c) => c.id)]);
  if (e.status !== "certified" && e.status !== "runoff") return `status must be certified or runoff`;
  if (!e.winners?.length) return "no winners";
  if (e.status === "certified" && e.winners.length !== 1) return "a certified result has one winner";
  if (e.status === "runoff" && e.winners.length !== 2) return "a runoff has two candidates";
  const unknown = e.winners.filter((w) => !ids.has(w));
  if (unknown.length) return `${unknown.join(", ")} not in ${race} (candidates: ${[...ids].join(", ")})`;
  if (!e.source) return "--source (who certified it) is required";
  if (!e.sourceUrl || !isOfficialUrl(e.sourceUrl)) return `--url must be an https link on an official site (.gov, .us or the state's results vendor), not ${e.sourceUrl}`;
  if (e.evidenceUrl && !isOfficialUrl(e.evidenceUrl)) return `--evidence must be an https link on an official site, not ${e.evidenceUrl}`;
  if (!e.date || !/^\d{4}-\d{2}-\d{2}$/.test(e.date)) return "--date YYYY-MM-DD (when it was certified) is required";
  if (e.date < races.electionDay) return `certified ${e.date}, before the election (${races.electionDay})`;
}

/** The source's text, cached: HTML without tags, or a PDF's text. */
async function sourceText(url: string) {
  const file = path.join(".cache/race-results", crypto.createHash("sha1").update(url).digest("hex").slice(0, 16));
  let body: Buffer;
  if (fs.existsSync(file)) body = fs.readFileSync(file);
  else {
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`${res.status} from ${url}`);
    body = Buffer.from(await res.arrayBuffer());
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  if (body.subarray(0, 5).toString() === "%PDF-") return (await pdfText(body)).lines.flat().join("\n");
  return body.toString("utf8").replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;|&#160;/g, " ").replace(/&amp;/g, "&");
}
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z]+/g, " ");

/** Each winner's last name has to appear in the source. Returns the names missing. */
async function namesMissing(races: RacesFile, race: string, e: Entry) {
  const r = races.races.find((x) => x.id === race)!;
  const all = [...r.candidates, ...r.others];
  const texts = await Promise.all([e.sourceUrl, e.evidenceUrl].filter((u): u is string => !!u).map((u) => sourceText(u).catch(() => "")));
  const text = ` ${texts.map(fold).join(" ")} `;
  return e.winners.map((w) => all.find((c) => c.id === w)!).filter((c) => !text.includes(` ${fold(lastName(c.name)).trim()} `)).map((c) => c.name);
}

async function main() {
  if (command === "status") {
    const year = Number(rest[0]) || latestYear();
    const races = readRaces(year);
    const E = loadElection(year);
    const pending = races.races.filter((r) => r.result.status === "pending" || r.result.status === "upcoming" || r.result.status === "runoff");
    const byState = new Map<string, typeof pending>();
    for (const r of pending) byState.set(r.state, [...(byState.get(r.state) ?? []), r]);
    const today = new Date().toISOString().slice(0, 10);
    const deadline = (st: string) => E.certification?.[st]?.deadline ?? "9999";
    console.log(`${year}: ${races.races.length - pending.length} of ${races.races.length} races have a result; ${pending.length} pending. Election day ${E.electionDay}.`);
    console.log(`States past their certification date come first: look for their certification, and enter it with add.\n`);
    for (const [state, list] of [...byState].sort((a, b) => deadline(a[0]).localeCompare(deadline(b[0])))) {
      const c = E.certification?.[state];
      const due = c?.deadline ? (c.deadline <= today ? `certifies ${c.deadline}: check now` : `certifies ${c.deadline}`) : "certification date not posted";
      console.log(`${state}  ${due}${E.runoffs?.[state] ? `; runoffs ${E.runoffs[state]}` : ""}${c?.results ? `\n    ${c.results}` : ""}`);
      for (const r of list) {
        console.log(`  ${r.id}${r.result.status === "runoff" ? " runoff" : ""}${r.result.conflict ? `  CONFLICT: ${r.result.conflict}` : ""}`);
        for (const c of r.candidates) console.log(`    ${c.id}  ${c.name}${c.party ? ` (${c.party})` : ""}`);
      }
    }
    return;
  }

  if (command === "add") {
    const [y, race, ...winners] = rest;
    const year = Number(y);
    const races = readRaces(year);
    const e = { status: opts.runoff ? "runoff" : "certified", winners, source: opts.source, sourceUrl: opts.url, evidenceUrl: opts.evidence, date: opts.date, note: opts.note } as Entry;
    if (!e.evidenceUrl) delete e.evidenceUrl;
    if (!e.note) delete e.note;
    const why = invalid(races, race!, e);
    if (why) throw new Error(why);
    const missing = await namesMissing(races, race!, e);
    if (missing.length) throw new Error(`${missing.join(", ")} not found in ${e.sourceUrl}; check the winner and the link`);
    const file = readResults(year);
    file.results[race!] = e;
    writeResults(year, file);
    console.log(`${race}: ${e.status} ${winners.join(", ")} (${e.source}, ${e.date}); run pnpm ingest --steps=races to apply`);
    return;
  }

  if (command === "check") {
    const year = Number(rest[0]) || latestYear();
    const races = readRaces(year);
    let bad = 0;
    for (const [race, e] of Object.entries(readResults(year).results)) {
      const why = invalid(races, race, e) ?? (await namesMissing(races, race, e).then((m) => (m.length ? `${m.join(", ")} not in the source` : undefined)).catch((err: Error) => err.message));
      if (why) bad++;
      console.log(`${why ? "FAIL" : "ok  "} ${race} ${e.winners.join(", ")}${why ? `: ${why}` : ""}`);
    }
    if (bad) process.exitCode = 1;
    return;
  }

  if (command === "import") {
    const [y, notes] = rest;
    const year = Number(y);
    const races = readRaces(year);
    const input = JSON.parse(fs.readFileSync(notes!, "utf8")) as {
      states: Record<string, { certified?: boolean; certifiedBy?: string; sourceUrl?: string; evidenceUrl?: string; certifiedDate?: string | null; races?: Record<string, { status: "certified" | "runoff"; winners: string[]; sourceUrl?: string }> }>;
    };
    const file = readResults(year);
    let added = 0;
    for (const [state, s] of Object.entries(input.states)) {
      if (!s.certified) continue;
      for (const [race, r] of Object.entries(s.races ?? {})) {
        const e = { status: r.status, winners: r.winners, source: s.certifiedBy, sourceUrl: r.sourceUrl ?? s.sourceUrl, evidenceUrl: s.evidenceUrl, date: s.certifiedDate ?? undefined } as Entry;
        if (!e.evidenceUrl) delete e.evidenceUrl;
        const why = invalid(races, race, e) ?? (await namesMissing(races, race, e).then((m) => (m.length ? `${m.join(", ")} not in the source` : undefined)).catch((err: Error) => err.message));
        if (why) {
          console.log(`skip ${state} ${race}: ${why}`);
          continue;
        }
        file.results[race] = e;
        added++;
        console.log(`add  ${race} ${e.status} ${e.winners.join(", ")}`);
      }
    }
    writeResults(year, file);
    console.log(`${added} results written to ${resultsFile(year)}; run pnpm ingest --steps=races to apply`);
    return;
  }
  throw new Error(`unknown command ${command}; see the top of src/scripts/race-results.ts`);
}

await main();
