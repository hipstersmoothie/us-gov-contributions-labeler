// Bills, roll call votes, and the lobbying reports that name each bill, for
// data/legislation.json.
//
//   Bills       GovInfo BILLSTATUS bulk XML, one zip per bill type
//   Votes       House Clerk and Senate roll call XML, one file per vote
//   Lobbying    every LD-2 quarterly report of the Congress, from lda.gov
//
// Bills get a page when either chamber held a recorded vote on passing them.
// Lobbying reports name bills in free text, so a citation only counts when the
// bill had been introduced by the end of the report's quarter (otherwise it's
// the same number in an earlier Congress) and any name written beside it
// matches the bill.
import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { XMLParser } from "fast-xml-parser";
import { downloadFile } from "../lib/download.js";
import { getJson } from "../lib/http.js";
import { mapLimit } from "../lib/async.js";
import { normalizeOrg, sameOrg, titleCase } from "../lib/names.js";
import { billRefs, introducedBy, nameAgrees } from "../lib/bill-refs.js";
import { displayName } from "../lib/bill-names.js";
import type { Legislator } from "../lib/legislators.js";
import type { OrganizationRecord } from "./build.js";

const DIR = ".cache/legis";
const DAY = 24 * 60 * 60 * 1000;
const BILL_TYPES = ["hr", "s", "hjres", "sjres", "hconres", "sconres", "hres", "sres"];
/** Simple resolutions (rules, commemorations) don't get pages. */
const PAGE_TYPES = new Set(["hr", "s", "hjres", "sjres", "hconres", "sconres"]);
const LABEL: Record<string, string> = {
  hr: "H.R.", s: "S.", hres: "H.Res.", sres: "S.Res.", hjres: "H.J.Res.", sjres: "S.J.Res.", hconres: "H.Con.Res.", sconres: "S.Con.Res.",
};
const URL_TYPE: Record<string, string> = {
  hr: "house-bill", s: "senate-bill", hjres: "house-joint-resolution", sjres: "senate-joint-resolution",
  hconres: "house-concurrent-resolution", sconres: "senate-concurrent-resolution", hres: "house-resolution", sres: "senate-resolution",
};
// senate.gov turns away requests without a browser-like User-Agent.
const UA = "Mozilla/5.0 (compatible; contributions.fyi)";
const LDA = { intervalMs: 250, maxWaitMs: 30_000, headers: { Authorization: `Token ${process.env.LDA_API_KEY}` } };
/** Organizations quoted per bill; the rest are listed by name only. */
const MAX_QUOTES = 120;

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false, trimValues: true });
const list = <T>(x: T | T[] | undefined): T[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
const text = (x: any): string => (x === undefined || x === null ? "" : typeof x === "object" ? String(x["#text"] ?? "") : String(x));
const label = (type: string, number: number) => `${LABEL[type] ?? type.toUpperCase()} ${number}`;

/** The Congress in session on a date, and its two years. */
export function congressFor(date = new Date()) {
  // A Congress starts January 3 of an odd year.
  const year = date.getUTCFullYear();
  const first = year % 2 ? (date < new Date(Date.UTC(year, 0, 3)) ? year - 2 : year) : year - 1;
  return { congress: (first - 1789) / 2 + 1, years: [first, first + 1] };
}

// --- bills ------------------------------------------------------------------------

interface Bill {
  id: string;
  type: string;
  number: number;
  /** What people call it: the popular or short title, else the display title. */
  name: string;
  title: string;
  shortTitles: string[];
  introduced: string;
  policyArea?: string;
  subjects: string[];
  sponsor?: string;
  cosponsors: string[];
  committees: string[];
  latestAction?: { date: string; text: string };
  laws: string[];
  summary?: BillSummary;
  text?: BillText;
}

const SUMMARY_TAGS = new Set(["p", "ul", "ol", "li", "strong", "em", "br", "a"]);

/** A CRS summary's HTML, cut to the tags it uses for prose and split into its
 *  top-level paragraphs and lists. Links keep only an http(s) href. */
function summaryBlocks(html: string) {
  const clean = html
    .replace(/<(\/?)(\w+)([^>]*)>/g, (_, close: string, tag: string, attrs: string) => {
      tag = tag.toLowerCase();
      if (!SUMMARY_TAGS.has(tag)) return "";
      if (tag !== "a" || close) return `<${close}${tag}>`;
      const href = attrs.match(/href\s*=\s*"(https?:[^"]*)"/i)?.[1];
      return href ? `<a href="${href}">` : "<a>";
    })
    .replace(/<a>([\s\S]*?)<\/a>/g, "$1")
    .replace(/\s+/g, " ");
  const blocks: string[] = [];
  let depth = 0;
  let start = 0;
  for (const m of clean.matchAll(/<(\/?)(p|ul|ol)>/g)) {
    if (!m[1]) {
      if (depth++ === 0) start = m.index;
    } else if (depth > 0 && --depth === 0) {
      blocks.push(clean.slice(start, m.index + m[0].length).trim());
    }
  }
  return blocks.filter((b) => b.replace(/<[^>]+>/g, "").trim());
}

/** The latest summary the Congressional Research Service wrote, without the
 *  bill's name it opens with. */
function latestSummary(b: any): BillSummary | undefined {
  const s = (list(b.summaries?.summary) as any[])
    .map((x) => ({ date: text(x.actionDate), updated: text(x.updateDate), version: text(x.actionDesc), html: text(x.text) }))
    .sort((x, y) => x.date.localeCompare(y.date) || x.updated.localeCompare(y.updated))
    .at(-1);
  if (!s) return undefined;
  const blocks = summaryBlocks(s.html);
  if (blocks[0] && /^<p><strong>[^<]*<\/strong><\/p>$/.test(blocks[0])) blocks.shift();
  return blocks.length ? { version: s.version, date: s.date, blocks } : undefined;
}

