// Honorary expenses and gifts to presidential committees, from LD-203 lobbyist
// contribution reports on lda.gov. Every lobbying registrant and listed
// lobbyist files one twice a year (2 U.S.C. § 1604(d)); the FECA contributions
// they list are already in the FEC data, so only the other kinds are kept:
// paying for an event that honors a covered official (he), for an event one
// hosts (me), and gifts to presidential library (ple) and inaugural (pic)
// committees. Measured in design/ld203/README.md.
//
// There is no bulk file; the API's contribution_type filter returns the few
// hundred filings a year with such items, 25 to a page. Amendments replace the
// whole report they amend, so the latest posting per filer and period wins;
// an amendment that drops the items wouldn't come back through the type
// filter, so amendments posted since the last run are pulled on their own.
import fs from "fs";
import path from "path";
import type { Legislator } from "../lib/legislators.js";
import { getJson } from "../lib/http.js";
import { USER_AGENT } from "../lib/download.js";
import { looksLikePac, normalizeOrg, sameOrg } from "../lib/names.js";
import type { OrganizationRecord } from "./build.js";

export type Ld203Type = "he" | "me" | "ple" | "pic";
export type PayeeClass = "caucus" | "nonprofit" | "venue" | "pac" | "party" | "inaugural" | "library" | "other";
export type HonoreeMatch = "full" | "surname" | "ambiguous" | "none";
export type HonoreeClass = "official" | "group" | "executive" | "blank" | "other";

export interface Ld203Item {
  id: string;
  filing: string;
  /** The filing on lda.gov. */
  url: string;
  year: number;
  period: "mid_year" | "year_end";
  posted: string;
  type: Ld203Type;
  registrant: number;
  /** For a lobbyist's own filing: their name. */
  lobbyist?: string;
  /** Who paid, when the filing names a PAC rather than the registrant itself. */
  contributor?: string;
  payee: string;
  payeeClass: PayeeClass;
  honoree: string;
  honoreeClass: HonoreeClass;
  match: HonoreeMatch;
  /** Current members the honoree text names, when the match is sure. */
  members: string[];
  /** How many people the honoree text seems to name (1 when it names one). */
  honorees: number;
  amount: number;
  date?: string;
  comments?: string;
}

export interface Ld203Registrant {
  id: number;
  name: string;
  /** Our organization page, when the registrant is one of the site's organizations. */
  organization?: string;
}

export interface Ld203Data {
  generatedAt: string;
  /** First filing year pulled. */
  since: number;
  /** Member pages show items from this date on. */
  memberSince: string;
  items: Ld203Item[];
  registrants: Record<number, Ld203Registrant>;
}

const API = "https://lda.gov/api/v1";
const CACHE = ".cache/ld203/api";
const STATE_FILE = ".cache/ld203/state.json";
const ALIASES_FILE = "data/ld203-aliases.json";
const TYPES: Ld203Type[] = ["he", "me", "ple", "pic"];
const FIRST_YEAR = 2023;
export const MEMBER_SINCE = "2025-01-03";
const WEEK = 7 * 24 * 60 * 60 * 1000;
// lda.gov allows 15 requests a minute anonymous, 120 with a key; page_size is capped at 25.
const LDA: { intervalMs: number; headers: Record<string, string> } = process.env.LDA_API_KEY
  ? { intervalMs: 550, headers: { "User-Agent": USER_AGENT, Authorization: `Token ${process.env.LDA_API_KEY}` } }
  : { intervalMs: 4100, headers: { "User-Agent": USER_AGENT } };

interface ApiItem {
  contribution_type: "feca" | Ld203Type;
  contributor_name: string | null;
  payee_name: string | null;
  honoree_name: string | null;
  amount: string | null;
  date: string | null;
}
interface Filing {
  filing_uuid: string;
  filing_type: "MM" | "MA" | "YY" | "YA";
  filing_year: number;
  filing_period: "mid_year" | "year_end";
  filing_document_url: string;
  filer_type: "lobbyist" | "organization";
  dt_posted: string;
  comments: string | null;
  registrant: { id: number; name: string };
  lobbyist: { id: number; first_name: string; last_name: string } | null;
  contribution_items: ApiItem[];
}
interface Page {
  count: number;
  next: string | null;
  results: Filing[];
}

