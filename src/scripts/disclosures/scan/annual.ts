// Schedule A (assets) from analyzed pages of a scanned paper annual report.
//
// The paper form is a grid: owner, asset name, an EIF box, then Block B's 13
// value columns (A "None" through M "Spouse/DC asset over $1,000,000"), then
// income type, income amount and transactions. Each ruled row is one asset; the
// value is the Block B cell with clearly more ink than its column.
import type { ScanPage, Word } from "./ptr.js";

export interface ScannedHolding {
  page: number;
  owner: "self" | "spouse" | "joint" | "child";
  asset: string;
  ticker?: string;
  min?: number;
  max?: number | null;
  doubts: string[];
}

/** Block B, columns A–M. */
export const VALUES: [number, number | null][] = [
  [0, 0], [1, 1_000], [1_001, 15_000], [15_001, 50_000], [50_001, 100_000], [100_001, 250_000],
  [250_001, 500_000], [500_001, 1_000_000], [1_000_001, 5_000_000], [5_000_001, 25_000_000],
  [25_000_001, 50_000_000], [50_000_001, null], [1_000_001, null],
];
const OWNERS: Record<string, ScannedHolding["owner"]> = { SP: "spouse", JT: "joint", DC: "child" };
/** The form's printed example rows. */
const EXAMPLE = /example|mega corp|simon\s*&?\s*schuster|abc hedge|ex mpl/i;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

export function isScheduleA(p: ScanPage) {
  const text = p.words.map((w) => w.t).join(" ");
  return /SCHEDULE A|BLOCK B|Value of Asset/i.test(text) && !/SCHEDULE [B-J]\b/i.test(text) && p.vlines.length >= 18;
}

