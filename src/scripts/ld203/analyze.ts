// Measure what's in the LD-203 honorary, meeting, library and inaugural items
// pulled by fetch.ts: totals by year and type, honorees matched to current
// members, payees, filers, overlap with the site's organizations, data quality.
// Writes .cache/ld203/summary.json and prints the tables for the README.
//
//   tsx src/scripts/ld203/analyze.ts
import fs from "fs";
import { looksLikePac, normalizeOrg, sameOrg } from "../../lib/names.js";
import {
  CACHE, TYPES, TYPE_NAMES, dedupeAmendments, loadFilings, money, usd,
  type ContributionItem, type ContributionReport, type ItemType,
} from "./common.js";

interface Member { bioguide: string; name: string; chamber: string; state: string; party: string }
interface Organization { id: string; name: string; lobbying?: { client: string } | null }
const members: Member[] = JSON.parse(fs.readFileSync("data/members.json", "utf8")).members;
const organizations: Organization[] = JSON.parse(fs.readFileSync("data/organizations.json", "utf8")).organizations;
const counts: Record<string, number> = JSON.parse(fs.readFileSync(`${CACHE}/counts.json`, "utf8"));

// ---- Members index -------------------------------------------------------

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
  JACQUELINE: ["JACKIE"], ABRAHAM: ["ABE"], NANCY: ["NAN"], TAMARA: ["TAMMY"], ANGUS: [], SHELDON: [], RAFAEL: ["TED"],
};
const SUFFIX = /^(JR|SR|II|III|IV)$/;
const PARTICLE = /^(VAN|DE|LA|DEL|VON|DI|DA|ST|MC)$/;
const words = (s: string) =>
  s.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^A-Z ]/g, " ").split(/\s+/).filter(Boolean);

interface MemberKey extends Member { last: string[]; firsts: Set<string> }
const index: MemberKey[] = members.map((m) => {
  const nick = m.name.match(/"([^"]+)"/)?.[1];
  const w = words(m.name.replace(/"[^"]+"/, "")).filter((t) => !SUFFIX.test(t));
  const last = PARTICLE.test(w[w.length - 2] ?? "") ? w.slice(-2) : w.slice(-1);
  const given = w.slice(0, w.length - last.length).filter((t) => t.length > 1);
  const firsts = new Set<string>([...given, ...(nick ? words(nick) : [])]);
  for (const g of [...firsts]) for (const n of NICKNAMES[g] ?? []) firsts.add(n);
  for (const [full, nicks] of Object.entries(NICKNAMES)) if (nicks.some((n) => firsts.has(n))) firsts.add(full);
  return { ...m, last, firsts };
});
const bySurname = new Map<string, MemberKey[]>();
for (const m of index) bySurname.set(m.last.join(" "), [...(bySurname.get(m.last.join(" ")) ?? []), m]);

const HONORIFIC =
  /\b(the\s+)?(honorable|hon|senators?|sens?|representatives?|reps?|congress(man|woman|member|men|women|members)|u\.?s\.?|speaker|leaders?|majority|minority|whip|chairman|chairwoman|chair|ranking member|dr|mr|mrs|ms|house|senate|of|and|for|member)\b\.?/gi;

type MatchKind = "full" | "surname" | "ambiguous" | "none";
interface HonoreeMatch { kind: MatchKind; members: MemberKey[]; multi: boolean; cls: string }