let requests = 0;
async function fetchPage(url: string): Promise<Page> {
  requests++;
  const page = await getJson<Page>(url, LDA);
  if (!page) throw new Error(`404 from ${url}`);
  return page;
}

/**
 * Every page of one year's filings with items of one type, from the cache
 * unless the year is still being filed or amended (this year and last) and
 * the copy is a week old. Pages are cached by number, so a stale year is
 * refetched whole.
 */
async function yearType(year: number, type: Ld203Type, thisYear: number): Promise<Filing[]> {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = (n: number) => path.join(CACHE, `${year}_${type}_p${n}.json`);
  const first = file(1);
  const fresh = fs.existsSync(first) && (year < thisYear - 1 || Date.now() - fs.statSync(first).mtimeMs < WEEK);
  if (!fresh) {
    for (const f of fs.readdirSync(CACHE)) if (f.startsWith(`${year}_${type}_p`)) fs.rmSync(path.join(CACHE, f));
    let url: string | null = `${API}/contributions/?${new URLSearchParams({ filing_year: String(year), contribution_type: type, page_size: "25", ordering: "dt_posted" })}`;
    for (let n = 1; url; n++) {
      const page: Page = await fetchPage(url);
      fs.writeFileSync(file(n), JSON.stringify(page));
      url = page.next;
    }
  }
  const out: Filing[] = [];
  for (let n = 1; fs.existsSync(file(n)); n++) out.push(...(JSON.parse(fs.readFileSync(file(n), "utf8")) as Page).results);
  return out;
}

/** Amendments posted since the last run, whatever their items, so a report that lost its items still supersedes the original. */
async function amendmentsSince(since: string): Promise<Filing[]> {
  const out: Filing[] = [];
  for (const filing_type of ["MA", "YA"]) {
    let url: string | null = `${API}/contributions/?${new URLSearchParams({ filing_type, filing_dt_posted_after: since, page_size: "25", ordering: "dt_posted" })}`;
    while (url) {
      const page: Page = await fetchPage(url);
      out.push(...page.results);
      url = page.next;
    }
  }
  return out;
}

const filerKey = (f: Filing) => `${f.registrant.id}|${f.lobbyist?.id ?? ""}|${f.filing_year}|${f.filing_period}`;

// ---- Honorees -------------------------------------------------------------

const NICKNAMES: Record<string, string[]> = {
  CHARLES: ["CHUCK", "CHARLIE"], JAMES: ["JIM", "JIMMY"], MICHAEL: ["MIKE"], ROBERT: ["BOB", "ROB", "BOBBY"],
  WILLIAM: ["BILL", "BILLY", "WILL"], RICHARD: ["DICK", "RICK", "RICH"], THOMAS: ["TOM", "TOMMY"], DANIEL: ["DAN", "DANNY"],
  DAVID: ["DAVE"], JOSEPH: ["JOE"], TIMOTHY: ["TIM"], EDWARD: ["ED", "TED"], STEVEN: ["STEVE"], STEPHEN: ["STEVE"],
  BENJAMIN: ["BEN"], PATRICK: ["PAT"], PETER: ["PETE"], ANTHONY: ["TONY"], ANDREW: ["ANDY", "DREW"], JONATHAN: ["JON"],
  MATTHEW: ["MATT"], CHRISTOPHER: ["CHRIS"], MITCHELL: ["MITCH"], JOHN: ["JACK", "JOHNNY"], GERALD: ["JERRY", "GERRY"],
  RONALD: ["RON", "RONNY"], DONALD: ["DON"], GREGORY: ["GREG"], KENNETH: ["KEN"], SAMUEL: ["SAM"], NICHOLAS: ["NICK"],
  ELIZABETH: ["LIZ", "BETH", "BETTY"], KATHERINE: ["KATHY"], KATHLEEN: ["KATHY"], DEBORAH: ["DEBBIE"], MARGARET: ["MAGGIE"],
  BERNARD: ["BERNIE"], HENRY: ["HANK"], HAROLD: ["HAL"], JEFFREY: ["JEFF"], JOSHUA: ["JOSH"], RAYMOND: ["RAY"],
  RUSSELL: ["RUSS"], VERNON: ["VERN"], LOUIS: ["LOU"], LAWRENCE: ["LARRY"], DOUGLAS: ["DOUG"], ZACHARY: ["ZACH"],
  RANDALL: ["RANDY"], RUDOLPH: ["RUDY"], BRADLEY: ["BRAD"], MAXWELL: ["MAX"], FREDERICK: ["FRED"], ALEXANDER: ["ALEX"],
  CATHERINE: ["CATHY"], PATRICIA: ["PATTY", "PAT"], VICTORIA: ["VICKY"], SUSAN: ["SUE"], CYNTHIA: ["CINDY"],
  JACQUELINE: ["JACKIE"], ABRAHAM: ["ABE"], NANCY: ["NAN"], TAMARA: ["TAMMY"], RAFAEL: ["TED"],
};
const SUFFIX = /^(JR|SR|II|III|IV)$/;
const PARTICLE = /^(VAN|DE|LA|DEL|VON|DI|DA|ST|MC)$/;
const words = (s: string) =>
  s.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Z ]/g, " ").split(/\s+/).filter(Boolean);
