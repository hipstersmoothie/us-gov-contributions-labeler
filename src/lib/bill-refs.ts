// Bill citations in the free-text "specific lobbying issues" of LD-2 reports.
//
// Filers type these by hand: "H.R. 3633", "HR3633", "H. R. 3633", "S.1582",
// "S 1582", "H.J.Res. 25", "H. Con. Res. 14". We only accept a federal prefix
// followed by a number, so state bills ("S.B. 54", "A.B. 5", "H.B. 1") are
// left out even when a filer meant H.R. 1 by "H.B. 1".

export interface BillRef {
  /** e.g. "hr3633" */
  bill: string;
  /** A Congress other than the filing's was named right next to it ("118th Congress"). */
  otherCongress?: number;
  /** The name the filer wrote right after the number, if any ("Digital Asset Market Clarity Act"). */
  named?: string;
  /** Where each citation of it starts and ends in the text. */
  at: [number, number][];
}

const PREFIX: [RegExp, string][] = [
  [/^H\.?\s?J\.?\s?RES\.?$/i, "hjres"],
  [/^S\.?\s?J\.?\s?RES\.?$/i, "sjres"],
  [/^H\.?\s?CON\.?\s?RES\.?$/i, "hconres"],
  [/^S\.?\s?CON\.?\s?RES\.?$/i, "sconres"],
  [/^H\.?\s?RES\.?$/i, "hres"],
  [/^S\.?\s?RES\.?$/i, "sres"],
  [/^H\.?\s?R\.?$/i, "hr"],
  [/^S\.?$/i, "s"],
];

// Longest prefixes first so "H.J.Res." isn't read as "H." + junk. "S" must be
// a standalone token followed by a number, which rules out "S.B." and "U.S.".
const CITATION =
  /(?<![A-Z.])(H\.?\s?J\.?\s?Res\.?|S\.?\s?J\.?\s?Res\.?|H\.?\s?Con\.?\s?Res\.?|S\.?\s?Con\.?\s?Res\.?|H\.?\s?Res\.?|S\.?\s?Res\.?|H\.?\s?R\.?|S\.?)\s?(\d{1,5})\b(?!\s?(?:-|\.)\d)/gi;
const CONGRESS_NEAR = /(\d{3})(?:th|st|nd|rd)\s+Congress/i;
// "H.R. 3633, the Digital Asset Market Clarity Act" / "S. 1582 - GENIUS Act"
const NAME_AFTER = /^\s*[,:(–—-]?\s*(?:the\s+)?([A-Z][A-Za-z0-9'’\- ]{3,80}?Act)\b/;

export function billRefs(text: string, congress: number): BillRef[] {
  const found = new Map<string, BillRef>();
  for (const m of text.matchAll(CITATION)) {
    const type = PREFIX.find(([re]) => re.test(m[1]!.replace(/\s+/g, " ").trim()))?.[1];
    const number = Number(m[2]);
    if (!type || !number) continue;
    const end = m.index! + m[0].length;
    const near = text.slice(m.index!, end + 40).match(CONGRESS_NEAR);
    const other = near && Number(near[1]) !== congress ? Number(near[1]) : undefined;
    const named = text.slice(end, end + 100).match(NAME_AFTER)?.[1];
    const bill = `${type}${number}`;
    const ref = found.get(bill);
    if (ref) ref.at.push([m.index!, end]);
    else found.set(bill, { bill, ...(other ? { otherCongress: other } : {}), ...(named ? { named } : {}), at: [[m.index!, end]] });
  }
  return [...found.values()];
}

const QUARTER_END: Record<string, string> = {
  first_quarter: "03-31",
  second_quarter: "06-30",
  third_quarter: "09-30",
  fourth_quarter: "12-31",
};

/** A report can't be about a bill that hadn't been introduced by the end of
 *  its quarter; such a number is the same number in an earlier Congress. */
export function introducedBy(introduced: string, year: number, period: string) {
  return introduced <= `${year}-${QUARTER_END[period] ?? "12-31"}`;
}

const STOP = new Set(["act", "with", "from", "that", "this", "bill", "other", "purposes", "2025", "2026", "2027", "2028"]);
const words = (s: string) =>
  new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w))
  );

/** False when the filer named the bill and the name is plainly a different
 *  bill (a typo, or a number from another Congress). */
export function nameAgrees(named: string | undefined, titles: string[]) {
  if (!named) return true;
  const said = words(named);
  if (!said.size) return true;
  const known = words(titles.join(" "));
  return [...said].filter((w) => known.has(w)).length / said.size >= 0.5;
}
