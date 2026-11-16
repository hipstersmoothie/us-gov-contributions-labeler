// Lobbyists' former government jobs, for data/revolving-door.json.
//
// LD-1 registrations and LD-2 reports list each lobbyist's "covered
// positions": jobs in Congress or the executive branch they held in the 20
// years before they started lobbying for that client. They're free text
// ("Chief of Staff, Rep. Jane Doe; Counsel, Senate Finance Committee"), so
// each one is split into jobs and searched for
//
//   members of Congress   a title or first name followed by a last name, matched against everyone
//                         who has served since 2003 so a staffer of a retired senator who shares a
//                         current member's last name isn't credited to the current one
//   committees            the committee's name or a common abbreviation, with "House" or "Senate"
//                         when both chambers have one
//
// and a match only counts when exactly one person or committee fits.
import fs from "fs";
import path from "path";
import { normalizeOrg, sameOrg, titleCase, fixCase } from "../lib/names.js";
import type { Legislator } from "../lib/legislators.js";
import type { CongressCommittee } from "./assignments.js";
import type { OrganizationRecord } from "./build.js";
import { congressFor, type Ld2 } from "./legislation.js";

const DIR = ".cache/revolving";
const LEGISLATORS = "https://unitedstates.github.io/congress-legislators";
const DAY = 24 * 60 * 60 * 1000;
/** Members who left before this are too long gone to be anyone's covered position. */
const SERVED_SINCE = "2003-01-01";

export interface RevolvingFile {
  generatedAt: string;
  congress: number;
  /** Quarters of filings read, e.g. "2025-first_quarter". */
  quarters: string[];
  stats: RevolvingStats;
  lobbyists: RevolvingLobbyist[];
}

export interface RevolvingStats {
  /** Lobbyists on a filing this Congress. */
  lobbyists: number;
  /** Of those, how many disclosed a covered position. */
  withPositions: number;
  /** Jobs that name a member of Congress, and how many of those resolved to exactly one person. */
  memberMentions: number;
  memberResolved: number;
  /** Of the resolved ones, how many are current members. */
  memberCurrent: number;
  committeeMentions: number;
  committeeResolved: number;
}

export interface RevolvingLobbyist {
  /** lda.gov lobbyist ids (one per registrant they've lobbied for). */
  ids: number[];
  name: string;
  /** Covered positions as disclosed, longest version of each. */
  positions: string[];
  /** Registrants that listed them: firms, or organizations lobbying for themselves. */
  firms: { id: number; name: string; organization?: string }[];
  clients: { name: string; organization?: string }[];
  /** Current members whose office they worked in. */
  members: { bioguide: string; job: string; chamber?: "house" | "senate" }[];
  /** Current committees they worked for. */
  committees: { id: string; job: string }[];
  /** Latest quarter they were on a filing, e.g. "2026 Q3". */
  latest: string;
}

// --- legislators, current and past ---------------------------------------------------------

interface Person {
  bioguide: string;
  last: string[];
  /** First, middle, nickname and official-name given names, plus common nicknames of each. */
  given: Set<string>;
  chambers: Set<"house" | "senate">;
  states: Set<string>;
  current: boolean;
}