const HONORIFIC =
  /\b(the\s+)?(honorable|hon|senators?|sens?|representatives?|reps?|congress(man|woman|member|men|women|members)|u\.?s\.?|speaker|leaders?|majority|minority|whip|chairman|chairwoman|chair|ranking member|dr|mr|mrs|ms|house|senate|of|and|for|member)\b\.?/gi;
/** "Department of Justice", "Secretary of War": a title, not a person. */
const ORG_BEFORE = new Set(["OF", "DEPARTMENT", "DEPT"]);
/** "John F. Kennedy Center", "McConnell Center": an institution, not the person. */
const ORG_AFTER = new Set("CENTER CENTRE FOUNDATION INSTITUTE LIBRARY AWARD AWARDS SCHOLARSHIP SCHOOL PRIZE BUILDING HALL SOCIETY MEMORIAL FELLOWSHIP GALA DINNER CLASSIC ARCHIVES LECTURE LECTURES MUSEUM FUND PAC".split(" "));

interface Keyed {
  bioguide: string;
  last: string[];
  firsts: Set<string>;
}

function indexMembers(legislators: Legislator[]) {
  const bySurname = new Map<string, Keyed[]>();
  for (const l of legislators) {
    const w = words(l.name).filter((t) => !SUFFIX.test(t));
    const lastWords = words(l.last).filter((t) => !SUFFIX.test(t));
    const last = lastWords.length ? lastWords : PARTICLE.test(w[w.length - 2] ?? "") ? w.slice(-2) : w.slice(-1);
    const firsts = new Set<string>([...words(l.first), ...(l.nickname ? words(l.nickname) : [])].filter((t) => t.length > 1));
    for (const g of [...firsts]) for (const n of NICKNAMES[g] ?? []) firsts.add(n);
    for (const [full, nicks] of Object.entries(NICKNAMES)) if (nicks.some((n) => firsts.has(n))) firsts.add(full);
    const key = last.join(" ");
    bySurname.set(key, [...(bySurname.get(key) ?? []), { bioguide: l.bioguide, last, firsts }]);
  }
  return bySurname;
}

function honoreeClass(text: string): HonoreeClass {
  const lower = text.toLowerCase();
  if (!text || /^(n\/?a|none|-|\.|0|na|not applicable|see comments?)$/i.test(text)) return "blank";
  if (/\b(caucus|foundation|institute|members? of congress|various|multiple|several|delegation|committee|conference|all members|freshm[ae]n|class of)\b/.test(lower)) return "group";
  if (/\b(president|vice president|governor|mayor|secretary|administrator|ambassador|justice|judge|general|admiral|commissioner|director|trump|vance|biden|first lady)\b/.test(lower) && !/\b(sen|rep|congress)/.test(lower)) return "executive";
  if (/\b(sen|rep|congress|speaker|whip|leader|hon)/.test(lower)) return "official";
  return "other";
}

/** How many people a list like "Rep. A; Rep. B and Sen. C" names. */
function countHonorees(text: string) {
  const parts = text
    .replace(/\([^)]*\)/g, " ")
    .replace(/,\s*(jr|sr|ii|iii|iv)\b\.?/gi, "")
    .split(/;|,|\band\b|&|\//i)
    .map((p) => p.replace(HONORIFIC, " ").trim())
    .filter((p) => /[A-Za-z]{2,}/.test(p));
  return Math.max(1, parts.length);
}

