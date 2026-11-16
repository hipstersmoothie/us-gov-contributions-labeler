// Build data/travel.json: every privately sponsored trip since SINCE by a
// current member or their staff, with its sponsors (matched to the site's
// organizations where they have a page), destination, dates and cost.
//
//   tsx src/scripts/travel/build.ts
import fs from "fs";
import { houseIndex, senateIndex, SINCE, type HouseFiling, type SenateFiling } from "./common.js";
import { readHouse } from "./house-read.js";
import { readSenate } from "./senate-read.js";
import { titleCase } from "../../lib/names.js";
import type { Cost } from "./house-parse.js";

export interface Trip {
  id: string;
  chamber: "house" | "senate";
  bioguide: string;
  traveler: string;
  /** The member themself, not a staffer. */
  member: boolean;
  /** As filed. */
  sponsorText: string;
  /** Keys into `sponsors`. */
  sponsors: string[];
  destination?: string;
  departure: string;
  return: string;
  cost?: {
    total: number;
    transportation: number | null;
    lodging: number | null;
    meals: number | null;
    other: number | null;
    family?: number;
    /** The Senate's one total includes a spouse or child who went too. */
    withRelative?: boolean;
    /** Read from a scan rather than the form's text. */
    scan?: boolean;
  };
  /** Why there's no cost. */
  noCost?: "not-read" | "no-form" | "not-downloaded";
  url: string;
  amends?: string;
}

export interface Sponsor {
  key: string;
  /** For its page, /travel/sponsors/<slug>/. */
  slug: string;
  name: string;
  /** The site's organization, when the sponsor has a page. */
  organization?: string;
}

// Words that don't tell sponsors apart: "Conservative Partnership Institute,
// Inc." and "The Conservative Partnership Institute" are one. Stricter than
// normalizeOrg, which drops "Fund" and "Committee" ("Commonwealth Fund" isn't
// the "Commonwealth" PAC).
const key = (name: string) =>
  name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/['’]/g, "")
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\b(THE|INC|INCORPORATED|LLC|LTD|CORP|CORPORATION|CO|OF THE UNITED STATES|USA)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    // "Main Street" and "Mainstreet".
    .replace(/ /g, "");

const clean = (s: string) =>
  s
    .replace(/\s+/g, " ")
    .replace(/^the /i, "The ")
    .replace(/[\s,;.]+$/, "")
    .trim();

// OCR'd sponsor names: Latin letters Vision read as Cyrillic look-alikes
// ("АХPС"), a date run in from the next field, a parenthesis cut off at the
// form's edge, a stray "_1" from the travel app.
const CYRILLIC: Record<string, string> = { А: "A", В: "B", Е: "E", К: "K", М: "M", Н: "H", О: "O", Р: "P", С: "C", Т: "T", Х: "X", У: "Y", а: "a", е: "e", о: "o", р: "p", с: "c", х: "x", у: "y" };
function cleanOcr(name: string) {
  const s = name
    .replace(/[А-яЁё]/g, (c) => CYRILLIC[c] ?? c)
    .replace(/^\s*\d{1,2}\/\d{1,2}\/\d{2,4}(\s+to\s+\d{1,2}\/\d{1,2}\/\d{2,4})?\s*/i, "")
    .replace(/\s*\(\s*(please )?see [^)]*\)/gi, "")
    .replace(/\s*\([^)]*$/, "")
    .replace(/\s+Spouse\b.*$/i, "")
    // "International Committee of the Red Cross - ICRC"
    .replace(/\s+[-–]\s+[A-Z]{2,6}$/, "")
    .replace(/_\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    // "Megafire Institute, Megafire Institute"
    .split(/\s*,\s*/)
    .filter((p, i, all) => all.indexOf(p) === i)
    .join(", ");
  // Still not Latin, or not a name at all.
  if (/[^\x00-\x7F’‘“”–—éèáíóúñü]/.test(s) || /^(please )?see attach|^n\/?a$/i.test(s) || !/[A-Za-z]{2,}/.test(s.replace(/\b[A-Z]\)/g, "")) || s.length < 3) return "";
  return s;
}