/** The newest printed version of the bill: the public law once enacted, then the
 *  enrolled bill (GovInfo leaves it undated), then by date. */
function latestText(b: any): BillText | undefined {
  const rank = (v: { version: string; date: string }) =>
    /^Public Law/i.test(v.version) ? "3" : !v.date ? "2" : "1" + v.date;
  const v = (list(b.textVersions?.item) as any[])
    .map((x) => ({
      version: text(x.type),
      date: text(x.date).slice(0, 10),
      xml: (list(x.formats?.item) as any[]).map((f) => text(f.url)).find((u) => u.endsWith(".xml")),
    }))
    .filter((x) => x.xml)
    .sort((x, y) => rank(x).localeCompare(rank(y)))
    .at(-1);
  if (!v) return undefined;
  // .../BILLS-119hr1346rfs/xml/BILLS-119hr1346rfs.xml -> .../pdf/BILLS-119hr1346rfs.pdf
  const pdf = v.xml!.replace(/\/(xml|uslm)\/([^/]+)\.xml$/, "/pdf/$2.pdf");
  return { version: v.version, ...(v.date ? { date: v.date } : {}), ...(pdf !== v.xml ? { pdf } : {}) };
}

function parseBill(xml: string): Bill {
  const b = parser.parse(xml).billStatus.bill;
  const type = text(b.type).toLowerCase();
  const titles = list(b.titles?.item) as any[];
  // Titles "for portions of this bill" name pieces folded into it (H.R. 7567,
  // the 2026 farm bill, carries "CFTC Whistleblower Office Account Act").
  const whole = titles.filter((t) => !/portions/i.test(text(t.titleType)));
  const pick = (re: RegExp) => whole.find((t) => re.test(text(t.titleType)))?.title as string | undefined;
  const display = text(b.title);
  const generic = /^(An act|A bill|A resolution|Joint resolution|Concurrent resolution|Providing|Making|To )/i.test(display);
  const name =
    pick(/^Popular Title/i) ??
    pick(/^Short Title\(s\) as Enacted/i) ??
    (generic ? (pick(/^Short Title\(s\) as Passed/i) ?? pick(/^Short Title\(s\) as (Introduced|Reported)/i)) : undefined) ??
    display;
  return {
    id: `${type}${text(b.number)}`,
    type,
    number: Number(text(b.number)),
    name: text(name).replace(/\.$/, ""),
    title: display,
    shortTitles: [...new Set(titles.filter((t) => /short title/i.test(text(t.titleType))).map((t) => text(t.title)))],
    introduced: text(b.introducedDate),
    policyArea: b.policyArea ? text(b.policyArea.name) : undefined,
    subjects: list(b.subjects?.legislativeSubjects?.item).map((s: any) => text(s.name)),
    sponsor: list(b.sponsors?.item).map((s: any) => text(s.bioguideId))[0],
    cosponsors: list(b.cosponsors?.item).map((c: any) => text(c.bioguideId)),
    committees: list(b.committees?.item).map((c: any) => text(c.systemCode)),
    latestAction: b.latestAction ? { date: text(b.latestAction.actionDate), text: text(b.latestAction.text) } : undefined,
    laws: list(b.laws?.item).map((l: any) => text(l.number)),
    summary: latestSummary(b),
    text: latestText(b),
  };
}

async function fetchBills(congress: number) {
  const bills = new Map<string, Bill>();
  for (const type of BILL_TYPES) {
    const zip = path.join(DIR, "billstatus", `${type}.zip`);
    if (!fs.existsSync(zip) || Date.now() - fs.statSync(zip).mtimeMs > DAY) {
      await downloadFile(`https://www.govinfo.gov/bulkdata/BILLSTATUS/${congress}/${type}/BILLSTATUS-${congress}-${type}.zip`, zip);
    }
    // Every bill's XML, back to back; split on the declarations.
    const child = spawn("unzip", ["-p", zip]);
    let buffer = "";
    const take = (xml: string) => {
      if (!xml.trim()) return;
      const bill = parseBill(xml);
      bills.set(bill.id, bill);
    };
    for await (const chunk of child.stdout.setEncoding("utf8")) {
      buffer += chunk;
      const parts = buffer.split(/(?=<\?xml )/);
      buffer = parts.pop()!;
      parts.forEach(take);
    }
    take(buffer);
  }
  return bills;
}

// --- votes ------------------------------------------------------------------------

type Position = "Y" | "N" | "P" | "NV";
interface RollCall {
  id: string;
  chamber: "house" | "senate";
  roll: number;
  date: string;
  question: string;
  result: string;
  bill?: string;
  required?: string;
  positions: Record<string, Position>;
  /** Party as recorded on the roll call; members who switch later keep the one they voted under. */
  parties: Record<string, string>;
}

const POSITION: Record<string, Position> = {
  Yea: "Y", Aye: "Y", Yes: "Y", Nay: "N", No: "N", Present: "P", "Not Voting": "NV", Guilty: "Y", "Not Guilty": "N",
};

/** "H R 3633" / "S. 5" / "H J RES 25" -> "hr3633" / "s5" / "hjres25"; nominations are left out. */
function measure(s: string) {
  const m = s.replace(/\./g, "").replace(/\s+/g, " ").trim().match(/^(H R|HR|H RES|HRES|H J RES|HJRES|H CON RES|HCONRES|S|S RES|SRES|S J RES|SJRES|S CON RES|SCONRES) ?(\d+)$/i);
  return m ? m[1]!.replace(/ /g, "").toLowerCase() + m[2] : undefined;
}

async function cachedXml(file: string, url: string) {
  const p = path.join(DIR, "votes", file);
  if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  const res = await fetch(url, { headers: { "User-Agent": UA } }).catch(() => null);
  if (!res?.ok) return null;
  const body = await res.text();
  // The Clerk answers 200 with an error document for rolls that don't exist yet.
  if (!/<(rollcall-vote|roll_call_vote|vote_summary)>/.test(body)) return null;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Vote menus change as votes are added; roll calls don't.
  if (!file.includes("menu")) fs.writeFileSync(p, body);
  return body;
}

