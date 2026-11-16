// Read a Senate travel filing's first pages, OCR'd: the sponsor and costs
// from the post-travel form (RE-2 for staff, its member counterpart for
// senators) and the destination from the pre-travel authorization (RE-1).
// The forms are typed (printed from the Ethics Committee's travel app) and
// scanned at the Office of Public Records.
import { amount, PARTS, type Cost } from "./house-parse.js";

export interface Line {
  s: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface OcrPage {
  page: number;
  lines: Line[];
}

export interface SenateParse {
  sponsor?: string;
  destination?: string;
  cost?: Cost;
  /** A spouse or child went too; the Senate form's one total includes them. */
  relative?: boolean;
  /** Pages OCR'd, and which held the post-travel form. */
  pages: number;
  postPage?: number;
}

const LABEL =
  /^(Private Sponsor|Travel Dates|Nam\w of acc|Relationship to|Expenses|Destination|Name of Traveler|Employing Office|NOTE|Explain|Total Expenses|Do you have|Transportation Expenses|Lodging Expenses|Meals? Expenses|Other Expenses|I also certify|Date)/i;

/** The text written under (or beside) a form label. */
function valueOf(lines: Line[], label: RegExp, { right = 0.4, below = 0.04 } = {}) {
  const l = lines.find((x) => label.test(x.s));
  if (!l) return undefined;
  // On the same line, after the colon: "Destination(s): London".
  const after = l.s.replace(label, "").replace(/^[\s:]+/, "").trim();
  if (after.length > 2) return after;
  const near = lines
    .filter((x) => x !== l && x.y > l.y + 0.004 && x.y <= l.y + l.h + below && x.x >= l.x - 0.03 && x.x < l.x + right && !LABEL.test(x.s))
    .sort((a, b) => a.y - b.y || a.x - b.x);
  return (
    near
      .map((x) => x.s)
      .join(" ")
      // A neighboring label OCR misspelled: "Nama of accompanyirig famlly member".
      .replace(/\s*\bNam\w\s+of\s*a\w*\s+fam[\s\S]*$/i, "")
      .replace(/\s*\bNam\w\s+of\s*acc[\s\S]*$/i, "")
      .trim() || undefined
  );
}

export function parseSenate(pages: OcrPage[]): SenateParse {
  const out: SenateParse = { pages: pages.length };
  for (const p of pages) {
    const text = p.lines.map((l) => l.s).join(" ");
    if (!out.postPage && /Post[- ]?Travel Disclosure/i.test(text) && /Transportation/i.test(text)) {
      out.postPage = p.page;
      out.sponsor = valueOf(p.lines, /^Private Sponsor\(?s?\)?:?/i, { right: 0.38 });
      const relative = valueOf(p.lines, /^Nam\w of acc\w*ny\w* fam\w* member( \(if any\))?:?/i, { right: 0.38 });
      out.relative = !!relative && !/^(n\s*\/?\s*a|none|no|-+|not applicable)\b/i.test(relative.trim()) && /[A-Za-z]{2}/.test(relative);
      const heads = [/^Transportation( Expenses)?/i, /^Lodging( Expenses)?/i, /^Meals?( Expenses)?/i, /^Other( Expenses)?/i].map((re) =>
        p.lines.find((l) => re.test(l.s.trim()) && l.x < 0.8)
      );
      if (heads.every(Boolean)) {
        // Each value sits under its heading, or, on the older form, beside it.
        const sameRow = Math.max(...heads.map((h) => h!.y)) - Math.min(...heads.map((h) => h!.y)) < 0.02;
        const values = heads.map((h) => {
          const cands = p.lines.filter((l) =>
            sameRow
              ? l.y > h!.y + 0.008 && l.y < h!.y + 0.06 && Math.abs(l.x - h!.x) < 0.06
              : Math.abs(l.y - h!.y) < 0.012 && l.x > h!.x + h!.w - 0.01 && l.x < h!.x + h!.w + 0.45
          );
          return cands.sort((a, b) => a.y - b.y).map((l) => l.s).join(" ");
        });
        const parsed = values.map((v, i) => (/\d/.test(v) && !/\$/.test(v) ? undefined : amount(v, i === 3)));
        if (parsed.some((v) => typeof v === "number")) {
          const parts = Object.fromEntries(PARTS.map((k, i) => [k, parsed[i] ?? null])) as Cost["parts"];
          out.cost = {
            parts,
            total: Math.round(PARTS.reduce((s, k) => s + (parts[k] ?? 0), 0) * 100) / 100,
            partial: parsed.some((v) => v === undefined),
            via: "scan",
            page: p.page,
          };
        }
      }
    }
    if (!out.destination && /Pre[- ]?Travel Authorization/i.test(text)) {
      out.destination = valueOf(p.lines, /^Destination\(?s?\)?:?/i, { right: 0.5 });
      out.sponsor ??= valueOf(p.lines, /^Private Sponsor\(?s?\)?:?/i, { right: 0.38 });
    }
  }
  return out;
}