/** Who an honoree string names, among current members. */
function matchHonoree(raw: string | null): HonoreeMatch {
  const text = (raw ?? "").trim();
  const lower = text.toLowerCase();
  let cls = "other";
  if (!text || /^(n\/?a|none|-|\.|0|na|not applicable|see comments?)$/i.test(text)) cls = "blank";
  else if (/\b(caucus|foundation|institute|members? of congress|various|multiple|several|delegation|committee|conference|all members|freshm[ae]n|class of)\b/i.test(lower)) cls = "group";
  else if (/\b(president|vice president|governor|mayor|secretary|administrator|ambassador|justice|judge|general|admiral|commissioner|director|trump|vance|biden|harris, kamala|first lady)\b/i.test(lower) && !/\b(sen|rep|congress)/i.test(lower)) cls = "executive";
  else if (/\b(sen|rep|congress|speaker|whip|leader|hon)/i.test(lower)) cls = "official";

  const cleaned = text.replace(/\([^)]*\)/g, " ").replace(/\b[DRI]-[A-Z]{2}\b/g, " ").replace(HONORIFIC, " ");
  const w = words(cleaned);
  const multi = /,|\band\b|&|\/|;/i.test(cleaned.replace(/,\s*(jr|sr|ii|iii|iv)\b\.?/gi, "")) && w.length > 3;
  // "Sen.", "Rep.", "Speaker"… somewhere in the text. Without one, a surname
  // alone ("Collins, Doug", "James David Vance") isn't evidence of a member.
  const honorific = /\b(sen|senator|senators|rep|reps|representative|representatives|congress\w*|speaker|whip|leader|hon|honorable)\b/i.test(text);
  const hits = new Map<string, { m: MemberKey; full: boolean }>();
  for (const [surname, ms] of bySurname) {
    const sw = surname.split(" ");
    const positions: number[] = [];
    for (let i = 0; i + sw.length <= w.length; i++) if (sw.every((t, j) => w[i + j] === t)) positions.push(i);
    if (!positions.length) continue;
    // "John F. Kennedy Center", "McConnell Center", "Dole Foundation": an institution, not the person.
    const usable = positions.filter((i) => !ORG_AFTER.has(w[i + sw.length] ?? "") && !ORG_BEFORE.has(w[i - 1] ?? ""));
    if (!usable.length) continue;
    // A first name right next to the surname: "Mitch McConnell", "Rep. Chuck Fleischmann", "McConnell, Mitch".
    const near = (m: MemberKey) =>
      usable.some((i) => [i - 3, i - 2, i - 1, i + sw.length, i + sw.length + 1].some((k) => k >= 0 && k < w.length && m.firsts.has(w[k]!)));
    const full = ms.filter(near);
    if (full.length) for (const m of full) hits.set(m.bioguide, { m, full: true });
    else if (surname === "JOHNSON" && /speaker/i.test(text)) hits.set("J000299", { m: ms.find((m) => m.bioguide === "J000299")!, full: true });
    else if (!honorific) continue;
    else for (const m of ms) hits.set(m.bioguide, { m, full: false }); // surname only; unique or shared
  }
  const all = [...hits.values()];
  if (!all.length) return { kind: "none", members: [], multi, cls };
  const fulls = all.filter((h) => h.full).map((h) => h.m);
  if (fulls.length) return { kind: "full", members: fulls, multi: multi || fulls.length > 1, cls };
  const surnames = new Set(all.map((h) => h.m.last.join(" ")));
  if (all.length === surnames.size) return { kind: "surname", members: all.map((h) => h.m), multi: multi || all.length > 1, cls };
  return { kind: "ambiguous", members: all.map((h) => h.m), multi, cls };
}
/** "Department of Justice", "Secretary of War": a title, not a person. */
const ORG_BEFORE = new Set("OF DEPARTMENT DEPT".split(" "));
const ORG_AFTER = new Set("CENTER CENTRE FOUNDATION INSTITUTE LIBRARY AWARD AWARDS SCHOLARSHIP SCHOOL PRIZE BUILDING HALL SOCIETY MEMORIAL FELLOWSHIP GALA DINNER CLASSIC ARCHIVES LECTURE LECTURES MUSEUM FUND PAC".split(" "));

// ---- Payee classes -------------------------------------------------------