function parseHouse(xml: string, year: number): RollCall {
  const v = parser.parse(xml)["rollcall-vote"];
  const meta = v["vote-metadata"];
  const positions: Record<string, Position> = {};
  const parties: Record<string, string> = {};
  for (const r of list(v["vote-data"]?.["recorded-vote"]) as any[]) {
    const id = r.legislator["@name-id"];
    parties[id] = r.legislator["@party"];
    // The Speaker election records names, not Yea/Nay.
    positions[id] = POSITION[text(r.vote)] ?? "Y";
  }
  const roll = Number(text(meta["rollcall-num"]));
  return {
    id: `h${year}-${roll}`,
    chamber: "house",
    roll,
    date: new Date(text(meta["action-date"]) + " UTC").toISOString().slice(0, 10),
    question: text(meta["vote-question"]),
    result: text(meta["vote-result"]),
    bill: measure(text(meta["legis-num"])),
    required: text(meta["vote-type"]).startsWith("2/3") ? "2/3" : "1/2",
    positions,
    parties,
  };
}

function parseSenate(xml: string, lisToBioguide: Map<string, string>): RollCall {
  const v = parser.parse(xml).roll_call_vote;
  const positions: Record<string, Position> = {};
  const parties: Record<string, string> = {};
  for (const m of list(v.members?.member) as any[]) {
    const id = lisToBioguide.get(text(m.lis_member_id));
    if (!id) continue;
    positions[id] = POSITION[text(m.vote_cast)] ?? "NV";
    parties[id] = text(m.party);
  }
  const doc = v.document ?? {};
  return {
    id: `s${text(v.congress_year)}-${Number(text(v.vote_number))}`,
    chamber: "senate",
    roll: Number(text(v.vote_number)),
    date: new Date(text(v.vote_date).split(",").slice(0, 2).join(",") + " UTC").toISOString().slice(0, 10),
    question: text(v.question) || text(v.vote_question_text),
    result: text(v.vote_result),
    bill: measure(text(doc.document_name) || `${text(doc.document_type)} ${text(doc.document_number)}`),
    required: text(v.majority_requirement) || undefined,
    positions,
    parties,
  };
}

interface LegislatorRecord {
  id: { bioguide: string; lis?: string };
  terms: {
    start: string;
    end: string;
    party?: string;
    caucus?: string;
    party_affiliations?: { start: string; end: string; party: string; caucus?: string }[];
  }[];
}

/** Current and former members. Senators who left during the Congress are only in the historical file. */
async function fetchLegislatorRecords() {
  return (
    await Promise.all(
      ["current", "historical"].map(async (which) =>
        (await fetch(`https://unitedstates.github.io/congress-legislators/legislators-${which}.json`)).json()
      )
    )
  ).flat() as LegislatorRecord[];
}

const LETTER: Record<string, string> = { Democrat: "D", Republican: "R", Independent: "I" };

/** Who an independent caucused with on a date ("D" / "R"), from congress-legislators'
 *  terms and mid-term party changes (Kevin Kiley left the Republicans in March 2026
 *  and caucuses with them as an independent). */
function caucusLookup(records: LegislatorRecord[]) {
  const byId = new Map(records.map((r) => [r.id.bioguide, r]));
  return (bioguide: string, date: string) => {
    for (const t of byId.get(bioguide)?.terms ?? []) {
      if (date < t.start || date > t.end) continue;
      const spell = t.party_affiliations?.find((a) => date >= a.start && date <= a.end);
      const caucus = spell ? (spell.caucus ?? (spell.party !== "Independent" ? spell.party : undefined)) : t.caucus;
      return caucus ? LETTER[caucus] : undefined;
    }
    return undefined;
  };
}

async function fetchRollCalls(congress: number, years: number[], records: LegislatorRecord[]) {
  const lisToBioguide = new Map(records.filter((l) => l.id.lis).map((l) => [l.id.lis!, l.id.bioguide]));

  const votes: RollCall[] = [];
  for (const [i, year] of years.entries()) {
    if (year > new Date().getUTCFullYear()) continue;
    const session = i + 1;
    // House rolls are numbered from 1 each year; stop at the first gap.
    for (let roll = 1; ; roll += 20) {
      const batch = Array.from({ length: 20 }, (_, k) => roll + k);
      const xmls = await mapLimit(batch, 6, (r) =>
        cachedXml(`h${year}-${r}.xml`, `https://clerk.house.gov/evs/${year}/roll${String(r).padStart(3, "0")}.xml`)
      );
      for (const xml of xmls) if (xml) votes.push(parseHouse(xml, year));
      if (xmls.some((x) => !x)) break;
    }
    // The Senate's vote menu says how many votes there are.
    const menu = await cachedXml(
      `s-menu-${congress}-${session}.xml`,
      `https://www.senate.gov/legislative/LIS/roll_call_lists/vote_menu_${congress}_${session}.xml`
    );
    if (!menu) continue;
    const count = Math.max(0, ...list(parser.parse(menu).vote_summary.votes?.vote).map((v: any) => Number(text(v.vote_number))));
    const xmls = await mapLimit(
      Array.from({ length: count }, (_, k) => k + 1),
      4,
      (n) =>
        cachedXml(
          `s${year}-${n}.xml`,
          `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${String(n).padStart(5, "0")}.xml`
        )
    );
    for (const xml of xmls) if (xml) votes.push(parseSenate(xml, lisToBioguide));
  }
  return votes;
}

// --- lobbying reports -----------------------------------------------------------------

