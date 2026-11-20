// Text helpers for posts: money, names, seats, and fitting a post into
// Bluesky's 300 graphemes.
import { shortSector, labelName } from "../src/lib/labels.js";
import { STATES } from "../src/lib/list-specs.js";
import { candidateName, partyCode } from "../src/lib/names.js";
import type { Data, Member, Race, RaceCandidate } from "./data.js";

export const MAX_GRAPHEMES = 300;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
export const graphemes = (text: string) => [...segmenter.segment(text)].length;

/** $2,011,264 -> "$2M"; $1,634,600 -> "$1.6M"; $723,631 -> "$724K"; $950 -> "$950". */
export function usd(n: number) {
  // Each unit takes over where rounding would otherwise print "$1000K".
  if (n >= 999.95e6) return `$${trim((n / 1e9).toFixed(1))}B`;
  if (n >= 999.5e3) return `$${trim((n / 1e6).toFixed(1))}M`;
  if (n >= 999.5) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}
const trim = (s: string) => s.replace(/\.0$/, "");

/** "Nov. 3", AP style. */
export function day(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`);
  const month = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."][d.getUTCMonth()];
  return `${month} ${d.getUTCDate()}`;
}

export const stateName = (st: string) => STATES[st] ?? st;
/** In a sentence: "Wyoming", "the U.S. Virgin Islands". */
export function theState(st: string) {
  const name = stateName(st);
  return /^(U\.S\.|District|Northern)/.test(name) ? `the ${name}` : name;
}
/** "Wyoming's", "the U.S. Virgin Islands'". */
export function possessive(st: string) {
  const name = theState(st);
  return `${name}${name.endsWith("s") ? "'" : "'s"}`;
}
export const capitalize = (s: string) => s[0]!.toUpperCase() + s.slice(1);

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};
export const isDelegateState = (st: string) => ["DC", "PR", "GU", "VI", "AS", "MP"].includes(st);

/** "Senate", "1st District", "At large", "Delegate", "Resident commissioner". */
export function seatLabel(r: Pick<Race, "office" | "state" | "district">) {
  if (r.office === "S") return "Senate";
  if (r.state === "PR") return "Resident commissioner";
  if (isDelegateState(r.state)) return "Delegate";
  return r.district ? `${ordinal(r.district)} District` : "At large";
}

/** A member's or candidate's display name. */
export function personName(c: { name: string; bioguide?: string }, data: Data) {
  return (c.bioguide && data.memberById.get(c.bioguide)?.name) || candidateName(c.name);
}

/** "D", "R", "I", or the FEC code for other parties ("LIB"). */
export function partyOf(c: { party?: string; bioguide?: string }, data: Data) {
  const m = c.bioguide ? data.memberById.get(c.bioguide) : undefined;
  return m?.party[0] ?? partyCode(c.party) ?? c.party ?? "?";
}

/** "Rep.", "Sen.", "Del.", "Res. Commissioner". */
export function title(m: Member) {
  if (m.chamber === "senate") return "Sen.";
  if (m.state === "PR") return "Res. Commissioner";
  return isDelegateState(m.state) ? "Del." : "Rep.";
}
/** "D-WA", "R-TX-30", "D-DC". */
export function memberTag(m: Member) {
  const p = m.party[0];
  if (m.chamber === "senate" || isDelegateState(m.state)) return `${p}-${m.state}`;
  return `${p}-${m.state}-${m.district ? m.district : "AL"}`;
}

const NOT_INDUSTRY = new Set(["Unknown", "Party & Candidate Committees", "Retired", "Not employed"]);
/** Top industries, short names: the same ones a member's labels use. */
export function topSectors(x: { combinedSectors: { id: string }[] }, n = 3) {
  return x.combinedSectors.filter((s) => !NOT_INDUSTRY.has(s.id)).slice(0, n).map((s) => shortSector(s.id));
}
/** Top contributing organizations, short names: no party committees, no employers we couldn't match to an organization. */
export function topContributors(x: { contributors: { id: string; name: string }[] }, data: Data, n = 3) {
  return x.contributors
    .filter((c) => !c.id.startsWith("employer:") && data.orgById.get(c.id)?.sector !== "Party & Candidate Committees")
    .slice(0, n)
    .map((c) => labelName(c.name, c.id));
}

/** A candidate's own contributions and loans. */
export const ownMoney = (c: RaceCandidate) => (c.money?.candidate ?? 0) + (c.money?.candidateLoans ?? 0);

/**
 * Join required lines with as many optional ones as fit, keeping their
 * order. Throws if the required lines alone don't fit.
 */
export function fit(lines: { text: string; optional?: boolean }[], max = MAX_GRAPHEMES) {
  const keep = lines.map(() => true);
  const join = () => lines.filter((_, i) => keep[i]).map((l) => l.text).join("\n");
  // Drop optional lines from the end until it fits.
  for (let i = lines.length - 1; i >= 0 && graphemes(join()) > max; i--) if (lines[i]!.optional) keep[i] = false;
  const text = join();
  if (graphemes(text) > max) throw new Error(`Post too long (${graphemes(text)}): ${text}`);
  return text;
}