function payeeClass(name: string | null) {
  const n = (name ?? "").toUpperCase();
  if (!n || /^(N\/?A|NONE|-)$/.test(n)) return "blank";
  if (/INAUGUR/.test(n)) return "inaugural committee";
  if (/LIBRARY|PRESIDENTIAL CENTER/.test(n)) return "presidential library";
  if (/\b(NRCC|DCCC|DSCC|NRSC|RNC|DNC)\b|REPUBLICAN (NATIONAL|SENATORIAL|CONGRESSIONAL|PARTY)|DEMOCRATIC (NATIONAL|SENATORIAL|CONGRESSIONAL|PARTY)|(REPUBLICAN|DEMOCRATIC) (GOVERNORS|ATTORNEYS|STATE)|STATE (REPUBLICAN|DEMOCRATIC) PARTY/.test(n)) return "party committee";
  if (looksLikePac(n) || /\bFOR (CONGRESS|SENATE|US SENATE|U S SENATE|AMERICA|GOVERNOR|PRESIDENT|THE PEOPLE|VIRGINIA|TEXAS|OHIO|FLORIDA|IOWA|NEVADA|ALASKA)\b|\bCAMPAIGN\b|\bFRIENDS OF\b|CITIZENS FOR|COMMITTEE TO ELECT|\bPAC\b|LEADERSHIP FUND|VICTORY FUND|MAJORITY FUND|CONSERVATIVES?\b|PROGRESSIVE\b/.test(n)) return "PAC or campaign committee";
  if (/CAUCUS|\bCBC\b|\bCHCI\b|\bCAPAC\b|CONGRESSIONAL (BLACK|HISPANIC|ASIAN|WOMEN|AWARD|SPORTS|BASEBALL|FOOTBALL|SOCCER|HOCKEY|CLUB)|CONGRESSIONAL .*(INSTITUTE|FOUNDATION)|(INSTITUTE|FOUNDATION).*CONGRESSIONAL/.test(n)) return "caucus foundation or congressional institute";
  if (/FOUNDATION|INSTITUTE|CHARIT|SCHOLARSHIP|UNIVERSITY|COLLEGE|SCHOOL|HOSPITAL|MUSEUM|CHURCH|MISSION|SOCIETY|COUNCIL|ALLIANCE|ASSOCIATION|CENTER|CENTRE|FUND\b|TRUST\b|\bINC\b|NETWORK|PROJECT|PARTNERSHIP|COALITION|LEAGUE|FORUM|AWARDS?|DINNER|GALA|BALL\b|\bHONORS?\b|TRIBUTE|MEMORIAL|VETERANS|CHILDREN|YOUTH|WOMEN|FAMIL|COMMUNITY|HABITAT|RELIEF|CANCER|HEALTH|ARTS?\b|THEATRE|THEATER|SYMPHONY|OPERA|ORCHESTRA|ZOO|LIBRARY|BOYS|GIRLS|SCOUTS|YMCA|RED CROSS|UNITED WAY|WISH|HOPE\b/.test(n)) return "nonprofit, charity or awards event";
  if (/HOTEL|RESTAURANT|CATER|CLUB\b|EVENTS?\b|HALL\b|ROOM|RESORT|STEAKHOUSE|GRILL|CAFE|BAR\b|WINERY|BREWERY|GOLF|COUNTRY CLUB|STADIUM|ARENA|TICKETS?|AIRLINE|TRAVEL|RENTAL|PRODUCTIONS?|PHOTO|PRINT|FLORIST|FLOWERS|BAKERY|MARKET|AMAZON|WAL-?MART|TARGET|COSTCO|STARBUCKS|DELI|PIZZA|CHICK|SUBWAY|PANERA|DUNKIN|LLC/.test(n)) return "vendor or venue";
  return "other";
}

// ---- Load ----------------------------------------------------------------

const all = loadFilings();
const { latest, superseded } = dedupeAmendments(all.values());
const byType: Record<string, number> = {};
for (const r of all.values()) byType[r.filing_type] = (byType[r.filing_type] ?? 0) + 1;