export interface Ld2 {
  uuid: string;
  type: string;
  year: number;
  period: string;
  posted: string;
  registrant: { id: number; name: string };
  client: { id: number; name: string };
  income: number | null;
  expenses: number | null;
  /** Everyone listed as lobbying on the filing, with the covered government positions they disclosed. */
  lobbyists: LdaLobbyist[];
  activities: { code: string; text: string }[];
}

export interface LdaLobbyist {
  id: number;
  first: string;
  last: string;
  suffix?: string;
  position?: string;
}

const PERIODS = ["first_quarter", "second_quarter", "third_quarter", "fourth_quarter"];

/** Quarters of the Congress whose reports are due (20 days after the quarter ends). */
function dueQuarters(years: number[]) {
  const out: { year: number; period: string }[] = [];
  for (const year of years) {
    PERIODS.forEach((period, i) => {
      const due = Date.UTC(year, (i + 1) * 3, 21);
      if (due <= Date.now()) out.push({ year, period });
    });
  }
  return out;
}

async function fetchQuarter(year: number, period: string): Promise<Ld2[]> {
  type Page = { count: number; results: any[] };
  // Pages are capped at 25 filings and take about a second each, so fetch
  // numbered pages in parallel (paced by getJson).
  const pageUrl = (page: number) =>
    "https://lda.gov/api/v1/filings/?" +
    new URLSearchParams({ filing_year: String(year), filing_period: period, ordering: "id", page_size: "25", page: String(page) });
  const first = (await getJson<Page>(pageUrl(1), LDA))!;
  const pages = Math.ceil(first.count / 25);
  // lda.gov throttles bursts now and then; retry failed pages in later passes.
  const results = new Map<number, any[]>([[1, first.results]]);
  for (let pass = 0; pass < 5 && results.size < pages; pass++) {
    if (pass) await new Promise((r) => setTimeout(r, 60_000));
    const todo = Array.from({ length: pages }, (_, i) => i + 1).filter((p) => !results.has(p));
    await mapLimit(todo, 4, async (page) => {
      try {
        results.set(page, (await getJson<Page>(pageUrl(page), LDA))?.results ?? []);
        if (results.size % 200 === 0) console.log(`    ${year} ${period}: ${results.size}/${pages} pages`);
      } catch {}
    });
  }
  if (results.size < pages) throw new Error(`${year} ${period}: ${pages - results.size} lobbying report pages failed`);
  const seen = new Set<string>();
  return [...results.values()].flat().flatMap((f): Ld2[] => {
    if (seen.has(f.filing_uuid)) return [];
    seen.add(f.filing_uuid);
    return [
      {
        uuid: f.filing_uuid,
        type: f.filing_type,
        year: f.filing_year,
        period: f.filing_period,
        posted: f.dt_posted,
        registrant: { id: f.registrant.id, name: f.registrant.name },
        client: { id: f.client.id, name: f.client.name },
        income: f.income === null ? null : Number(f.income),
        expenses: f.expenses === null ? null : Number(f.expenses),
        // Ahead of the long activity text, so hasLobbyists() finds it at the start of the file.
        lobbyists: filingLobbyists(f.lobbying_activities),
        activities: f.lobbying_activities.map((a: any) => ({ code: a.general_issue_code, text: a.description ?? "" })),
      },
    ];
  });
}

/** Each lobbyist once per filing (they're listed under every issue they worked on), with the
 *  fullest covered position they gave. */
function filingLobbyists(activities: any[]): LdaLobbyist[] {
  const byId = new Map<number, LdaLobbyist>();
  for (const a of activities) {
    for (const l of a.lobbyists ?? []) {
      const id = l.lobbyist?.id;
      if (!id) continue;
      const position = (l.covered_position ?? "").replace(/\s+/g, " ").trim() || undefined;
      const prev = byId.get(id);
      if (prev) {
        if (position && position.length > (prev.position?.length ?? 0)) prev.position = position;
        continue;
      }
      byId.set(id, {
        id,
        first: (l.lobbyist.nickname || l.lobbyist.first_name || "").trim(),
        last: (l.lobbyist.last_name ?? "").trim(),
        ...(l.lobbyist.suffix_display ? { suffix: l.lobbyist.suffix_display } : {}),
        ...(position ? { position } : {}),
      });
    }
  }
  return [...byId.values()];
}

/** Every filing of each quarter of the Congress (registrations, reports and amendments), fetching
 *  quarters not cached yet. The two most recent quarters are refetched weekly, since late filings
 *  and amendments still arrive. */
export async function ldaQuarters(years: number[], budgetMinutes: number) {
  const deadline = Date.now() + budgetMinutes * 60_000;
  const quarters = dueQuarters(years);
  const filings: Ld2[] = [];
  const have: string[] = [];
  for (const [i, { year, period }] of quarters.entries()) {
    const file = path.join(DIR, "ld2", `${year}-${period}.json`);
    const recent = i >= quarters.length - 2;
    const stale =
      !fs.existsSync(file) || (recent && Date.now() - fs.statSync(file).mtimeMs > 7 * DAY) || !hasLobbyists(file);
    if (stale && Date.now() < deadline) {
      console.log(`  Lobbying reports, ${year} ${period}`);
      try {
        const fetched = await fetchQuarter(year, period);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(fetched));
      } catch (error) {
        console.error(`  ${(error as Error).message}; keeping what's cached`);
      }
    }
    if (!fs.existsSync(file)) {
      console.log(`  ${year} ${period} left for the next run`);
      continue;
    }
    have.push(`${year}-${period}`);
    filings.push(...(JSON.parse(fs.readFileSync(file, "utf8")) as Ld2[]));
  }
  return { filings, quarters: have };
}

/** Quarters cached before lobbyists were kept get fetched again. */
function hasLobbyists(file: string) {
  if (!fs.existsSync(file)) return false;
  const fd = fs.openSync(file, "r");
  const head = Buffer.alloc(4096);
  const n = fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  const start = head.subarray(0, n).toString("utf8");
  return start === "[]" || start.includes('"lobbyists"');
}

