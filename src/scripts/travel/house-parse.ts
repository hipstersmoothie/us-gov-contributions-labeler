// Read what a trip cost from a House gift travel filing.
//
// A filing bundles the traveler's post-travel form, the sponsor's post-travel
// form, the Ethics Committee's approval letter and the pre-approval forms
// (traveler form, primary trip sponsor form, agenda). The cost is the sponsor
// post-travel form's question 5, "Actual amount of expenses paid on behalf
// of, or reimbursed to, each individual": transportation, lodging, meals and
// other, per traveler, with a second row for an accompanying relative. The
// pre-approval form's question 18 is a good-faith estimate made before the
// trip, so it isn't used.
//
// Most sponsor forms are fillable PDFs: the amounts are form field values,
// not page text. Flattened forms have them in the text layer, in columns
// under the four headings. Scanned forms have neither, and are read by OCR
// (ocr.swift) with the same column logic.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export const PARTS = ["transportation", "lodging", "meals", "other"] as const;
export type Part = (typeof PARTS)[number];

export interface Cost {
  /** Each part in dollars; null where the form says none or doesn't apply. */
  parts: Record<Part, number | null>;
  total: number;
  /** A part was filled in with something other than an amount ("see attached"). */
  partial: boolean;
  /** Paid for an accompanying relative, all parts together. */
  family?: number;
  /** Where it was read: form fields, the text layer, or OCR of a scan. */
  via: "fields" | "text" | "scan";
  page: number;
  /** A scanned figure that didn't pass the checks; not shown. */
  unsure?: boolean;
  sponsor?: string;
  travelers?: string;
}

export interface HouseParse {
  pages: number;
  /** Pages with no text layer (scans). */
  imagePages: number[];
  /** One per sponsor post-travel form found (joint sponsors may file one each). */
  costs: Cost[];
  /** A typed sponsor post-travel form was found with its amounts blank
   *  (some are printed to PDF with the amounts as drawings, not text). */
  blankForm: boolean;
  blankPages: number[];
}

const NONE = /^(none|n\/?a|not applicable|na|-+|—|–|\$?0(\.00)?|no|nothing|\$-|\$ -|n\.a)$/i;
const MONEY = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?(?!\d)/g;

/** "$1,234.56" → 1234.56; "None" → null; "see attached" → undefined. The
 *  "other" column may list several items ("$70 baggage fees, $30.04 meal"),
 *  which are added up. */
export function amount(raw: string | undefined, sum = false): number | null | undefined {
  const s = (raw ?? "")
    .replace(/\s+/g, " ")
    .replace(/\$\s+/g, "$")
    // Periods as thousands separators: "$17.576.91".
    .replace(/(\d{1,3})\.(\d{3})\.(\d{2})\b/g, "$1,$2.$3")
    .trim();
  if (!s) return null;
  if (NONE.test(s.replace(/[.\s]+$/, ""))) return null;
  const dollars = [...s.matchAll(MONEY)].map((m) => Number(m[1]!.replace(/,/g, "") + (m[2] ?? "")));
  if (sum && dollars.length > 1) return Math.round(dollars.reduce((a, b) => a + b, 0) * 100) / 100;
  // A bare figure at the start: "1555", "740.00 (hotel)".
  const bare = s.match(/^(\d{1,3}(?:,\d{3})+|\d+)(\.\d{1,2})?(?![\d/])/);
  if (bare) return Number(bare[1]!.replace(/,/g, "") + (bare[2] ?? ""));
  if (dollars.length) return dollars[0]!;
  if (/^(none|n\/a|not applicable)\b/i.test(s)) return null;
  return undefined;
}