interface Row {
  year: number; period: string; type: ItemType; filing: ContributionReport; item: ContributionItem;
  amount: number; honoree: HonoreeMatch; payee: string;
}
const rows: Row[] = [];
let fecaInThese = 0, fecaDollarsInThese = 0;
for (const f of latest.values()) {
  for (const item of f.contribution_items) {
    const amount = Number(item.amount) || 0;
    if (item.contribution_type === "feca") { fecaInThese++; fecaDollarsInThese += amount; continue; }
    rows.push({ year: f.filing_year, period: f.filing_period, type: item.contribution_type, filing: f, item, amount, honoree: matchHonoree(item.honoree_name), payee: payeeClass(item.payee_name) });
  }
}

const sum = (rs: Row[]) => rs.reduce((a, r) => a + r.amount, 0);
const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(1)}%` : "–");
const out: Record<string, unknown> = {};
const lines: string[] = [];
const p = (s = "") => lines.push(s);

p(`# LD-203 non-FECA items, filings pulled: ${all.size} (by type ${JSON.stringify(byType)}), after amendment dedupe ${latest.size} (${superseded} superseded in-set)`);
p(`FECA items riding along in these filings: ${fecaInThese} items, ${usd(fecaDollarsInThese)}`);
p();

// 1. By year and type
p("## Filings and items by year and type");
p("| Year | All LD-203 filings | Mid / year-end | Org filers | Amendments (MA/YA) | With FECA items | Type | Filings with items | Items | $ | Distinct registrants |");
p("|---|---|---|---|---|---|---|---|---|---|---|");
const years = [...new Set(rows.map((r) => r.year))].sort();
const yearType: Record<string, unknown> = {};
for (const y of years) {
  for (const t of TYPES) {
    const rs = rows.filter((r) => r.year === y && r.type === t);
    const filings = new Set(rs.map((r) => r.filing.filing_uuid)).size;
    const regs = new Set(rs.map((r) => r.filing.registrant.id)).size;
    yearType[`${y}_${t}`] = { filings, items: rs.length, dollars: sum(rs), registrants: regs, apiFilings: counts[`${y}_${t}`] };
    p(`| ${y} | ${counts[`${y}_all`]?.toLocaleString()} | ${counts[`${y}_mid_year`]?.toLocaleString()} / ${counts[`${y}_year_end`]?.toLocaleString()} | ${counts[`${y}_organization`]?.toLocaleString()} | ${counts[`${y}_MA`]} / ${counts[`${y}_YA`]} | ${counts[`${y}_feca`]?.toLocaleString()} | ${TYPE_NAMES[t]} | ${filings} (API: ${counts[`${y}_${t}`]}) | ${rs.length} | ${usd(sum(rs))} | ${regs} |`);
  }
}
out.yearType = yearType;
out.counts = counts;
p();