/** Quarterly reports, the latest amendment of each. */
async function lobbyingReports(years: number[], budgetMinutes: number) {
  const { filings, quarters } = await ldaQuarters(years, budgetMinutes);
  const latest = new Map<string, Ld2>();
  for (const f of filings) {
    if (f.type.startsWith("R")) continue; // registrations
    const key = `${f.registrant.id}:${f.client.id}:${f.year}:${f.period}`;
    const prev = latest.get(key);
    if (!prev || prev.posted < f.posted) latest.set(key, f);
  }
  return { reports: [...latest.values()], quarters };
}

// --- output ---------------------------------------------------------------------------

export type VotePattern = "party-line" | "near-unanimous" | "split";

export interface LegislationVote {
  id: string;
  chamber: "house" | "senate";
  date: string;
  question: string;
  result: string;
  required?: string;
  pattern: VotePattern;
  /** Every member who voted, current or not, by the party recorded on the roll call. */
  tally: Record<string, { yes: number; no: number; other: number }>;
  /** The same, with independents counted in the party they caucus with ("I" only for those who don't). */
  byCaucus: Record<string, { yes: number; no: number; other: number }>;
  /** Independents who voted, and the party they caucused with that day. */
  caucus?: Record<string, string>;
  /** Current members' votes; P (present) and NV (not voting) are both "other". */
  yes: string[];
  no: string[];
  other: string[];
  /** Current members who voted under a different party than they hold now. */
  parties?: Record<string, string>;
}

export interface LobbyingClient {
  name: string;
  /** Organization id, when the client has a PAC on the site. */
  org?: string;
  quarters: string[];
  /** The organization said it supported or opposed the bill, in the report. */
  stance?: "support" | "oppose";
  /** What the report says, around the bill number. */
  quote?: string;
}

export interface BillSummary {
  /** The version of the bill it describes, as CRS names it: "Introduced in House", "Passed Senate", "Public Law". */
  version: string;
  date: string;
  /** Paragraphs and lists, as HTML limited to p, ul, ol, li, strong, em, br and a. */
  blocks: string[];
}

export interface BillText {
  /** "Engrossed in House", "Enrolled Bill", "Public Law"... */
  version: string;
  date?: string;
  /** GovInfo's PDF of that version. */
  pdf?: string;
}

export interface LegislationBill {
  id: string;
  label: string;
  /** Its short title, or a readable name made from the official title. */
  name: string;
  /** The official title. */
  title: string;
  introduced: string;
  policyArea?: string;
  subjects: string[];
  sponsor?: string;
  cosponsors: string[];
  committees: string[];
  latestAction?: { date: string; text: string };
  law?: string;
  url: string;
  /** What the bill does, from the Congressional Research Service, when it has written one. */
  summary?: BillSummary;
  /** Its latest text; the full text is on congress.gov at `${url}/text`. */
  text?: BillText;
  votes: LegislationVote[];
  lobbying: LobbyingClient[];
}

export interface OrganizationBill {
  id: string;
  label: string;
  name: string;
  quarters: number;
  stance?: "support" | "oppose";
  law?: string;
  /** Has a page here (a recorded passage vote). */
  page: boolean;
}

export interface LegislationFile {
  generatedAt: string;
  congress: number;
  /** Current independents and who they caucus with now: { S000033: "D" }. */
  caucus: Record<string, string>;
  quarters: string[];
  bills: LegislationBill[];
  organizations: Record<string, OrganizationBill[]>;
}

// Votes on passing a measure, in either chamber, including agreeing to the
// other chamber's version. Procedural votes (rules, cloture, motions to
// recommit or table) and amendments are left out: they mostly follow party
// lines whatever the bill says. Only bills, joint and concurrent resolutions
// get pages, so "Agreeing to the Resolution" never picks up a House rule.
const isPassage = (v: RollCall) =>
  /Passage|Suspend the Rules and (Pass|Agree)|Concur|Joint Resolution|Concurrent Resolution|Agreeing to the Resolution|Conference Report|Override/i.test(v.question) &&
  !/Previous Question|Recommit|Table|Cloture|Proceed/i.test(v.question);

function summarize(v: RollCall, currentParty: Map<string, string>, caucusAt: (id: string, date: string) => string | undefined): LegislationVote {
  // Rows by the party recorded on the roll call; patterns and "broke with
  // party" by caucus, so an independent counts with the party they caucus with.
  const tally: LegislationVote["tally"] = {};
  const byCaucus: LegislationVote["tally"] = {};
  const caucus: Record<string, string> = {};
  const add = (into: LegislationVote["tally"], key: string, p: Position) => {
    const t = (into[key] ??= { yes: 0, no: 0, other: 0 });
    if (p === "Y") t.yes++;
    else if (p === "N") t.no++;
    else t.other++;
  };
  for (const [id, p] of Object.entries(v.positions)) {
    const party = v.parties[id] || currentParty.get(id) || "?";
    const group = party === "I" ? (caucusAt(id, v.date) ?? "I") : party;
    if (party === "I" && group !== "I") caucus[id] = group;
    add(tally, party, p);
    add(byCaucus, group, p);
  }
  const share = (p: string) => {
    const t = byCaucus[p];
    return t && t.yes + t.no ? t.yes / (t.yes + t.no) : 0.5;
  };
  const d = share("D");
  const r = share("R");
  const pattern: VotePattern =
    (d >= 0.9 && r <= 0.1) || (d <= 0.1 && r >= 0.9)
      ? "party-line"
      : (d >= 0.9 && r >= 0.9) || (d <= 0.1 && r <= 0.1)
        ? "near-unanimous"
        : "split";
  const current = Object.entries(v.positions).filter(([id]) => currentParty.has(id));
  const parties = Object.fromEntries(
    current.filter(([id]) => v.parties[id] && v.parties[id] !== currentParty.get(id)).map(([id]) => [id, v.parties[id]!])
  );
  return {
    id: v.id,
    chamber: v.chamber,
    date: v.date,
    question: v.question,
    result: v.result,
    required: v.required,
    pattern,
    tally,
    byCaucus,
    ...(Object.keys(caucus).length ? { caucus } : {}),
    yes: current.filter(([, p]) => p === "Y").map(([id]) => id),
    no: current.filter(([, p]) => p === "N").map(([id]) => id),
    other: current.filter(([, p]) => p === "P" || p === "NV").map(([id]) => id),
    ...(Object.keys(parties).length ? { parties } : {}),
  };
}