function matchHonoree(text: string, bySurname: Map<string, Keyed[]>, speaker?: string): { match: HonoreeMatch; members: string[] } {
  const cleaned = text.replace(/\([^)]*\)/g, " ").replace(/\b[DRI]-[A-Z]{2}\b/g, " ").replace(HONORIFIC, " ");
  const w = words(cleaned);
  // "Sen.", "Rep.", "Speaker"… somewhere in the text. Without one, a surname
  // alone ("Collins, Doug", "James David Vance") isn't evidence of a member.
  const honorific = /\b(sen|senator|senators|rep|reps|representative|representatives|congress\w*|speaker|whip|leader|hon|honorable)\b/i.test(text);
  const hits = new Map<string, { m: Keyed; full: boolean }>();
  for (const [surname, ms] of bySurname) {
    const sw = surname.split(" ");
    const positions: number[] = [];
    for (let i = 0; i + sw.length <= w.length; i++) if (sw.every((t, j) => w[i + j] === t)) positions.push(i);
    const usable = positions.filter((i) => !ORG_AFTER.has(w[i + sw.length] ?? "") && !ORG_BEFORE.has(w[i - 1] ?? ""));
    if (!usable.length) continue;
    // A first name right next to the surname: "Mitch McConnell", "Rep. Chuck Fleischmann", "McConnell, Mitch".
    const near = (m: Keyed) =>
      usable.some((i) => [i - 3, i - 2, i - 1, i + sw.length, i + sw.length + 1].some((k) => k >= 0 && k < w.length && m.firsts.has(w[k]!)));
    const full = ms.filter(near);
    if (full.length) for (const m of full) hits.set(m.bioguide, { m, full: true });
    else if (surname === "JOHNSON" && speaker && /speaker/i.test(text)) hits.set(speaker, { m: ms.find((m) => m.bioguide === speaker)!, full: true });
    else if (!honorific) continue;
    else for (const m of ms) hits.set(m.bioguide, { m, full: false });
  }
  const all = [...hits.values()];
  if (!all.length) return { match: "none", members: [] };
  const fulls = all.filter((h) => h.full).map((h) => h.m.bioguide);
  if (fulls.length) return { match: "full", members: fulls };
  const surnames = new Set(all.map((h) => h.m.last.join(" ")));
  // Surname only: sure when no other current member shares it.
  if (all.length === surnames.size) return { match: "surname", members: all.map((h) => h.m.bioguide) };
  return { match: "ambiguous", members: [] };
}

// ---- Payees ---------------------------------------------------------------

export function payeeClass(name: string): PayeeClass {
  const n = name.toUpperCase();
  if (/INAUGUR/.test(n)) return "inaugural";
  if (/LIBRARY|PRESIDENTIAL CENTER/.test(n)) return "library";
  if (/\b(NRCC|DCCC|DSCC|NRSC|RNC|DNC)\b|REPUBLICAN (NATIONAL|SENATORIAL|CONGRESSIONAL|PARTY)|DEMOCRATIC (NATIONAL|SENATORIAL|CONGRESSIONAL|PARTY)|(REPUBLICAN|DEMOCRATIC) (GOVERNORS|ATTORNEYS|STATE)|STATE (REPUBLICAN|DEMOCRATIC) PARTY/.test(n)) return "party";
  if (looksLikePac(n) || /\bFOR (CONGRESS|SENATE|US SENATE|U S SENATE|AMERICA|GOVERNOR|PRESIDENT|THE PEOPLE)\b|\bCAMPAIGN\b|\bFRIENDS OF\b|CITIZENS FOR|COMMITTEE TO ELECT|\bPAC\b|LEADERSHIP FUND|VICTORY FUND|MAJORITY FUND/.test(n)) return "pac";
  if (/CAUCUS|\bCBC\b|\bCHCI\b|\bCAPAC\b|CONGRESSIONAL (BLACK|HISPANIC|ASIAN|WOMEN|AWARD|SPORTS|BASEBALL|FOOTBALL|SOCCER|HOCKEY|CLUB)|CONGRESSIONAL .*(INSTITUTE|FOUNDATION)|(INSTITUTE|FOUNDATION).*CONGRESSIONAL/.test(n)) return "caucus";
  if (/FOUNDATION|INSTITUTE|CHARIT|SCHOLARSHIP|UNIVERSITY|COLLEGE|SCHOOL|HOSPITAL|MUSEUM|CHURCH|MISSION|SOCIETY|COUNCIL|ALLIANCE|ASSOCIATION|CENTER|CENTRE|FUND\b|TRUST\b|\bINC\b|NETWORK|PROJECT|PARTNERSHIP|COALITION|LEAGUE|FORUM|AWARDS?|DINNER|GALA|BALL\b|\bHONORS?\b|TRIBUTE|MEMORIAL|VETERANS|CHILDREN|YOUTH|WOMEN|FAMIL|COMMUNITY|HABITAT|RELIEF|CANCER|HEALTH|ARTS?\b|THEATRE|THEATER|SYMPHONY|OPERA|ORCHESTRA|ZOO|BOYS|GIRLS|SCOUTS|YMCA|RED CROSS|UNITED WAY|WISH|HOPE\b/.test(n)) return "nonprofit";
  if (/HOTEL|RESTAURANT|CATER|CLUB\b|EVENTS?\b|HALL\b|ROOM|RESORT|STEAKHOUSE|GRILL|CAFE|BAR\b|WINERY|BREWERY|GOLF|COUNTRY CLUB|STADIUM|ARENA|TICKETS?|AIRLINE|TRAVEL|RENTAL|PRODUCTIONS?|PHOTO|PRINT|FLORIST|FLOWERS|BAKERY|VENDORS?|LLC/.test(n)) return "venue";
  return "other";
}