// 2. Honoree matching (he + me)
const hm = rows.filter((r) => r.type === "he" || r.type === "me");
p(`## Honoree matching, honorary + meeting items: ${hm.length} items, ${usd(sum(hm))}`);
p("| Match | Items | $ | Share of $ |");
p("|---|---|---|---|");
const matchStats: Record<string, unknown> = {};
for (const kind of ["full", "surname", "ambiguous", "none"] as MatchKind[]) {
  const rs = hm.filter((r) => r.honoree.kind === kind);
  matchStats[kind] = { items: rs.length, dollars: sum(rs) };
  p(`| ${kind} | ${rs.length} | ${usd(sum(rs))} | ${pct(sum(rs), sum(hm))} |`);
}
const multi = hm.filter((r) => r.honoree.multi);
p(`| (of which several honorees in one item) | ${multi.length} | ${usd(sum(multi))} | ${pct(sum(multi), sum(hm))} |`);
p();
p("Unmatched items by what the honoree text looks like:");
p("| Class | Items | $ |");
p("|---|---|---|");
for (const cls of ["official", "group", "executive", "blank", "other"]) {
  const rs = hm.filter((r) => r.honoree.kind === "none" && r.honoree.cls === cls);
  p(`| ${cls} | ${rs.length} | ${usd(sum(rs))} |`);
  (matchStats as Record<string, unknown>)[`none_${cls}`] = { items: rs.length, dollars: sum(rs) };
}
out.matchStats = matchStats;
p();
const sample = (rs: Row[], n: number) => rs.sort((a, b) => b.amount - a.amount).slice(0, n).map((r) => `${JSON.stringify(r.item.honoree_name)} ${usd(r.amount)} → ${r.item.payee_name}`);
p("Largest unmatched 'official' honorees (former members, staff, state officials?):");
for (const s of sample(hm.filter((r) => r.honoree.kind === "none" && r.honoree.cls === "official"), 15)) p(`- ${s}`);
p();
p("Largest 'ambiguous' honorees (shared surname, no first name):");
for (const s of sample(hm.filter((r) => r.honoree.kind === "ambiguous"), 12)) p(`- ${s}`);
p();
p("Largest 'surname'-only matches (check these are the member):");
for (const s of sample(hm.filter((r) => r.honoree.kind === "surname"), 15)) p(`- ${s}`);
p();
p("Largest 'other' unmatched honorees:");
for (const s of sample(hm.filter((r) => r.honoree.kind === "none" && r.honoree.cls === "other"), 15)) p(`- ${s}`);
p();

// Members matched
const perMember = new Map<string, { m: Member; items: number; dollars: number; payees: Map<string, number>; filers: Set<string> }>();
for (const r of hm) {
  if (r.honoree.kind !== "full" && r.honoree.kind !== "surname") continue;
  const share = r.amount / r.honoree.members.length;
  for (const m of r.honoree.members) {
    const e = perMember.get(m.bioguide) ?? { m, items: 0, dollars: 0, payees: new Map(), filers: new Set() };
    e.items++; e.dollars += share;
    e.payees.set(r.item.payee_name ?? "", (e.payees.get(r.item.payee_name ?? "") ?? 0) + share);
    e.filers.add(r.filing.registrant.name);
    perMember.set(m.bioguide, e);
  }
}
const memberList = [...perMember.values()].sort((a, b) => b.dollars - a.dollars);
p(`## Members named as honorees (full or unique-surname matches): ${memberList.length} of ${members.length} current members`);
const dist = [1, 2, 5, 10, 20].map((k) => `${k}+ items: ${memberList.filter((e) => e.items >= k).length}`).join(", ");
p(dist);
p(`Members with ≥ $10,000: ${memberList.filter((e) => e.dollars >= 10000).length}; ≥ $50,000: ${memberList.filter((e) => e.dollars >= 50000).length}`);
p();
p("Top 25 members by honorary + meeting $ (split evenly when an item names several):");
p("| Member | Items | $ | Filers | Top payees |");
p("|---|---|---|---|---|");
for (const e of memberList.slice(0, 25)) {
  const top = [...e.payees].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n, d]) => `${n} (${money(d)})`).join("; ");
  p(`| ${e.m.name} (${e.m.party[0]}-${e.m.state}) | ${e.items} | ${usd(e.dollars)} | ${e.filers.size} | ${top} |`);
}
out.members = memberList.map((e) => ({ bioguide: e.m.bioguide, name: e.m.name, items: e.items, dollars: Math.round(e.dollars), filers: e.filers.size }));
p();

const group = (rs: Row[], key: (r: Row) => string) => {
  const g = new Map<string, { key: string; items: number; dollars: number; raw: Map<string, number> }>();
  for (const r of rs) {
    const k = key(r);
    const e = g.get(k) ?? { key: k, items: 0, dollars: 0, raw: new Map() };
    e.items++; e.dollars += r.amount;
    g.set(k, e);
  }
  return [...g.values()].sort((a, b) => b.dollars - a.dollars);
};