// "support" (group 1) or "oppose" (group 2).
const STANCE = /\b(?:(support(?:s|ed|ing)?|in favor|urg(?:e|ed|ing) (?:passage|enactment))|(oppos(?:e|ed|es|ing|ition)|against))\b/gi;
// Before a citation, a stance has to point at it: "Oppose the X Act (H.R. 5)", "In opposition to
// H.R. 5", "Urged Congress to support H.R. 5", not "in favor of a federal privacy law S. 5".
const POINTS_AT = /^(?:[\s:,(–—-]|\b(?:the|of|to|for|on|its|passage|enactment|final|bill|legislation)\b)*$/i;
// After one, it can't be some other verb's or noun's: "tax credits in H.R. 1 that support the
// development of batteries", "funding to support autonomous vessels", "funding support for CPSC".
const SOMEONE_ELSES = /\b(?:to|that|which|who|would|will|could|can|and|is|are|was|were|has|have|authorizes?|provides?|providing|bipartisan|funding|combat|life|technical|customer|income|price|agencies|programs|services)\s+$/i;
// After one, "against" alone is too common ("imposes sanctions against foreign persons"): it has to
// be someone's ("advocated against", "a letter against") or about the bill ("against the bill").
const OWN_AGAINST =
  /\b(?:advoca\w*|lobb\w*|vot\w*|work\w*|argu\w*|position\w*|campaign\w*|testif\w*|spoke|letter|statement|comments?)\s+against\s*$|^against\s+(?:it\b|passage|(?:the|this)\s+(?:bill|legislation|measure|resolution|package)\b)/i;
// A capitalized stance some way after one starts the next item: "H.R. 1, the One Big Beautiful
// Bill Act Support for GRAD PLUS loan program", "pipeline provisions in HR 1, Support 4z changes",
// unless it's set off for this one: "H.R. 5: Support", "(Oppose)".
const NEXT_ITEM = /^(?:Support|Supports|Supported|Supporting|SUPPORT|Oppose|Opposes|Opposed|Opposing|OPPOSE|In favor|Urge|Urged)\b/;

// A bill's name isn't a stance: "SUPPORT for Patients and Communities Act", "Preventing Violence
// Against Women Act", "Para Professional and Support Staff Act", "(SUPPORT) Act". Anything that
// reads as an act's name is blanked out before looking, unless it starts with the stance itself
// ("Supports the Clean Energy Act"), and so is anything in quotes.
const ACT_NAME =
  /(?<![\w(])(?!(?:Support|Supports|Supported|Oppose|Opposes|Opposed|Opposing|Urge|Urges|Urged|Urging)\b)\(?[A-Z][\w'’.-]*\)?(?:\s+(?:(?:of|and|for|the|to|in|on|a|an|by|with|from|that|&)\s+)*\(?[A-Z0-9][\w'’.-]*\)?)*\s+Act\b/g;
const QUOTED = /"[^"\n]{3,120}"|“[^”\n]{3,120}”/g;