/** Edit distance, for OCR typos ("Founaation", "Technologiy"). */
function distance(a: string, b: string) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length]!;
}

/** "Aspen Institute, Inc., and the Rockefeller Foundation" → both. */
function splitSponsors(text: string, known: Set<string>): string[] {
  const whole = clean(text);
  if (known.has(key(whole))) return [whole];
  const parts = whole
    .split(/\s*;\s*|\s*,?\s+and\s+(?:the\s+)?|\s*&\s+(?=[A-Z][a-z]+ [A-Z])|\s*\/\s*/i)
    .map(clean)
    .filter((p) => p.length > 2 && !/^(Inc|LLC|Co|Ltd)\.?$/i.test(p));
  // Only split when every piece names a sponsor seen on its own elsewhere.
  if (parts.length > 1 && parts.every((p) => known.has(key(p)))) return parts;
  return [whole];
}

const house = (await houseIndex()).filter((f) => f.departure >= SINCE && f.bioguide);
const senate = (await senateIndex()).filter((f) => f.departure >= SINCE && f.bioguide);

// Amendments replace the filing they amend: same traveler, same departure.
function latest<T extends { filer: string; departure: string }>(rows: T[], id: (r: T) => string, isAmendment: (r: T) => boolean) {
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const k = `${r.filer.toLowerCase().replace(/[^a-z]/g, "")}|${r.departure}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const keep: { row: T; amends?: string }[] = [];
  for (const g of groups.values()) {
    const amendments = g.filter(isAmendment).sort((a, b) => id(b).localeCompare(id(a)));
    if (!amendments.length) for (const r of g) keep.push({ row: r });
    else keep.push({ row: amendments[0]!, amends: g.filter((r) => r !== amendments[0]).map(id).join(",") || undefined });
  }
  return keep;
}

const trips: Trip[] = [];
const costOf = (c: Cost | undefined): Trip["cost"] =>
  c && !c.partial && c.total > 0
    ? {
        total: c.total,
        ...c.parts,
        ...(c.family ? { family: c.family } : {}),
        ...(c.via === "scan" ? { scan: true } : {}),
      }
    : undefined;

let houseRead = 0;
for (const { row: f, amends } of latest<HouseFiling>(house, (r) => r.docId, (r) => r.amendment)) {
  const r = await readHouse(f.docId, true);
  if (r) houseRead++;
  const cost = costOf(r?.cost);
  trips.push({
    id: f.docId,
    chamber: "house",
    bioguide: f.bioguide!,
    traveler: f.filer,
    member: f.self,
    sponsorText: f.sponsor,
    sponsors: [],
    // "Las Vegas NV" → "Las Vegas, NV"
    destination: f.destination.replace(/([a-z])\s+([A-Z]{2})$/, "$1, $2") || undefined,
    departure: f.departure,
    return: f.return,
    ...(cost ? { cost } : { noCost: !r ? "not-downloaded" : r.missing === "no-form" ? "no-form" : "not-read" }),
    url: f.url,
    ...(amends ? { amends } : {}),
  });
}

let senateRead = 0;
const senateSponsorText = new Map<string, string>();
for (const { row: f } of latest<SenateFiling>(senate, (r) => r.id, () => false)) {
  const r = readSenate(f.id, true);
  if (r) senateRead++;
  const cost = costOf(r?.cost);
  if (cost && r?.relative) cost.withRelative = true;
  const sponsorText = cleanOcr(r?.sponsor ?? "");
  senateSponsorText.set(f.id, sponsorText);
  trips.push({
    id: f.id,
    chamber: "senate",
    bioguide: f.bioguide!,
    traveler: titleCase(f.filer),
    member: f.self,
    sponsorText,
    sponsors: [],
    destination: r?.destination?.replace(/\s+/g, " ").trim(),
    departure: f.departure,
    return: f.return,
    ...(cost ? { cost } : { noCost: !r ? "not-downloaded" : "not-read" }),
    url: f.url,
  });
}

// Sponsors: one key per organization however it's spelled, then the site's
// organizations by normalized name or lobbying client name.
// Names seen on their own: every House sponsor (typed by the Clerk), and
// Senate ones that name a single sponsor.
const known = new Set<string>();
for (const t of trips) if (t.chamber === "house" || (t.sponsorText && !/[,;]/.test(t.sponsorText))) known.add(key(clean(t.sponsorText)));
// Acronyms: filed in parentheses ("Global Women's Innovation Network
// (GlobalWIN)"), or a single sponsor's initials ("MIT", "AEI").
const acronyms = new Map<string, string>();
const initials = new Map<string, string[]>();
for (const t of trips) {
  if (!t.sponsorText || /[,;]| and /.test(t.sponsorText)) continue;
  const m = t.sponsorText.match(/^([^(]+)\(([^)]{2,12})\)\s*$/);
  if (m) acronyms.set(key(m[2]!), key(clean(m[1]!)));
  if (t.chamber !== "house") continue;
  const full = clean(t.sponsorText.replace(/\([^)]*\)/g, ""));
  const abbr = full.split(/\s+/).filter((w) => !/^(of|the|and|for|in|on|at|to|inc\.?)$/i.test(w)).map((w) => w[0]).join("").toLowerCase();
  if (abbr.length >= 2) initials.set(abbr, [...new Set([...(initials.get(abbr) ?? []), key(full)])]);
}
const houseKeys = new Set(trips.filter((t) => t.chamber === "house").map((t) => key(clean(t.sponsorText))));
const seen = new Map<string, number>();
for (const t of trips) if (t.sponsorText) seen.set(key(clean(t.sponsorText)), (seen.get(key(clean(t.sponsorText))) ?? 0) + 1);
/** Of two spellings, the one to keep: the House's, then the more common, then the longer (OCR drops letters). */
const better = (a: string, b: string) =>
  Number(houseKeys.has(a)) - Number(houseKeys.has(b)) || (seen.get(a) ?? 0) - (seen.get(b) ?? 0) || a.length - b.length || (a < b ? 1 : -1);
/** A Senate name, snapped to a House spelling when it's an acronym for one or an OCR typo away. */
function snap(k: string) {
  if (houseKeys.has(k)) return k;
  if (acronyms.has(k)) return snap(acronyms.get(k)!);
  if (k.length <= 5 && initials.get(k)?.length === 1) return initials.get(k)![0]!;
  if (k.length < 8) return k;
  let best: [string, number] | undefined;
  for (const h of known) {
    if (h === k || Math.abs(h.length - k.length) > 3) continue;
    const d = distance(h, k);
    if (d <= Math.max(1, Math.floor(k.length / 10)) && better(h, k) > 0 && (!best || d < best[1])) best = [h, d];
  }
  return best?.[0] ?? k;
}
const names = new Map<string, Map<string, number>>();
for (const t of trips) {
  if (!t.sponsorText) continue;
  for (const name of splitSponsors(t.sponsorText, known)) {
    const k = t.chamber === "senate" ? snap(key(name)) : key(name);
    if (!k) continue;
    t.sponsors.push(k);
    const counts = names.get(k) ?? new Map<string, number>();
    counts.set(name, (counts.get(name) ?? 0) + 1);
    names.set(k, counts);
  }
  t.sponsors = [...new Set(t.sponsors)];
}

const { organizations } = JSON.parse(fs.readFileSync("data/organizations.json", "utf8")) as {
  organizations: { id: string; name: string; lobbying?: { client: string } }[];
};
const orgByKey = new Map<string, string>();
for (const o of organizations) {
  // Organizations named only by their committee ("center-forward-c00568444")
  // are the PAC itself, not the nonprofit of the same name that pays for trips.
  if (/-c\d{8}$/.test(o.id)) continue;
  for (const n of [o.name, o.lobbying?.client].filter(Boolean) as string[]) {
    const k = key(n);
    if (k && !orgByKey.has(k)) orgByKey.set(k, o.id);
  }
}

const sponsors: Sponsor[] = [...names].map(([k, counts]) => {
  // The spelling filed most often, preferring House (typed) spellings.
  const name = [...counts].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0]![0];
  return { key: k, slug: "", name: name.replace(/,? Inc\.?$/, ""), organization: orgByKey.get(k) };
});
const slugs = new Set<string>();
for (const s of sponsors.sort((a, b) => a.name.localeCompare(b.name))) {
  const base = s.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/&/g, " and ").replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "sponsor";
  let slug = base;
  for (let i = 2; slugs.has(slug); i++) slug = `${base}-${i}`;
  slugs.add(slug);
  s.slug = slug;
}

// Senate destinations, when the pre-travel form wasn't in the pages read:
// a House filing for the same sponsor and the same dates.
for (const t of trips.filter((t) => t.chamber === "senate" && !t.destination)) {
  const twin = trips.find(
    (h) => h.chamber === "house" && h.departure === t.departure && h.return === t.return && h.sponsors.some((s) => t.sponsors.includes(s))
  );
  if (twin?.destination) t.destination = twin.destination;
}

// Last checks on costs read from scans: no single part over $30,000, and no
// total more than 4 times (or under a quarter of) what others on the same
// trip reported. Both catch OCR errors ("$254/night" run into "477.95").
const sameTrip = new Map<string, Trip[]>();
for (const t of trips) {
  if (!t.cost) continue;
  const k = `${t.sponsors.join("+")}|${t.departure}|${t.return}`;
  sameTrip.set(k, [...(sameTrip.get(k) ?? []), t]);
}
let dropped = 0;
for (const group of sameTrip.values()) {
  const sorted = group.map((t) => t.cost!.total).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  for (const t of group) {
    const c = t.cost!;
    if (!c.scan) continue;
    const huge = [c.transportation, c.lodging, c.meals, c.other].some((v) => (v ?? 0) > 30_000);
    const odd = group.length >= 4 && (c.total > median * 4 || c.total < median / 4);
    if (huge || odd) {
      delete t.cost;
      t.noCost = "not-read";
      dropped++;
    }
  }
}
console.log(`scanned costs dropped by the last checks: ${dropped}`);

trips.sort((a, b) => b.departure.localeCompare(a.departure) || a.id.localeCompare(b.id));
const out = { generatedAt: new Date().toISOString(), since: SINCE, sponsors, trips };
fs.writeFileSync("data/travel.json", JSON.stringify(out) + "\n");

// Coverage.
const pct = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}%`;
for (const ch of ["house", "senate"] as const) {
  const ts = trips.filter((t) => t.chamber === ch);
  const withCost = ts.filter((t) => t.cost);
  console.log(
    `${ch}: ${ts.length} trips (${ch === "house" ? houseRead : senateRead} filings read), cost ${withCost.length} (${pct(withCost.length, ts.length)}), ` +
      `from scans ${withCost.filter((t) => t.cost!.scan).length}, sponsor ${pct(ts.filter((t) => t.sponsors.length).length, ts.length)}, ` +
      `destination ${pct(ts.filter((t) => t.destination).length, ts.length)}, offices ${new Set(ts.map((t) => t.bioguide)).size}, ` +
      `members themselves ${ts.filter((t) => t.member).length}; total ${Math.round(withCost.reduce((s, t) => s + t.cost!.total, 0)).toLocaleString()}`
  );
}
const matched = sponsors.filter((s) => s.organization);
const tripsMatched = trips.filter((t) => t.sponsors.some((k) => matched.some((s) => s.key === k)));
console.log(`sponsors ${sponsors.length}; with an organization page ${matched.length}; trips by them ${tripsMatched.length} (${pct(tripsMatched.length, trips.length)})`);
console.log("matched:", matched.slice(0, 60).map((s) => `${s.name} → ${s.organization}`).join("; "));
const top = new Map<string, number>();
for (const t of trips) for (const k of t.sponsors) top.set(k, (top.get(k) ?? 0) + 1);
console.log(
  "top sponsors:",
  [...top].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([k, n]) => `${sponsors.find((s) => s.key === k)!.name} ${n}${sponsors.find((s) => s.key === k)!.organization ? " *" : ""}`).join("; ")
);