// 2b. The current Congress only (2025 and 2026 filings), what the site would show
const cur = hm.filter((r) => r.year >= 2025);
const curMembers = new Map<string, { items: number; dollars: number }>();
for (const r of cur) {
  if (r.honoree.kind !== "full" && r.honoree.kind !== "surname") continue;
  for (const m of r.honoree.members) {
    const e = curMembers.get(m.bioguide) ?? { items: 0, dollars: 0 };
    e.items++; e.dollars += r.amount / r.honoree.members.length;
    curMembers.set(m.bioguide, e);
  }
}
const curList = [...curMembers.values()].sort((a, b) => b.dollars - a.dollars);
const curMatched = cur.filter((r) => r.honoree.kind === "full" || r.honoree.kind === "surname");
p(`## 2025–2026 filings only: ${cur.length} honorary + meeting items, ${usd(sum(cur))}; matched to members: ${curMatched.length} items, ${usd(sum(curMatched))}`);
p(`Members named: ${curList.length}; with 2+ items: ${curList.filter((e) => e.items >= 2).length}; 5+: ${curList.filter((e) => e.items >= 5).length}; ≥ $10,000: ${curList.filter((e) => e.dollars >= 10000).length}; median $ per named member: ${usd(curList[Math.floor(curList.length / 2)]?.dollars ?? 0)}`);
out.current = { items: cur.length, dollars: sum(cur), matchedItems: curMatched.length, matchedDollars: sum(curMatched), members: curList.length, members2: curList.filter((e) => e.items >= 2).length, members5: curList.filter((e) => e.items >= 5).length };
p();
p("What honoring a current member pays for (payee class of matched items, all years):");
p("| Payee class | Items | $ | Share |");
p("|---|---|---|---|");
const matchedAll = hm.filter((r) => r.honoree.kind === "full" || r.honoree.kind === "surname");
for (const e of group(matchedAll, (r) => r.payee)) p(`| ${e.key} | ${e.items} | ${usd(e.dollars)} | ${pct(e.dollars, sum(matchedAll))} |`);
p();
p("Precision sample: 25 full matches at random (seeded):");
let seed = 42;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const fullRows = hm.filter((r) => r.honoree.kind === "full");
for (let i = 0; i < 25; i++) {
  const r = fullRows[Math.floor(rand() * fullRows.length)]!;
  p(`- ${JSON.stringify((r.item.honoree_name ?? "").slice(0, 110))} → ${r.honoree.members.map((m) => m.name).join(", ")} | ${usd(r.amount)} to ${(r.item.payee_name ?? "").slice(0, 50)}`);
}
p();

// 3. Top honoree strings (raw)
p("## Top 25 honoree strings (honorary + meeting), as filed");
p("| Honoree | Items | $ | Match |");
p("|---|---|---|---|");
for (const e of group(hm, (r) => (r.item.honoree_name ?? "").trim().replace(/\s+/g, " ").toUpperCase()).slice(0, 25)) {
  const r = hm.find((x) => (x.item.honoree_name ?? "").trim().replace(/\s+/g, " ").toUpperCase() === e.key)!;
  p(`| ${r.item.honoree_name} | ${e.items} | ${usd(e.dollars)} | ${r.honoree.kind}${r.honoree.members.length ? ": " + r.honoree.members.map((m) => m.name).join(", ") : ""} |`);
}
p();