// Where one item of a report ends: a semicolon, a line break, or the end of a sentence.
const ITEM_END = /;|\n|\.["”')\]]*\s+/g;

/** The text with the names of the bills it cites (and anything else that reads as a name) blanked
 *  out, at the same length so offsets still line up, and where its items end. */
function readable(textValue: string, names: (string | undefined)[]) {
  const blank = (s: string) => " ".repeat(s.length);
  let plain = textValue;
  const lower = textValue.toLowerCase();
  // Filers often leave off the year: "SUPPORT for Patients and Communities Reauthorization Act".
  const all = names.flatMap((n) => (n ? [n, n.replace(/\s+of\s+\d{4}$/, "")] : []));
  for (const name of new Set(all)) {
    if (name.length < 8) continue;
    const n = name.toLowerCase();
    for (let i = lower.indexOf(n); i >= 0; i = lower.indexOf(n, i + n.length)) {
      plain = plain.slice(0, i) + blank(name) + plain.slice(i + n.length);
    }
  }
  plain = plain.replace(ACT_NAME, blank).replace(QUOTED, blank);
  // Read off the text as filed ("Act. support Uyghur…" ends one), but not inside a name ("D.C. Crimes Act").
  const ends = [...textValue.matchAll(ITEM_END)].filter((m) => plain[m.index] === textValue[m.index]).map((m) => m.index + m[0].length);
  return { plain, ends };
}

// n characters back from (or ahead of) i, not counting blanks.
function back(s: string, i: number, n: number) {
  while (i > 0 && n > 0) if (!/\s/.test(s[--i]!)) n--;
  return i;
}
function ahead(s: string, i: number, n: number) {
  while (i < s.length && n > 0) if (!/\s/.test(s[i++]!)) n--;
  return i;
}

/** What a report says about one citation of a bill, for a stance and a quote. The stance is read
 *  from the citation (with companion bills cited alongside it, "H.R. 28/S. 9") to the next
 *  citation or the end of the item, plus the few words leading up to it, unless another bill is
 *  cited first in the same item: in "H.R. 5 - support passage H.R. 6", the support is H.R. 5's.
 *  When the name comes first, "Oppose the X Act (H.R. 5)", what leads up to it counts too. */
function around(textValue: string, { plain, ends }: ReturnType<typeof readable>, at: [number, number], cites: [number, number][]) {
  let [start, end] = at;
  // Companions are joined by a slash, a comma or "and" ("HR 1 HR 247" are two items).
  const between = (a: number, b: number) => /^[\s(]*(?:[/,&]|and\b|or\b)[\s/,&(]*$/i.test(textValue.slice(a, b));
  const before = cites.filter(([, e]) => e <= start).reverse();
  for (const [s, e] of before) if (between(e, start)) start = s; else break;
  const after = cites.filter(([s]) => s >= end);
  for (const [s, e] of after) if (between(end, s)) end = e; else break;
  const prev = cites.filter(([, e]) => e <= start).at(-1)?.[1] ?? 0;
  const next = cites.find(([s]) => s >= end)?.[0] ?? textValue.length;

  // A name, blanked out, right before the citation (or its opening parenthesis).
  let k = start;
  while (k > prev && /[\s(]/.test(textValue[k - 1]!)) k--;
  const nameFirst = k > prev && plain[k - 1] === " " && textValue[k - 1] !== " ";

  const leadEnd = ends.filter((e) => e > prev && e <= start).at(-1);
  const lead = nameFirst || leadEnd !== undefined || prev === 0 ? Math.max(leadEnd ?? prev, back(plain, start, 40)) : start;
  let tailEnd = Math.min(ends.find((e) => e > end) ?? next, next, ahead(plain, end, 50));
  // Up to the next item: "Opposed H.R. 4, the X Act Supported H.R. 5".
  const theirs = [...plain.slice(end, tailEnd).matchAll(STANCE)].find((m) => {
    const at = end + m.index;
    if (POINTS_AT.test(plain.slice(at + m[0].length, next))) return true;
    const gap = textValue.slice(end, at);
    return NEXT_ITEM.test(textValue.slice(at)) && !/[(:–—-]\s*$/.test(gap);
  });
  if (theirs) tailEnd = end + theirs.index;

  const hits: { at: number; stance: "support" | "oppose" }[] = [];
  const leadHit = [...plain.slice(lead, start).matchAll(STANCE)].at(-1);
  if (leadHit && POINTS_AT.test(plain.slice(lead + leadHit.index + leadHit[0].length, start))) {
    hits.push({ at: lead + leadHit.index, stance: leadHit[1] ? "support" : "oppose" });
  }
  for (const m of plain.slice(end, tailEnd).matchAll(STANCE)) {
    const before = plain.slice(lead, end + m.index);
    if (SOMEONE_ELSES.test(before)) continue;
    if (/^against$/i.test(m[0]) && !OWN_AGAINST.test(before + m[0]) && !OWN_AGAINST.test(plain.slice(end + m.index, tailEnd))) continue;
    hits.push({ at: end + m.index, stance: m[1] ? "support" : "oppose" });
  }
  // "Monitor the following: H.R. 28" says they took no side.
  const monitor = /\bmonitor(s|ed|ing)?\b/i.test(plain.slice(lead, start) + " " + plain.slice(end, tailEnd));
  const stances = new Set(hits.map((h) => h.stance));
  const stance = !monitor && stances.size === 1 ? hits[0]!.stance : undefined;
  const said = stance ? hits[0]!.at : undefined;

  // The quote shows the citation and where it says so, starting and ending on word boundaries.
  const lo = Math.min(at[0], said ?? at[0]);
  const hi = Math.max(at[1], (said ?? 0) + 12);
  let q0 = Math.max(lo - 80, 0);
  if (q0 > 0) q0 = textValue.indexOf(" ", q0) + 1 || q0;
  let q1 = Math.min(Math.max(q0 + 200, hi + 40), textValue.length);
  if (q1 < textValue.length) q1 = Math.max(textValue.lastIndexOf(" ", q1), hi);
  const quote = (q0 > 0 ? "…" : "") + textValue.slice(q0, q1).replace(/\s+/g, " ").trim() + (q1 < textValue.length ? "…" : "");
  return { stance, quote };
}

export async function ingestLegislation(
  legislators: Legislator[],
  organizations: OrganizationRecord[],
  options: { lobbyingMinutes: number }
): Promise<LegislationFile> {
  const { congress, years } = congressFor();
  console.log(`Legislation, ${congress}th Congress`);

  const bills = await fetchBills(congress);
  console.log(`  ${bills.size.toLocaleString()} bills and resolutions`);
  const records = await fetchLegislatorRecords();
  const caucusAt = caucusLookup(records);
  const rollCalls = await fetchRollCalls(congress, years, records);
  console.log(`  ${rollCalls.length} roll calls`);
  const { reports, quarters } = await lobbyingReports(years, options.lobbyingMinutes);
  console.log(`  ${reports.length.toLocaleString()} lobbying reports, ${quarters.length} quarters`);

  // Lobbying clients -> our organizations, by the LDA client name each was matched on at ingest.
  const lobbyists = organizations.filter((o) => o.lobbying && !o.lobbying.firm);
  const byClient = new Map(lobbyists.map((o) => [normalizeOrg(o.lobbying!.client), o.id]));
  const matched = new Map<string, string | undefined>();
  const matchOrg = (client: string) => {
    const key = normalizeOrg(client);
    if (!matched.has(key)) matched.set(key, byClient.get(key) ?? lobbyists.find((o) => sameOrg(o.lobbying!.client, client))?.id);
    return matched.get(key);
  };

  // One pass over every report: which bills each client's reports name.
  const PERIOD: Record<string, string> = { first_quarter: "Q1", second_quarter: "Q2", third_quarter: "Q3", fourth_quarter: "Q4" };
  // The quote is from where a stance was found, so the row shows it.
  type Citation = { name: string; org?: string; quarters: Set<string>; stances: Set<string>; quote: string; stanceQuote?: string };
  const cited = new Map<string, Map<string, Citation>>();
  let kept = 0;
  let dropped = 0;
  for (const r of reports) {
    for (const a of r.activities) {
      const refs = billRefs(a.text, congress);
      if (!refs.length) continue;
      const cites = refs.flatMap((ref) => ref.at).sort((x, y) => x[0] - y[0]);
      let plain: ReturnType<typeof readable> | undefined;
      for (const ref of refs) {
        const bill = bills.get(ref.bill);
        if (!bill || ref.otherCongress) continue;
        if (!introducedBy(bill.introduced, r.year, r.period) || !nameAgrees(ref.named, [bill.name, bill.title, ...bill.shortTitles])) {
          dropped++;
          continue;
        }
        kept++;
        const key = normalizeOrg(r.client.name) || r.client.name;
        const byClientForBill = cited.get(ref.bill) ?? cited.set(ref.bill, new Map()).get(ref.bill)!;
        const c = byClientForBill.get(key) ?? { name: r.client.name, org: matchOrg(r.client.name), quarters: new Set(), stances: new Set(), quote: "" };
        c.quarters.add(`${r.year} ${PERIOD[r.period]}`);
        plain ??= readable(
          a.text,
          refs.flatMap((x) => {
            const b = bills.get(x.bill);
            return [x.named, b?.name, b?.title, ...(b?.shortTitles ?? [])];
          })
        );
        for (const at of ref.at) {
          const { stance, quote } = around(a.text, plain, at, cites);
          if (stance) {
            c.stances.add(stance);
            c.stanceQuote ??= quote;
          }
          if (!c.quote) c.quote = quote;
        }
        byClientForBill.set(key, c);
      }
    }
  }
  console.log(`  ${kept.toLocaleString()} bill citations kept, ${dropped.toLocaleString()} dropped as another Congress's bill or a mismatched name`);

  const currentParty = new Map(legislators.map((l) => [l.bioguide, l.party[0]!]));
  const orgName = new Map(organizations.map((o) => [o.id, o.name]));
  const passage = rollCalls.filter((v) => v.bill && isPassage(v));
  const votesByBill = new Map<string, RollCall[]>();
  for (const v of passage) votesByBill.set(v.bill!, [...(votesByBill.get(v.bill!) ?? []), v]);

  const out: LegislationBill[] = [...votesByBill.entries()]
    .filter(([id]) => bills.has(id) && PAGE_TYPES.has(bills.get(id)!.type))
    .map(([id, vs]) => {
      const b = bills.get(id)!;
      const clients = [...(cited.get(id)?.values() ?? [])]
        .map((c) => ({
          name: c.org ? orgName.get(c.org)! : titleCase(c.name),
          org: c.org,
          quarters: [...c.quarters].sort(),
          stance: c.stances.size === 1 ? ([...c.stances][0] as "support" | "oppose") : undefined,
          quote: (c.stances.size === 1 && c.stanceQuote) || c.quote,
        }))
        // Organizations on the site first, then by how long they lobbied on it.
        .sort((x, y) => Number(!!y.org) - Number(!!x.org) || y.quarters.length - x.quarters.length || x.name.localeCompare(y.name));
      return {
        id,
        label: label(b.type, b.number),
        name: displayName(b.name),
        title: b.title,
        introduced: b.introduced,
        policyArea: b.policyArea,
        subjects: b.subjects.slice(0, 12),
        sponsor: b.sponsor,
        cosponsors: b.cosponsors,
        // "hsba00" -> "HSBA", "ssfi13" -> "SSFI13", matching the site's committee ids.
        committees: [...new Set(b.committees.map((c) => c.slice(0, 4).toUpperCase() + (c.slice(4) === "00" ? "" : c.slice(4))))],
        latestAction: b.latestAction,
        law: b.laws[0],
        url: `https://www.congress.gov/bill/${congress}th-congress/${URL_TYPE[b.type]}/${b.number}`,
        summary: b.summary,
        text: b.text,
        votes: vs.sort((x, y) => x.date.localeCompare(y.date) || x.roll - y.roll).map((v) => summarize(v, currentParty, caucusAt)),
        // A stance always keeps its quote, so it can be checked.
        lobbying: clients.map((c, i) => (i < MAX_QUOTES || c.stance ? c : { ...c, quote: undefined })),
      };
    })
    .sort((x, y) => y.lobbying.length - x.lobbying.length);
  const pages = new Set(out.map((b) => b.id));

  // For organization pages: every bill its reports name.
  const byOrg = new Map<string, OrganizationBill[]>();
  for (const [id, clients] of cited) {
    const b = bills.get(id)!;
    for (const c of clients.values()) {
      if (!c.org) continue;
      byOrg.set(c.org, [
        ...(byOrg.get(c.org) ?? []),
        {
          id,
          label: label(b.type, b.number),
          name: displayName(b.name),
          quarters: c.quarters.size,
          stance: c.stances.size === 1 ? ([...c.stances][0] as "support" | "oppose") : undefined,
          law: b.laws[0],
          page: pages.has(id),
        },
      ]);
    }
  }
  const orgBills = Object.fromEntries(
    [...byOrg.entries()].map(([org, list]) => [
      org,
      list.sort((x, y) => y.quarters - x.quarters || Number(y.page) - Number(x.page) || x.label.localeCompare(y.label)).slice(0, 60),
    ])
  );

  console.log(`  ${out.length} bills with passage votes; ${byOrg.size} organizations named bills in their reports`);
  const today = new Date().toISOString().slice(0, 10);
  const caucus = Object.fromEntries(
    legislators.filter((l) => l.party === "Independent").flatMap((l) => {
      const c = caucusAt(l.bioguide, today);
      return c ? [[l.bioguide, c]] : [];
    })
  );
  return { generatedAt: new Date().toISOString(), congress, caucus, quarters, bills: out, organizations: orgBills };
}