function costFrom(values: (string | undefined)[], via: Cost["via"], page: number, family?: (string | undefined)[]): Cost | undefined {
  const parsed = values.map((v, i) => amount(v, i === 3));
  if (parsed.every((v) => v === null)) return undefined;
  const parts = Object.fromEntries(PARTS.map((p, i) => [p, parsed[i] ?? null])) as Cost["parts"];
  const fam = (family ?? []).map((v, i) => amount(v, i === 3) ?? 0).reduce((a, b) => a + b, 0);
  return {
    parts,
    total: Math.round(PARTS.reduce((s, p) => s + (parts[p] ?? 0), 0) * 100) / 100,
    partial: parsed.some((v) => v === undefined),
    ...(fam > 0 ? { family: Math.round(fam * 100) / 100 } : {}),
    via,
    page,
  };
}

/** A piece of text on the page, in points from the top left. */
export interface Cell {
  x: number;
  y: number;
  s: string;
}

/** The traveler and family rows of the question 5 table, by column. */
export function readTable(cells: Cell[], joinSplit = true): { traveler: string[]; family: string[] } | undefined {
  const q5 = cells.find((c) => /Actual amount/i.test(c.s));
  const below = cells.filter((c) => !q5 || c.y > q5.y - 2);
  // Headings come as one piece ("Total Transportation") or two ("Total", "Transportation").
  const heading = (re: RegExp) => {
    const h = below.find((c) => re.test(c.s));
    if (!h || /Total/.test(h.s)) return h;
    const total = below.filter((c) => /^Total$/.test(c.s.trim()) && Math.abs(c.y - h.y) < 4 && c.x < h.x).sort((a, b) => b.x - a.x)[0];
    return total ?? h;
  };
  const heads = [/Transportation/, /Lodging/, /\bMeals?\b/, /\bOther\b/].map(heading);
  if (!heads.every(Boolean)) return undefined;
  const xs = heads.map((h) => h!.x);
  const top = Math.max(...heads.map((h) => h!.y));
  const traveler = below.find((c) => /^Traveler:?$/i.test(c.s.trim()) && c.y > top && c.x < xs[0]!);
  if (!traveler) return undefined;
  const acc = below.find((c) => /^Accompanying/i.test(c.s.trim()) && c.y > traveler.y && c.x < xs[0]!);
  const end =
    below.find((c) => c.y > (acc?.y ?? traveler.y) + 4 && /^(6\.|All expenses connected|Signify|■|I certify)/.test(c.s.trim()))?.y ??
    (acc?.y ?? traveler.y) + 60;
  // The headings' wrapped lines ("Expenses", "(dollar amount per item") sit
  // above the traveler row; values start a little above the label at most.
  const rowTop = Math.max(top + 4, traveler.y - 10);
  const rowSplit = acc ? acc.y - 6 : end;
  const label = /^(Traveler|Accompanying|Family Member|Relative|Expenses|\(dollar amount|and description\)|Total)/i;

  const columns = (lo: number, hi: number, joinSplit: boolean) => {
    const cols: string[][] = [[], [], [], []];
    const inRow = below
      .filter((c) => c.y >= lo && c.y < hi && c.x > xs[0]! - 40 && !label.test(c.s.trim()))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    for (const c of inRow) {
      let i = Math.max(0, xs.findLastIndex((x) => x <= c.x + 24));
      // One piece can hold several columns' values: "$77.00 None $34.58 None".
      const tokens = c.s.match(/\$\s?[\d,]+(?:\.\d{1,2})?(?:\s+[A-Za-z(][^$]*)?|None|N\/A|n\/a|Not Applicable|[^$\s][^$]*/g) ?? [c.s];
      const values = tokens.filter((t) => amount(t) !== undefined);
      if (values.length >= 2 && i < 3) {
        for (const t of tokens) cols[Math.min(3, i++)]!.push(t.trim());
      } else {
        cols[i]!.push(c.s.trim());
      }
    }
    // Pieces of one figure split across text runs: "$6" "45.15", "$" "286.20".
    // Not for OCR, where they're separate lines ("($254/night" over "477.95").
    return cols.map((c) => (joinSplit ? c.join(" ").replace(/(\$\s?\d{0,3}) (\d[\d,]*\.\d{2})\b/g, "$1$2") : c.join(" ")).trim());
  };
  return { traveler: columns(rowTop, rowSplit, joinSplit), family: acc ? columns(rowSplit, end, joinSplit) : [] };
}

const FIELD = (part: Part, who: "Traveler" | "Accompanying") => {
  const head = { transportation: "Transportation", lodging: "Lodging", meals: "Meal", other: "Other" }[part];
  return new RegExp(`^Total ${head} Expenses.*${who}`, "i");
};

export async function parseHouse(data: Buffer): Promise<HouseParse> {
  const task = getDocument({ data: new Uint8Array(data), verbosity: 0, useSystemFonts: false });
  const doc = await task.promise;
  const out: HouseParse = { pages: doc.numPages, imagePages: [], costs: [], blankForm: false, blankPages: [] };
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const height = page.view[3]! - page.view[1]!;
    const content = await page.getTextContent();
    const cells: Cell[] = (content.items as any[])
      .filter((i) => i.str?.trim())
      .map((i) => ({ x: i.transform[4] as number, y: Math.round(height - (i.transform[5] as number)), s: i.str as string }));
    const text = cells.map((r) => r.s).join(" ");
    if (text.length < 50) out.imagePages.push(p);

    const ann = (await page.getAnnotations()) as any[];
    const fields = new Map<string, string>();
    for (const a of ann) if (a.subtype === "Widget" && a.fieldName) fields.set(String(a.fieldName).trim(), String(a.fieldValue ?? "").trim());
    const fieldFor = (part: Part, who: "Traveler" | "Accompanying") => [...fields].find(([k]) => FIELD(part, who).test(k))?.[1];
    const isSponsorPost =
      /Actual amount of expenses paid on behalf of/i.test(text) || [...fields.keys()].some((k) => FIELD("transportation", "Traveler").test(k));
    if (!isSponsorPost) continue;

    // 1. Form fields.
    const byPart = PARTS.map((part) => fieldFor(part, "Traveler"));
    let cost = byPart.some((v) => v) ? costFrom(byPart, "fields", p, PARTS.map((part) => fieldFor(part, "Accompanying"))) : undefined;

    // 2. The text layer.
    if (!cost) {
      const table = readTable(cells);
      if (table) cost = costFrom(table.traveler, "text", p, table.family);
    }

    if (cost) {
      cost.sponsor = [...fields].find(([k]) => /^Sponsors who paid/i.test(k))?.[1] || undefined;
      cost.travelers = [...fields].find(([k]) => /^Names of Travelers/i.test(k))?.[1] || undefined;
      out.costs.push(cost);
    } else if (!out.imagePages.includes(p)) {
      out.blankForm = true;
      out.blankPages.push(p);
    }
  }
  await task.destroy();
  return out;
}

/** OCR'd lines (0–1 boxes, origin top left) as cells on a letter-size page. */
export function ocrCells(lines: { s: string; x: number; y: number; h: number }[]): Cell[] {
  // Vision boxes are top-left; the text layer's runs are baselines, so use
  // the box's bottom to line them up the same way.
  return lines.map((l) => ({ x: l.x * 612, y: Math.round((l.y + l.h) * 792), s: l.s }));
}

/** Cost from an OCR'd page, if it's a sponsor post-travel form. */
export function costFromOcr(lines: { s: string; x: number; y: number; h: number }[], page: number): Cost | undefined {
  const text = lines.map((l) => l.s).join(" ");
  if (!/SPONSOR POST-?TRAVEL|Actual amount of expenses/i.test(text)) return undefined;
  const table = readTable(ocrCells(lines), false);
  const cost = table && costFrom(table.traveler, "scan", page, table.family);
  if (!cost) return undefined;
  // Handwritten dollar signs read as digits ("$1052.53" → "91052"), so a scanned
  // figure counts only with its dollar sign read.
  if (table.traveler.some((v) => typeof amount(v) === "number" && !/\$/.test(v))) cost.unsure = true;
  return cost;
}