// 4. Payees
p("## Payees (honorary + meeting)");
p("| Payee class | Items | $ | Share |");
p("|---|---|---|---|");
const payeeClasses: Record<string, unknown> = {};
for (const e of group(hm, (r) => r.payee)) {
  payeeClasses[e.key] = { items: e.items, dollars: e.dollars };
  p(`| ${e.key} | ${e.items} | ${usd(e.dollars)} | ${pct(e.dollars, sum(hm))} |`);
}
out.payeeClasses = payeeClasses;
p();
p("Top 25 payees by $:");
p("| Payee | Items | $ | Class |");
p("|---|---|---|---|");
for (const e of group(hm, (r) => normalizeOrg(r.item.payee_name ?? "")).slice(0, 25)) {
  const r = hm.find((x) => normalizeOrg(x.item.payee_name ?? "") === e.key)!;
  p(`| ${r.item.payee_name} | ${e.items} | ${usd(e.dollars)} | ${r.payee} |`);
}
p();
p("Top 15 payees in the 'other' class (to refine the classifier):");
for (const e of group(hm.filter((r) => r.payee === "other"), (r) => normalizeOrg(r.item.payee_name ?? "")).slice(0, 15)) {
  const r = hm.find((x) => normalizeOrg(x.item.payee_name ?? "") === e.key)!;
  p(`- ${r.item.payee_name}: ${e.items} items, ${usd(e.dollars)}; honoree e.g. ${JSON.stringify(r.item.honoree_name)}`);
}
p();

// 5. Filers
p("## Filers (registrants) by honorary + meeting $");
const filers = group(hm, (r) => String(r.filing.registrant.id));
p(`Distinct registrants with honorary/meeting items: ${filers.length}. Filings by filer type: organization ${new Set(hm.filter((r) => r.filing.filer_type === "organization").map((r) => r.filing.filing_uuid)).size}, lobbyist ${new Set(hm.filter((r) => r.filing.filer_type === "lobbyist").map((r) => r.filing.filing_uuid)).size}.`);
const selfItems = hm.filter((r) => /^self$/i.test(r.item.contributor_name ?? ""));
p(`Items with contributor "SELF": ${selfItems.length} (${usd(sum(selfItems))}); the rest name a PAC or other contributor.`);
p("| Registrant | Items | $ | On the site as |");
p("|---|---|---|---|");

// Organization matching
const orgByKey = new Map<string, Organization>();
for (const o of organizations) {
  orgByKey.set(normalizeOrg(o.name), o);
  if (o.lobbying?.client) orgByKey.set(normalizeOrg(o.lobbying.client), o);
}
const orgCache = new Map<string, Organization | undefined>();
function findOrg(name: string) {
  if (orgCache.has(name)) return orgCache.get(name);
  let o = orgByKey.get(normalizeOrg(name));
  if (!o) o = organizations.find((x) => sameOrg(x.name, name) || (x.lobbying?.client ? sameOrg(x.lobbying.client, name) : false));
  orgCache.set(name, o);
  return o;
}
let matchedFilers = 0, matchedDollars = 0;
const filerRows: unknown[] = [];
for (const e of filers) {
  const r = hm.find((x) => String(x.filing.registrant.id) === e.key)!;
  const o = findOrg(r.filing.registrant.name);
  if (o) { matchedFilers++; matchedDollars += e.dollars; }
  filerRows.push({ registrant: r.filing.registrant.name, items: e.items, dollars: e.dollars, org: o?.id });
}
for (const [i, e] of filers.slice(0, 25).entries()) {
  const fr = filerRows[i] as { registrant: string; org?: string };
  p(`| ${fr.registrant} | ${e.items} | ${usd(e.dollars)} | ${fr.org ?? "–"} |`);
}
p();
p(`Registrants matched to an organization on the site: ${matchedFilers} of ${filers.length} (${pct(matchedFilers, filers.length)}), ${usd(matchedDollars)} of ${usd(sum(hm))} (${pct(matchedDollars, sum(hm))}).`);
out.filers = { total: filers.length, matched: matchedFilers, matchedDollars, rows: filerRows };
p();