const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

export async function ingestLd203(legislators: Legislator[], organizations: OrganizationRecord[]): Promise<Ld203Data> {
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: thisYear - FIRST_YEAR + 1 }, (_, i) => FIRST_YEAR + i);
  console.log(`LD-203 ${years[0]}–${thisYear}${process.env.LDA_API_KEY ? "" : " (no LDA_API_KEY: 15 requests a minute)"}`);

  // The filings with items we want, newest posting per filer and period.
  const filings = new Map<string, Filing>();
  const keep = (f: Filing) => {
    const key = filerKey(f);
    const prev = filings.get(key);
    if (!prev || prev.dt_posted < f.dt_posted) filings.set(key, f);
  };
  for (const year of years) for (const type of TYPES) for (const f of await yearType(year, type, thisYear)) keep(f);

  // Amendments since the last run can retract items: they replace by key even when empty of them.
  const state: { amendmentsSince?: string } = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
  const today = new Date().toISOString().slice(0, 10);
  if (state.amendmentsSince && state.amendmentsSince < today) {
    const amended = await amendmentsSince(state.amendmentsSince);
    let retracted = 0;
    for (const f of amended) {
      const key = filerKey(f);
      const prev = filings.get(key);
      if (prev && prev.dt_posted < f.dt_posted) {
        filings.set(key, f);
        retracted++;
      }
    }
    if (amended.length) console.log(`  ${amended.length} amendments since ${state.amendmentsSince}, ${retracted} replacing a kept report`);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify({ amendmentsSince: today }) + "\n");

  // Registrants to our organizations: exact normalized name, then the alias
  // file, then a similarity scan.
  // data/ld203-aliases.json: registrant name as filed -> our organization id, for the spellings the name match misses.
  const aliases: Record<string, string> = {};
  if (fs.existsSync(ALIASES_FILE)) {
    for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(ALIASES_FILE, "utf8")) as Record<string, string>)) {
      aliases[clean(k)] = v;
      aliases[clean(k).toUpperCase()] = v;
    }
  }
  const orgIds = new Set(organizations.map((o) => o.id));
  const orgByKey = new Map<string, string>();
  for (const o of organizations) {
    for (const n of [o.name, o.lobbying?.client]) {
      const k = n && normalizeOrg(n);
      if (k && !orgByKey.has(k)) orgByKey.set(k, o.id);
    }
  }
  const findOrg = (name: string): string | undefined => {
    const alias = aliases[clean(name)] ?? aliases[clean(name).toUpperCase()] ?? aliases[normalizeOrg(name)];
    if (alias) return orgIds.has(alias) ? alias : undefined;
    const exact = orgByKey.get(normalizeOrg(name));
    if (exact) return exact;
    return organizations.find((o) => sameOrg(o.name, name) || (!!o.lobbying?.client && sameOrg(o.lobbying.client, name)))?.id;
  };

  const bySurname = indexMembers(legislators);
  const speaker = legislators.find((l) => l.bioguide === "J000299")?.bioguide;
  const registrants: Record<number, Ld203Registrant> = {};
  const items: Ld203Item[] = [];
  let dropped = 0;
  let collapsed = 0;
  for (const f of filings.values()) {
    if (!registrants[f.registrant.id]) {
      registrants[f.registrant.id] = { id: f.registrant.id, name: clean(f.registrant.name), organization: findOrg(f.registrant.name) };
    }
    const comments = clean(f.comments) || undefined;
    // The same payment once per honoree: one item, the honorees joined.
    const seen = new Map<string, Ld203Item>();
    let n = 0;
    for (const it of f.contribution_items) {
      if (it.contribution_type === "feca") continue;
      const amount = Number(it.amount) || 0;
      if (amount <= 0) continue;
      const payee = clean(it.payee_name) || "Not stated";
      const pc = payeeClass(payee);
      // Reclassify by payee: inaugural and library gifts filed as honorary, and
      // honorary items paying a PAC or party, which are FECA rows in the wrong box.
      let type: Ld203Type = it.contribution_type;
      if (pc === "inaugural") type = "pic";
      else if (pc === "library") type = "ple";
      else if (pc === "pac" || pc === "party") {
        dropped++;
        continue;
      }
      const honoree = clean(it.honoree_name);
      const dupKey = `${payee}|${amount}|${it.date ?? ""}|${type}`;
      const prev = seen.get(dupKey);
      if (prev) {
        collapsed++;
        if (honoree && !prev.honoree.includes(honoree)) prev.honoree = `${prev.honoree}; ${honoree}`;
        continue;
      }
      const contributor = clean(it.contributor_name);
      const item: Ld203Item = {
        id: `${f.filing_uuid}:${n++}`,
        filing: f.filing_uuid,
        url: f.filing_document_url,
        year: f.filing_year,
        period: f.filing_period,
        posted: f.dt_posted.slice(0, 10),
        type,
        registrant: f.registrant.id,
        lobbyist: f.lobbyist ? clean(`${f.lobbyist.first_name} ${f.lobbyist.last_name}`) : undefined,
        contributor: contributor && !/^self$/i.test(contributor) ? contributor : undefined,
        payee,
        payeeClass: pc,
        honoree,
        honoreeClass: "other",
        match: "none",
        members: [],
        honorees: 1,
        amount,
        date: it.date ?? undefined,
        comments,
      };
      seen.set(dupKey, item);
      items.push(item);
    }
  }
  // Match honorees once the repeated rows are joined.
  for (const item of items) {
    item.honoreeClass = honoreeClass(item.honoree);
    item.honorees = countHonorees(item.honoree);
    if (item.type === "he" || item.type === "me") {
      const { match, members } = matchHonoree(item.honoree, bySurname, speaker);
      item.match = match;
      item.members = members;
      if (members.length > item.honorees) item.honorees = members.length;
    }
  }
  items.sort((a, b) => (b.date ?? b.posted).localeCompare(a.date ?? a.posted) || b.amount - a.amount);

  const total = items.reduce((s, i) => s + i.amount, 0);
  const matched = items.filter((i) => i.members.length);
  const onSite = Object.values(registrants).filter((r) => r.organization).length;
  console.log(
    `  ${requests} requests; ${filings.size} reports, ${items.length} items ($${(total / 1e6).toFixed(1)}M), ${dropped} PAC/party payees dropped, ${collapsed} repeated rows joined; ` +
      `${matched.length} items name a current member (${new Set(matched.flatMap((i) => i.members)).size} members); ${onSite} of ${Object.keys(registrants).length} registrants are organizations on the site`
  );
  const unmatched = Object.values(registrants).filter((r) => !r.organization);
  const big = new Map<number, number>();
  for (const i of items) big.set(i.registrant, (big.get(i.registrant) ?? 0) + i.amount);
  const top = unmatched.sort((a, b) => (big.get(b.id) ?? 0) - (big.get(a.id) ?? 0)).slice(0, 12);
  console.log(`  biggest filers without an organization page (add to ${ALIASES_FILE} if they have one): ${top.map((r) => `${r.name} ($${Math.round((big.get(r.id) ?? 0) / 1e3)}K)`).join("; ")}`);

  return { generatedAt: new Date().toISOString(), since: FIRST_YEAR, memberSince: MEMBER_SINCE, items, registrants };
}