export function parseScannedScheduleA(pages: ScanPage[]) {
  const holdings: ScannedHolding[] = [];
  const skipped: { page: number; why: string }[] = [];
  for (const p of pages) {
    if (!isScheduleA(p)) continue;
    const { vlines: xs, hlines: ys } = p;
    const inCol = (w: Word, c: number) => (w.x0 + w.x1) / 2 >= xs[c]! && (w.x0 + w.x1) / 2 < xs[c + 1]!;
    const width = (c: number) => xs[c + 1]! - xs[c]!;

    // Asset name: the widest of the first few columns. Block B starts after
    // it, or after the EIF box where the form has one.
    const firstCols = Array.from({ length: Math.min(4, xs.length - 1) }, (_, c) => c);
    const nameCol = firstCols.reduce((b, c) => (width(c) > width(b) ? c : b), 0);
    // Block B's 13 columns are lettered A–M across the top. OCR reads some of
    // the letters, sometimes run together ("DEFGH"); each one votes for where
    // column A is. Failing that, center 13 columns under "Value of Asset" (or
    // "BLOCK B"), and failing that, start after the EIF box.
    const colAt = (x: number) => xs.findIndex((v, i) => i < xs.length - 1 && x >= v && x < xs[i + 1]!);
    const votes = new Map<number, number>();
    for (const w of p.words) {
      const t = w.t.replace(/\s+/g, "");
      if (!/^[A-M]+$/.test(t) || t.length > 13) continue;
      const step = (w.x1 - w.x0) / t.length;
      [...t].forEach((ch, i) => {
        const c = colAt(w.x0 + step * (i + 0.5)) - (ch.charCodeAt(0) - 65);
        if (c > nameCol) votes.set(c, (votes.get(c) ?? 0) + 1);
      });
    }
    const voted = [...votes].sort((a, b) => b[1] - a[1])[0];
    const heading = p.words.find((w) => /value\s*of\s*asset/i.test(w.t)) ?? p.words.find((w) => /^BLOCK\s*B$/i.test(w.t.trim()));
    let centered: number | undefined;
    if (heading) {
      const mid = (heading.x0 + heading.x1) / 2;
      let best = Infinity;
      for (let c = nameCol + 1; c + 13 < xs.length; c++) {
        const d = Math.abs((xs[c]! + xs[c + 13]!) / 2 - mid);
        if (d < best) [best, centered] = [d, c];
      }
    }
    const eif = p.words.some((w) => inCol(w, nameCol + 1) && /^E\s?I\s?F$/i.test(w.t.trim()));
    const start = voted && voted[1] >= 2 ? voted[0] : centered ?? nameCol + 1 + (eif ? 1 : 0);
    const valueCols = Array.from({ length: 13 }, (_, i) => start + i).filter((c) => c < xs.length - 1);
    if (valueCols.length < 13) {
      skipped.push({ page: p.page, why: "fewer than 13 value columns" });
      continue;
    }

    // Data rows: ruled rows with a name in them, below the column headers and
    // the form's three printed example rows (Mega Corp, Simon & Schuster, ABC
    // Hedge Fund), which OCR garbles past any name filter.
    const header = p.words.find((w) => /asset\s*name/i.test(w.t));
    const rowOf = (w: Word) => ys.findIndex((y, i) => i < ys.length - 1 && (w.y0 + w.y1) / 2 > y && (w.y0 + w.y1) / 2 < ys[i + 1]!);
    const exampleRows = p.words.filter((w) => /^ex\s?a?m?p?le?:?$|example/i.test(w.t.trim()) || EXAMPLE.test(w.t)).map(rowOf).filter((r) => r >= 0);
    const formRows = p.words.filter((w) => /SCHEDULE A|BLOCK [A-E]|Income Sources|Value of Asset/i.test(w.t)).map(rowOf).filter((r) => r >= 0);
    const firstData = Math.max(
      header ? rowOf(header) + 1 : 0,
      exampleRows.length ? Math.min(...exampleRows) + 3 : 0,
      formRows.length ? Math.max(...formRows) + 1 : 0
    );
    const rows: number[] = [];
    for (let r = firstData; r < ys.length - 1; r++) {
      const name = p.words.filter((w) => inCol(w, nameCol) && (w.y0 + w.y1) / 2 > ys[r]! && (w.y0 + w.y1) / 2 < ys[r + 1]!);
      if (name.length) rows.push(r);
    }
    const base = valueCols.map((c) => median(rows.map((r) => p.ink[r]?.[c] ?? 0)));

    for (const r of rows) {
      const inRow = (w: Word) => (w.y0 + w.y1) / 2 > ys[r]! && (w.y0 + w.y1) / 2 < ys[r + 1]!;
      const nameWords = p.words.filter((w) => inRow(w) && inCol(w, nameCol)).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
      let asset = nameWords.map((w) => w.t).join(" ").replace(/\s+/g, " ").trim();
      // OCR sometimes runs the owner tag into the name: "DC CINCINNATI OHIO ...".
      const runIn = asset.match(/^\(?(SP|DC|JT)\)?\s+(?=\S)/);
      if (runIn) asset = asset.slice(runIn[0].length);
      if (EXAMPLE.test(asset) || /asset name|provide complete/i.test(asset)) continue;
      const doubts: string[] = [];
      const ink = p.ink[r] ?? [];
      const vals = valueCols.map((c) => ink[c] ?? 0);
      const rowBase = median(vals);
      const excess = vals.map((v, i) => v - Math.min(base[i]!, rowBase));
      const order = excess.map((e, i) => [e, i] as const).sort((a, b) => b[0] - a[0]);
      const [best, second] = [order[0]!, order[1]];
      let value: [number, number | null] | undefined;
      if (best[0] < 0.012) doubts.push("value: no mark found");
      else {
        value = VALUES[best[1]];
        if (second && second[0] > 0.012 && second[0] > best[0] * 0.5) doubts.push("value: two marks");
      }
      if (nameWords.some((w) => w.c < 0.5)) doubts.push("asset name read with low confidence");
      // Owner: a tag in the first column, or in parentheses before the name ("(SP) ...").
      const ownerText = p.words
        .filter((w) => inRow(w) && (w.x0 + w.x1) / 2 < xs[nameCol]!)
        .map((w) => w.t)
        .join("")
        .toUpperCase()
        .replace(/[^A-Z0-9$]/g, "");
      const lead = runIn?.[1];
      const tag = lead ?? (/^[S5$][PRF]?/.test(ownerText) ? "SP" : /^D[CGO0]?/.test(ownerText) ? "DC" : /^[JI][T1]?/.test(ownerText) ? "JT" : ownerText);
      if (ownerText && !lead && !OWNERS[tag]) doubts.push("owner unclear");
      // A tag OCR didn't read at all: the owner cell has ink (a tag is ~0.2, empty under 0.07).
      else if (!ownerText && !lead && Array.from({ length: nameCol }, (_, c) => ink[c] ?? 0).some((v) => v > 0.1)) doubts.push("owner unclear");
      const ticker = asset.match(/\(([A-Z][A-Z.]{0,5})\)/)?.[1];
      holdings.push({
        page: p.page,
        owner: OWNERS[tag] ?? "self",
        asset,
        ...(ticker && !OWNERS[ticker] ? { ticker } : {}),
        ...(value ? { min: value[0], max: value[1] } : {}),
        doubts,
      });
    }
  }
  return { holdings, skipped };
}