// 6. Inaugural and library
for (const t of ["pic", "ple"] as const) {
  const rs = rows.filter((r) => r.type === t);
  p(`## ${TYPE_NAMES[t]}: ${rs.length} items, ${usd(sum(rs))}`);
  p("Top payees:");
  for (const e of group(rs, (r) => normalizeOrg(r.item.payee_name ?? "")).slice(0, 8)) {
    const r = rs.find((x) => normalizeOrg(x.item.payee_name ?? "") === e.key)!;
    p(`- ${r.item.payee_name}: ${e.items} items, ${usd(e.dollars)}`);
  }
  p("Top filers:");
  for (const e of group(rs, (r) => r.filing.registrant.name).slice(0, 10)) p(`- ${e.key}: ${e.items} items, ${usd(e.dollars)}`);
  const regs = group(rs, (r) => r.filing.registrant.name);
  const onSite = regs.filter((e) => findOrg(e.key));
  p(`Registrants: ${regs.length}; on the site: ${onSite.length} (${usd(onSite.reduce((a, e) => a + e.dollars, 0))} of ${usd(sum(rs))}).`);
  const byYear = group(rs, (r) => String(r.year));
  p(`By year: ${byYear.map((e) => `${e.key} ${usd(e.dollars)} (${e.items})`).join(", ")}`);
  p();
}

// 7. Data quality
p("## Data quality");
const nonFeca = rows;
const blankHonoree = nonFeca.filter((r) => r.honoree.cls === "blank");
const blankPayee = nonFeca.filter((r) => r.payee === "blank");
const zero = nonFeca.filter((r) => r.amount <= 0);
const big = nonFeca.filter((r) => r.amount >= 100000);
const outOfPeriod = nonFeca.filter((r) => {
  const d = r.item.date ?? "";
  const [lo, hi] = r.period === "mid_year" ? [`${r.year}-01-01`, `${r.year}-06-30`] : [`${r.year}-07-01`, `${r.year}-12-31`];
  return d && (d < lo || d > hi);
});
const comments = [...latest.values()].filter((f) => f.comments?.trim());
const pacPayee = hm.filter((r) => r.payee === "PAC or campaign committee" || r.payee === "party committee");
p(`- Items with a blank/N/A honoree: ${blankHonoree.length} (${usd(sum(blankHonoree))}); blank payee: ${blankPayee.length}.`);
p(`- Items with amount ≤ 0: ${zero.length}; ≥ $100,000: ${big.length} (${big.slice(0, 5).map((r) => `${r.filing.registrant.name} ${usd(r.amount)} → ${r.item.payee_name}`).join("; ")}).`);
p(`- Items dated outside the filing period: ${outOfPeriod.length} of ${nonFeca.length}.`);
p(`- Filings with a comments field: ${comments.length} of ${latest.size}. Examples: ${comments.slice(0, 3).map((f) => JSON.stringify(f.comments!.slice(0, 120))).join(" | ")}`);
p(`- Honorary/meeting items whose payee is a PAC, campaign or party committee (so already FEC-reported): ${pacPayee.length} items, ${usd(sum(pacPayee))} (${pct(sum(pacPayee), sum(hm))}).`);
p(`- Filings in the pull that are amendments: MA ${byType.MA ?? 0}, YA ${byType.YA ?? 0}; originals superseded within the pull: ${superseded}.`);
const perFiling = group(hm, (r) => r.filing.filing_uuid);
p(`- Items per filing (he+me): median ${perFiling[Math.floor(perFiling.length / 2)]?.items}, max ${Math.max(...perFiling.map((e) => e.items))}.`);
out.quality = { blankHonoree: blankHonoree.length, blankPayee: blankPayee.length, zero: zero.length, big: big.length, outOfPeriod: outOfPeriod.length, comments: comments.length, pacPayeeItems: pacPayee.length, pacPayeeDollars: sum(pacPayee), superseded, byType };

fs.writeFileSync(".cache/ld203/summary.json", JSON.stringify(out, null, 2));
fs.writeFileSync(".cache/ld203/analysis.md", lines.join("\n"));
console.log(lines.join("\n"));