async function cachedJson<T>(name: string): Promise<T> {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file) || Date.now() - fs.statSync(file).mtimeMs > 30 * DAY) {
    const res = await fetch(`${LEGISLATORS}/${name}`);
    if (!res.ok) throw new Error(`${res.status} from ${LEGISLATORS}/${name}`);
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(file, await res.text());
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Uppercase words, no accents or punctuation: "Sen. Ocasio-Cortez's" -> ["SEN", "OCASIO", "CORTEZ"]. */
export function words(s: string) {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[’‘`]/g, "'")
    .replace(/'s\b/gi, " ")
    .replace(/'/g, "")
    .replace(/&/g, " AND ")
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
}

/** words(), keeping commas, semicolons, colons, slashes and parentheses as "," tokens so a name can't
 *  run across them. */
function tokens(s: string) {
  return words(s.replace(/[,;:()\/\[\]]/g, " ZZBREAK ")).map((w) => (w === "ZZBREAK" ? "," : w));
}

const NICKNAMES: Record<string, string[]> = {
  ROBERT: ["BOB", "BOBBY", "ROB", "BOBBIE"], WILLIAM: ["BILL", "WILL", "BILLY"], RICHARD: ["DICK", "RICH", "RICK"],
  JAMES: ["JIM", "JIMMY", "JAMIE"], THOMAS: ["TOM", "TOMMY"], MICHAEL: ["MIKE"], CHARLES: ["CHUCK", "CHARLIE"],
  EDWARD: ["ED", "TED", "EDDIE"], THEODORE: ["TED"], PATRICK: ["PAT"], PATRICIA: ["PATTY", "PAT", "PATSY"],
  DANIEL: ["DAN", "DANNY"], DONALD: ["DON"], DAVID: ["DAVE"], JOSEPH: ["JOE"], JOHN: ["JACK"], KENNETH: ["KEN"],
  STEVEN: ["STEVE"], STEPHEN: ["STEVE"], ANTHONY: ["TONY"], CHRISTOPHER: ["CHRIS"], ELIZABETH: ["LIZ", "BETH", "BETSY"],
  KATHERINE: ["KATE", "KATIE", "KATHY"], CATHERINE: ["CATHY", "KATE"], DEBORAH: ["DEBBIE", "DEB"],
  GERALD: ["JERRY"], GERALDINE: ["GERRY"], RAYMOND: ["RAY"], RONALD: ["RON"], TIMOTHY: ["TIM"], NICHOLAS: ["NICK"],
  ALEXANDER: ["ALEX"], ALEXANDRIA: ["ALEX"], BENJAMIN: ["BEN"], SAMUEL: ["SAM"], ZACHARY: ["ZACH"], GREGORY: ["GREG"],
  JEFFREY: ["JEFF"], JEFFERY: ["JEFF"], MATTHEW: ["MATT"], ANDREW: ["ANDY", "DREW"], DOUGLAS: ["DOUG"],
  FREDERICK: ["FRED"], ALBERT: ["AL"], ALAN: ["AL"], ALLEN: ["AL"], LAWRENCE: ["LARRY"], EUGENE: ["GENE"],
  LEONARD: ["LEN", "LENNY"], MITCHELL: ["MITCH"], PETER: ["PETE"], PHILIP: ["PHIL"], PHILLIP: ["PHIL"],
  RANDALL: ["RANDY"], RANDOLPH: ["RANDY"], SUSAN: ["SUE"], THADDEUS: ["THAD"], VINCENT: ["VINCE"], WALTER: ["WALT"],
  MARGARET: ["MAGGIE", "PEGGY"], JOSHUA: ["JOSH"], JONATHAN: ["JON"], NATHANIEL: ["NATE"], NATHAN: ["NATE"],
  FRANCIS: ["FRANK"], FRANKLIN: ["FRANK"], HERBERT: ["HERB"], GARRET: ["GARY"], CYNTHIA: ["CINDY"], TERENCE: ["TERRY"],
  TERRENCE: ["TERRY"], ABIGAIL: ["ABBY"], CHRISTINE: ["CHRIS"], KIMBERLY: ["KIM"], DEBRA: ["DEB"],
  REBECCA: ["BECKY"], BERNARD: ["BERNIE"],
};
const NICK_OF = new Map<string, Set<string>>();
for (const [name, nicks] of Object.entries(NICKNAMES)) {
  for (const n of [name, ...nicks]) {
    const set = NICK_OF.get(n) ?? new Set();
    set.add(name);
    nicks.forEach((x) => set.add(x));
    NICK_OF.set(n, set);
  }
}

function givenNames(...names: (string | undefined)[]) {
  const out = new Set<string>();
  for (const n of names) {
    for (const w of words(n ?? "")) {
      if (w.length < 2) continue;
      out.add(w);
      NICK_OF.get(w)?.forEach((x) => out.add(x));
    }
  }
  return out;
}

async function people(current: Legislator[]): Promise<Person[]> {
  type Raw = {
    id: { bioguide: string };
    name: { first: string; last: string; middle?: string; nickname?: string; official_full?: string };
    terms: { type: "rep" | "sen"; start: string; end: string; state: string }[];
  };
  const [cur, hist] = await Promise.all([
    cachedJson<Raw[]>("legislators-current.json"),
    cachedJson<Raw[]>("legislators-historical.json"),
  ]);
  const isCurrent = new Set(current.map((l) => l.bioguide));
  return [...cur, ...hist]
    .filter((p) => p.terms.some((t) => t.end >= SERVED_SINCE))
    .map((p) => {
      const official = words(p.name.official_full ?? "");
      const last = words(p.name.last);
      return {
        bioguide: p.id.bioguide,
        last,
        given: givenNames(p.name.first, p.name.middle, p.name.nickname, official.slice(0, Math.max(0, official.length - last.length)).join(" ")),
        chambers: new Set(p.terms.map((t) => (t.type === "sen" ? "senate" : "house") as "house" | "senate")),
        states: new Set(p.terms.map((t) => t.state)),
        current: isCurrent.has(p.id.bioguide),
      };
    });
}

// --- finding members in a job description -----------------------------------------------

const HOUSE_TITLES = new Set([
  "REP", "REPS", "REPRESENTATIVE", "REPRESENTATIVES", "CONGRESSMAN", "CONGRESSWOMAN", "CONGRESSMEMBER", "CONGRESSPERSON",
  "CONG", "CONGW", "DELEGATE",
]);
const SENATE_TITLES = new Set(["SEN", "SENS", "SENATOR", "SENATORS"]);
const OTHER_TITLES = new Set(["SPEAKER", "LEADER", "WHIP", "CHAIRMAN", "CHAIRWOMAN", "CHAIR", "HON", "HONORABLE", "LEADERS", "MR", "MRS", "MS"]);
const STATES = new Set(
  ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC " +
    "SD TN TX UT VT VA WA WV WI WY DC PR GU VI AS MP").split(" ")
);

/** Words that can follow a member's name ("Sen. Smith and Sen. Jones", "Rep. Doe office"). */
const ENDS_NAME = new Set([
  ",", "AND", "OFFICE", "OFFICES", "STAFF", "FROM", "IN", "ON", "AT", "OF", "TO", "FOR", "WHERE", "DISTRICT", "PERSONAL",
  "WHILE", "UNTIL", "THROUGH", "SINCE", "AS", "R", "D", "I", "REP", "REPS", "SEN", "SENATOR", "CONGRESSMAN",
  "CONGRESSWOMAN", "REPRESENTATIVE", "SR", "JR", "II", "III", "IV", "LEGISLATIVE", "CHIEF", "COUNSEL", "SENIOR",
  "DEPUTY", "SCHEDULER", "INTERN", "FELLOW", "AIDE", "ASSISTANT", "DIRECTOR", "PRESS", "COMMUNICATIONS", "POLICY",
  "LD", "LA", "LC", "COS", "DCOS", "SA", "OR", "WITH", "BEFORE", "AFTER", "DURING", "THEN", "ALSO", "FORMER",
  "MAJORITY", "MINORITY", "REPUBLICAN", "DEMOCRATIC", "DEMOCRAT", "PROFESSIONAL", "SPECIAL", "STAFFER", "EMPLOYEE",
]);

export interface Mention {
  bioguide?: string;
  /** Everyone who fit, when it wasn't exactly one. */
  candidates: string[];
  chamber?: "house" | "senate";
  /** Token span of the given names and last name. */
  start: number;
  end: number;
  given: boolean;
}

export function memberMatcher(all: Person[]) {
  const byLastHead = new Map<string, Person[]>();
  for (const p of all) {
    if (!p.last.length) continue;
    byLastHead.set(p.last[0]!, [...(byLastHead.get(p.last[0]!) ?? []), p]);
  }

  return function mentions(text: string): Mention[] {
    const t = tokens(text);
    const found: Mention[] = [];
    for (let j = 0; j < t.length; j++) {
      const heads = byLastHead.get(t[j]!);
      if (!heads) continue;
      // Each distinct last name starting here.
      const lasts = new Map<string, Person[]>();
      for (const p of heads) {
        if (p.last.every((w, k) => t[j + k] === w)) lasts.set(p.last.join(" "), [...(lasts.get(p.last.join(" ")) ?? []), p]);
      }
      for (const [lastName, withLast] of lasts) {
        const len = lastName.split(" ").length;
        // Walk back over given names and initials to a title, if any.
        let k = j - 1;
        const given: string[] = [];
        while (k >= 0 && j - k <= 3 && !HOUSE_TITLES.has(t[k]!) && !SENATE_TITLES.has(t[k]!) && !OTHER_TITLES.has(t[k]!)) {
          if (t[k]!.length === 1 || withLast.some((p) => p.given.has(t[k]!))) given.unshift(t[k]!);
          else break;
          k--;
        }
        const title = k >= 0 ? t[k]! : "";
        const chamber = HOUSE_TITLES.has(title) ? "house" : SENATE_TITLES.has(title) ? "senate" : undefined;
        const titled = !!chamber || OTHER_TITLES.has(title);
        const named = given.some((g) => g.length > 1);
        // A bare last name is too weak, and so is an initial without a title.
        if (!titled && !named) continue;
        // "Rep. Dean Gallo" is Rep. Gallo: with only a title, the name has to end there.
        const next = t[j + len];
        if (!named && next && !ENDS_NAME.has(next) && !STATES.has(next) && !/^\d/.test(next)) continue;
        // "(R-TX)" or "R-Texas" just after the name.
        const after = t.slice(j + len, j + len + 3);
        const state = after.find((w) => STATES.has(w) && w !== "IN" && w !== "OR" && w !== "ME");

        let fits = withLast.filter(
          (p) =>
            (!chamber || p.chambers.has(chamber)) &&
            given.every((g) => (g.length === 1 ? [...p.given].some((x) => x[0] === g) : p.given.has(g)))
        );
        if (fits.length > 1 && state) {
          const inState = fits.filter((p) => p.states.has(state));
          if (inState.length) fits = inState;
        }
        if (!fits.length) continue;
        found.push({
          bioguide: fits.length === 1 ? fits[0]!.bioguide : undefined,
          candidates: fits.map((p) => p.bioguide),
          chamber,
          start: j - given.length,
          end: j + len,
          given: named,
        });
      }
    }
    // "Rep. Scott Peters": SCOTT is Peters's first name, not another member's last name.
    return found.filter((m) => !found.some((o) => o !== m && o.given && o.start <= m.start && m.end <= o.end - 1));
  };
}

// --- finding committees ---------------------------------------------------------------------

type CommitteeRule = { re: RegExp; house?: string; senate?: string; joint?: string };
// Patterns run on words(job).join(" ").
const COMMITTEE_RULES: CommitteeRule[] = [
  { re: /\bWAYS AND MEANS\b|\bW AND M\b/, house: "HSWM" },
  { re: /\bENERGY AND COMMERCE\b|\bE AND C\b/, house: "HSIF" },
  { re: /\bENERGY AND NATURAL RESOURCES\b|\bSENATE ENERGY\b|\bENR COMMITTEE\b/, senate: "SSEG" },
  { re: /\b(?<!ENERGY AND )NATURAL RESOURCES (COMMITTEE|CMTE|COMM)\b|\bCOMMITTEE ON NATURAL RESOURCES\b|\bHOUSE (NATURAL )?RESOURCES\b|\bHNRC\b/, house: "HSII" },
  { re: /\bFINANCE COMMITTEE\b|\bCOMMITTEE ON FINANCE\b|\bSENATE FINANCE\b|\bSFC\b/, senate: "SSFI" },
  { re: /\bFINANCIAL SERVICES (COMMITTEE|CMTE|COMM)\b|\bCOMMITTEE ON FINANCIAL SERVICES\b|\bHOUSE FINANCIAL SERVICES\b(?! AND GENERAL)|\bHFSC\b/, house: "HSBA" },
  { re: /\bBANKING (HOUSING AND URBAN AFFAIRS|COMMITTEE|CMTE|COMM)\b|\bCOMMITTEE ON BANKING\b|\bSENATE BANKING\b/, senate: "SSBK" },
  { re: /\bHEALTH EDUCATION LABOR\b|\bHELP COMMITTEE\b|\bSENATE HELP\b|\bHELP CMTE\b/, senate: "SSHR" },
  { re: /\bEDUCATION AND (THE )?(WORKFORCE|LABOR)\b|\bED AND (THE )?(WORKFORCE|LABOR)\b/, house: "HSED" },
  { re: /\bFOREIGN AFFAIRS (COMMITTEE|CMTE|COMM)\b|\bCOMMITTEE ON FOREIGN AFFAIRS\b|\bHOUSE FOREIGN AFFAIRS\b|\bHFAC\b|\bHOUSE INTERNATIONAL RELATIONS\b/, house: "HSFA" },
  { re: /\bFOREIGN RELATIONS (COMMITTEE|CMTE|COMM)\b|\bCOMMITTEE ON FOREIGN RELATIONS\b|\bSENATE FOREIGN RELATIONS\b|\bSFRC\b/, senate: "SSFR" },
  { re: /\bOVERSIGHT AND (GOVERNMENT )?(REFORM|ACCOUNTABILITY)\b|\bGOVERNMENT REFORM\b|\bHOUSE OVERSIGHT\b|\bOVERSIGHT COMMITTEE\b|\bHOGR\b/, house: "HSGO" },
  { re: /\bHOUSE ADMINISTRATION\b|\bCOMMITTEE ON HOUSE ADMIN\b/, house: "HSHA" },
  { re: /\bHOMELAND SECURITY AND GOVERNMENTAL AFFAIRS\b|\bHSGAC\b|\bGOVERNMENTAL AFFAIRS (COMMITTEE|CMTE|COMM)\b|\bSENATE GOVERNMENTAL AFFAIRS\b/, senate: "SSGA" },
  { re: /\bHOMELAND SECURITY (COMMITTEE|CMTE|COMM)\b|\bCOMMITTEE ON HOMELAND SECURITY\b/, house: "HSHM", senate: "SSGA" },
  { re: /\bHPSCI\b|\bPERMANENT SELECT COMMITTEE ON INTELLIGENCE\b|\bHOUSE INTELLIGENCE\b/, house: "HLIG" },
  { re: /\bSSCI\b|\bSENATE (SELECT COMMITTEE ON )?INTELLIGENCE\b/, senate: "SLIN" },
  { re: /\bINTELLIGENCE (COMMITTEE|CMTE)\b|\bSELECT COMMITTEE ON INTELLIGENCE\b/, house: "HLIG", senate: "SLIN" },
  { re: /\bTRANS(PORTATION)? AND INFRA(STRUCTURE)?\b|\bT AND I\b/, house: "HSPW" },
  { re: /\bCOMMERCE SCIENCE AND TRANSPORTATION\b|\bSENATE COMMERCE\b/, senate: "SSCM" },
  { re: /\bCOMMERCE (COMMITTEE|CMTE)\b|\bCOMMITTEE ON COMMERCE\b/, house: "HSIF", senate: "SSCM" },
  { re: /\bENVIRONMENT AND PUBLIC WORKS\b|\bEPW\b/, senate: "SSEV" },
  { re: /\bRULES AND ADMINISTRATION\b/, senate: "SSRA" },
  { re: /\bRULES (COMMITTEE|CMTE|COMM)\b|\bCOMMITTEE ON RULES\b/, house: "HSRU", senate: "SSRA" },
  { re: /\bSMALL BUSINESS AND ENTREPRENEURSHIP\b/, senate: "SSSB" },
  { re: /\bSMALL BUSINESS (COMMITTEE|CMTE|COMM)\b|\bCOMMITTEE ON SMALL BUSINESS\b/, house: "HSSM", senate: "SSSB" },
  { re: /\bETHICS (COMMITTEE|CMTE|COMM)\b|\bCOMMITTEE ON ETHICS\b|\bSTANDARDS OF OFFICIAL CONDUCT\b/, house: "HSSO", senate: "SLET" },
  { re: /\bSCIENCE SPACE AND TECHNOLOGY\b|\bSCIENCE (AND TECHNOLOGY )?(COMMITTEE|CMTE)\b|\bHOUSE SCIENCE\b/, house: "HSSY" },
  { re: /\bVETERANS AFFAIRS (COMMITTEE|CMTE|COMM)\b|\bCOMMITTEE ON VETERANS AFFAIRS\b|\b(HOUSE|SENATE) VETERANS\b|\bSVAC\b/, house: "HSVR", senate: "SSVA" },
  { re: /\bINDIAN AFFAIRS (COMMITTEE|CMTE|COMM)\b|\bCOMMITTEE ON INDIAN AFFAIRS\b|\bSENATE INDIAN AFFAIRS\b/, senate: "SLIA" },
  { re: /\bAGING (COMMITTEE|CMTE|COMM)\b|\bCOMMITTEE ON AGING\b|\bSENATE AGING\b/, senate: "SPAG" },
  { re: /\bAGRICULTURE NUTRITION AND FORESTRY\b/, senate: "SSAF" },
  { re: /\bAGRICULTURE (COMMITTEE|CMTE|COMM)\b|\bCOMMITTEE ON AGRICULTURE\b|\b(HOUSE|SENATE) AG(RICULTURE)?\b/, house: "HSAG", senate: "SSAF" },
  { re: /\bAPPROPRIATIONS\b|\bAPPROPS\b/, house: "HSAP", senate: "SSAP" },
  { re: /\bARMED SERVICES\b/, house: "HSAS", senate: "SSAS" },
  { re: /\bHASC\b/, house: "HSAS" },
  { re: /\bSASC\b/, senate: "SSAS" },
  { re: /\bJUDICIARY\b/, house: "HSJU", senate: "SSJU" },
  { re: /\bSJC\b/, senate: "SSJU" },
  { re: /\bHJC\b/, house: "HSJU" },
  { re: /\bBUDGET (COMMITTEE|CMTE|COMM)\b|\bCOMMITTEE ON (THE )?BUDGET\b|\b(HOUSE|SENATE) BUDGET\b/, house: "HSBU", senate: "SSBU" },
  { re: /\bJOINT ECONOMIC\b|\bJEC\b/, joint: "JSEC" },
  { re: /\bJOINT COMMITTEE ON TAXATION\b|\bJOINT TAX\b|\bJCT\b/, joint: "JSTX" },
  { re: /\bSELECT COMMITTEE ON (THE )?(CCP|CHINA|CHINESE COMMUNIST PARTY|STRATEGIC COMPETITION)\b|\bCHINA (SELECT )?COMMITTEE\b/, house: "HSZS" },
  { re: /\bHELSINKI COMMISSION\b|\bSECURITY AND COOPERATION IN EUROPE\b/, joint: "JCSE" },
];
/** "House" or "Senate" for a committee both chambers have: the word just before its name, else the
 *  only chamber the job mentions, else the nearest one before it. */
function chamberOf(s: string, at: number): "house" | "senate" | undefined {
  const prev = s.slice(0, at).trim().split(" ").at(-1);
  if (prev && /^(SENATE|SEN|S)$/.test(prev)) return "senate";
  if (prev && /^(HOUSE|H)$/.test(prev)) return "house";
  const house = [...s.matchAll(/\bHOUSE\b/g)].map((m) => m.index!);
  const senate = [...s.matchAll(/\bSENATE\b/g)].map((m) => m.index!);
  if (!house.length && !senate.length) return undefined;
  if (!senate.length) return "house";
  if (!house.length) return "senate";
  const h = Math.max(-1, ...house.filter((i) => i < at));
  const sn = Math.max(-1, ...senate.filter((i) => i < at));
  if (h < 0 && sn < 0) return undefined;
  return h > sn ? "house" : "senate";
}

/** Committees a job names, by id; `ambiguous` counts names that fit both chambers with nothing to choose between them. */
export function committeeMentions(job: string) {
  const s = words(job).join(" ");
  const ids = new Set<string>();
  let ambiguous = 0;
  let mentions = 0;
  const taken: [number, number][] = [];
  for (const rule of COMMITTEE_RULES) {
    for (const m of s.matchAll(new RegExp(rule.re.source, "g"))) {
      const at = m.index!;
      // A longer name already matched here ("Energy and Natural Resources" before "Natural Resources").
      if (taken.some(([a, b]) => at < b && at + m[0].length > a)) continue;
      // A member's own staff: "Appropriations Associate", "Liaison to Senate Budget Committee".
      if (/^ ASSOCIATE\b/.test(s.slice(at + m[0].length)) || /\bLIAISON TO( THE)?( HOUSE| SENATE)? $/.test(s.slice(0, at))) continue;
      taken.push([at, at + m[0].length]);
      mentions++;
      if (rule.joint) {
        ids.add(rule.joint);
        continue;
      }
      if (rule.house && !rule.senate) {
        ids.add(rule.house);
        continue;
      }
      if (rule.senate && !rule.house) {
        ids.add(rule.senate);
        continue;
      }
      const chamber = chamberOf(s, at);
      if (!chamber) ambiguous++;
      else ids.add(chamber === "house" ? rule.house! : rule.senate!);
    }
  }
  return { ids: [...ids], mentions, ambiguous };
}

// --- splitting positions into jobs ---------------------------------------------------------

/** "Chief of Staff, Rep. Doe; Counsel, Senate Finance" -> two jobs. */
export function jobs(position: string) {
  return position
    .split(/\s*(?:;|\n|\||•|\s\/\s|\s-\s(?=[A-Z][a-z]))\s*/)
    .map((j) => j.replace(/^(and|former|fmr\.?)\s+/i, "").replace(/[\s,.;]+$/, "").trim())
    .filter((j) => j.length > 2);
}

// --- ingest -----------------------------------------------------------------------------------

const PERIOD: Record<string, string> = { first_quarter: "Q1", second_quarter: "Q2", third_quarter: "Q3", fourth_quarter: "Q4", mid_year: "Q2", year_end: "Q4" };

const displayName = (s: string) => {
  const n = s.replace(/\s+/g, " ").trim();
  return /[a-z]/.test(n) ? n : fixCase(titleCase(n));
};

export async function ingestRevolving(
  legislators: Legislator[],
  committees: CongressCommittee[],
  organizations: OrganizationRecord[],
  filings: Ld2[]
): Promise<RevolvingFile> {
  const { congress } = congressFor();
  console.log(`Revolving door: ${filings.length.toLocaleString()} filings`);
  const all = await people(legislators);
  const mentionsIn = memberMatcher(all);
  const isCurrent = new Set(legislators.map((l) => l.bioguide));
  const committeeIds = new Set(committees.map((c) => c.id));

  // Clients and registrants -> our organizations, as in the legislation step (sameOrg), with the
  // organizations indexed by word so each name is only compared with ones it shares a word with.
  const orgs = organizations.filter((o) => o.lobbying);
  const byClient = new Map(orgs.map((o) => [normalizeOrg(o.lobbying!.client), o.id]));
  const byWord = new Map<string, typeof orgs>();
  for (const o of orgs) for (const w of new Set(normalizeOrg(o.lobbying!.client).split(" "))) byWord.set(w, [...(byWord.get(w) ?? []), o]);
  const matchedOrg = new Map<string, string | undefined>();
  const orgFor = (name: string) => {
    const key = normalizeOrg(name);
    if (!matchedOrg.has(key)) {
      const nearby = new Set(key.split(" ").flatMap((w) => byWord.get(w) ?? []));
      matchedOrg.set(key, byClient.get(key) ?? [...nearby].find((o) => sameOrg(o.lobbying!.client, name))?.id);
    }
    return matchedOrg.get(key);
  };

  // Every lobbyist on a filing this Congress, by lda.gov id.
  type Acc = {
    id: number;
    name: string;
    positions: Map<string, string>;
    firms: Map<number, string>;
    clients: Map<string, string>;
    latest: string;
  };
  const byId = new Map<number, Acc>();
  for (const f of filings) {
    const quarter = `${f.year} ${PERIOD[f.period] ?? f.period}`;
    for (const l of f.lobbyists ?? []) {
      const a =
        byId.get(l.id) ??
        byId
          .set(l.id, {
            id: l.id,
            name: [l.first, l.last, l.suffix].filter(Boolean).join(" "),
            positions: new Map(),
            firms: new Map(),
            clients: new Map(),
            latest: quarter,
          })
          .get(l.id)!;
      if (l.position && !/^(n\/?a|none|no|-+)$/i.test(l.position)) {
        const key = words(l.position).join(" ");
        if ((a.positions.get(key)?.length ?? 0) < l.position.length) a.positions.set(key, l.position);
      }
      a.firms.set(f.registrant.id, f.registrant.name);
      a.clients.set(normalizeOrg(f.client.name) || f.client.name, f.client.name);
      if (quarter > a.latest) a.latest = quarter;
    }
  }

  const stats: RevolvingStats = {
    lobbyists: byId.size,
    withPositions: 0,
    memberMentions: 0,
    memberResolved: 0,
    memberCurrent: 0,
    committeeMentions: 0,
    committeeResolved: 0,
  };

  // Same person at two firms has two ids; merge when the name and a position agree.
  const merged = new Map<string, RevolvingLobbyist>();
  for (const a of byId.values()) {
    if (!a.positions.size) continue;
    stats.withPositions++;
    const positions = [...a.positions.values()];
    const members = new Map<string, { job: string[]; chamber?: "house" | "senate" }>();
    const comms = new Map<string, string[]>();
    // Each job once, however often it was repeated across filings, in whatever order and with
    // whichever dates: "Legislative Director, Senator Doe (2013-2025)", "Senator Doe, Legislative Director".
    const seen = new Set<string>();
    const distinct = positions.flatMap(jobs).filter((j) => {
      const key = [...new Set(words(j).filter((w) => !/\d/.test(w)))].sort().join(" ");
      return !seen.has(key) && !!seen.add(key);
    });
    for (const job of distinct) {
      const ms = mentionsIn(job);
      for (const m of ms) {
        stats.memberMentions++;
        if (!m.bioguide) continue;
        stats.memberResolved++;
        if (!isCurrent.has(m.bioguide)) continue;
        stats.memberCurrent++;
        const e = members.get(m.bioguide) ?? { job: [] };
        if (!e.job.includes(job)) e.job.push(job);
        e.chamber ??= m.chamber;
        members.set(m.bioguide, e);
      }
      const c = committeeMentions(job);
      stats.committeeMentions += c.mentions;
      stats.committeeResolved += c.ids.length;
      for (const id of c.ids) {
        if (!committeeIds.has(id)) continue;
        const list = comms.get(id) ?? [];
        if (!list.includes(job)) list.push(job);
        comms.set(id, list);
      }
    }

    const name = displayName(a.name);
    const key = `${words(name).join(" ")}|${[...a.positions.keys()].sort()[0]}`;
    const prev = merged.get(key);
    const firms = [...a.firms].map(([id, n]) => ({ id, name: displayName(n), ...(orgFor(n) ? { organization: orgFor(n) } : {}) }));
    const clients = [...a.clients.values()].map((n) => ({ name: displayName(n), ...(orgFor(n) ? { organization: orgFor(n) } : {}) }));
    const record: RevolvingLobbyist = prev ?? {
      ids: [],
      name,
      positions: [],
      firms: [],
      clients: [],
      members: [],
      committees: [],
      latest: a.latest,
    };
    record.ids.push(a.id);
    for (const p of positions) if (!record.positions.includes(p)) record.positions.push(p);
    for (const f of firms) if (!record.firms.some((x) => x.id === f.id)) record.firms.push(f);
    for (const c of clients) if (!record.clients.some((x) => normalizeOrg(x.name) === normalizeOrg(c.name))) record.clients.push(c);
    for (const [bioguide, e] of members) {
      if (!record.members.some((x) => x.bioguide === bioguide)) {
        record.members.push({ bioguide, job: e.job.join("; "), ...(e.chamber ? { chamber: e.chamber } : {}) });
      }
    }
    for (const [id, js] of comms) if (!record.committees.some((x) => x.id === id)) record.committees.push({ id, job: js.join("; ") });
    if (a.latest > record.latest) record.latest = a.latest;
    merged.set(key, record);
  }

  const lobbyists = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const l of lobbyists) l.clients.sort((a, b) => a.name.localeCompare(b.name));
  console.log(
    `  ${stats.lobbyists.toLocaleString()} lobbyists, ${stats.withPositions.toLocaleString()} with covered positions; ` +
      `${stats.memberResolved.toLocaleString()}/${stats.memberMentions.toLocaleString()} member mentions resolved ` +
      `(${stats.memberCurrent.toLocaleString()} current), ` +
      `${lobbyists.filter((l) => l.members.length).length.toLocaleString()} lobbyists linked to current members, ` +
      `${lobbyists.filter((l) => l.committees.length).length.toLocaleString()} to committees`
  );
  return {
    generatedAt: new Date().toISOString(),
    congress,
    quarters: [...new Set(filings.map((f) => `${f.year}-${f.period}`))].sort(),
    stats,
    lobbyists,
  };
}
