// Turn analyzed pages of a scanned paper PTR (scan/analyze.swift) into trades.
//
// Paper PTRs are grids: owner, asset, a checkbox per transaction type, two
// dates, then a checkbox per amount range. Rows are the bands between ruling
// lines that hold a date; a checkbox is "marked" when its cell has clearly
// more ink than that column's empty cells on the same page.
export interface Word { t: string; x0: number; y0: number; x1: number; y1: number; c: number; reads?: string[] }
export interface Band { x0: number; x1: number; y0: number; y1: number; ink: number[]; profile?: number[] }
export interface ScanPage {
  file: string;
  page: number;
  rotation: number;
  words: Word[];
  vlines: number[];
  hlines: number[];
  ink: number[][];
  bands: Band[];
}

export interface ScannedTrade {
  page: number;
  owner: "self" | "spouse" | "joint" | "child";
  asset: string;
  /** The account or trust heading the rows above it, if the form has one. */
  account?: string;
  tx?: string;
  date?: string;
  notified?: string;
  min?: number;
  max?: number | null;
  /** Why a person should look at this row before anyone relies on it. */
  doubts: string[];
}

const DATE = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})\b/;
/** The House form's amount columns, left to right (A–K). */
export const AMOUNTS: [number, number | null][] = [
  [1_001, 15_000], [15_001, 50_000], [50_001, 100_000], [100_001, 250_000], [250_001, 500_000],
  [500_001, 1_000_000], [1_000_001, 5_000_000], [5_000_001, 25_000_000], [25_000_001, 50_000_000],
  [50_000_001, null], [1_000_001, null],
];
const OWNERS: Record<string, ScannedTrade["owner"]> = { SP: "spouse", JT: "joint", DC: "child" };

export function isoDate(s: string) {
  const m = s.replace(/[Oo]/g, "0").match(DATE);
  if (!m) return undefined;
  let y = Number(m[3]);
  if (y < 100) y += 2000;
  const mo = Number(m[1]), d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2015 || y > 2027) return undefined;
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : 0;
};

/** Which grid cell a word sits in (by its center), or -1. */
function cellOf(lines: number[], v: number) {
  for (let i = 0; i < lines.length - 1; i++) if (v >= lines[i]! && v < lines[i + 1]!) return i;
  return -1;
}

/**
 * The marked cell in a group of columns. Each cell is judged against the
 * lower of its column's typical ink on the page (printed boxes aren't empty)
 * and the row's typical ink across the group (when every row is a purchase,
 * the purchase column's typical cell is itself marked).
 */
function marked(row: number[], cols: number[], base: number[]) {
  const rowBase = median(cols.map((c) => row[c] ?? 0));
  const excess = cols.map((c) => (row[c] ?? 0) - Math.min(base[c] ?? 0, rowBase));
  const order = excess.map((e, i) => [e, i] as const).sort((a, b) => b[0] - a[0]);
  const [best, second] = [order[0], order[1]];
  // A typed x in a small font is a few percent ink; empty cells are near zero.
  if (!best || best[0] < 0.012) return { index: -1, doubt: "no mark found" };
  if (second && second[0] > 0.012 && second[0] > best[0] * 0.5) return { index: best[1], doubt: "two marks" };
  return { index: best[1] };
}

/**
 * Where the amount columns A–K sit, from the letters printed over them, when
 * OCR reads enough of them. Faint or dashed rules can hide the lines between
 * columns, but the letters stay put. Returns each column's center and width.
 */
function letterColumns(words: Word[], left: number, top: number, bottom: number) {
  const at = new Map<number, number[]>();
  for (const w of words) {
    const t = w.t.replace(/\s+/g, "");
    const yc = (w.y0 + w.y1) / 2;
    if (!/^[A-K]+$/.test(t) || t.length > 11 || yc < top || yc > bottom || w.x0 < left) continue;
    const step = (w.x1 - w.x0) / t.length;
    [...t].forEach((ch, i) => at.set(ch.charCodeAt(0) - 65, [...(at.get(ch.charCodeAt(0) - 65) ?? []), w.x0 + step * (i + 0.5)]));
  }
  const known = [...at].map(([i, xs]) => [i, median(xs)] as const).sort((a, b) => a[0] - b[0]);
  // Letters must run left to right in order, and enough of them must be read.
  if (known.length < 5 || known.some(([, x], k) => k > 0 && x <= known[k - 1]![1])) return undefined;
  const centers = Array.from({ length: 11 }, (_, i) => {
    const exact = known.find(([j]) => j === i);
    if (exact) return exact[1];
    const before = [...known].reverse().find(([j]) => j < i);
    const after = known.find(([j]) => j > i);
    if (before && after) return before[1] + ((after[1] - before[1]) * (i - before[0])) / (after[0] - before[0]);
    const [a, b] = before ? [known.at(-2)!, known.at(-1)!] : [known[0]!, known[1]!];
    return a[1] + ((b[1] - a[1]) / (b[0] - a[0])) * (i - a[0]);
  });
  return centers.map((c, i) => {
    const gap = Math.min(i > 0 ? c - centers[i - 1]! : Infinity, i < 10 ? centers[i + 1]! - c : Infinity);
    return { center: c, half: gap * 0.35 };
  });
}

/** Mean ink in a band's profile between two page positions. */
function profileInk(profile: number[], x0: number, x1: number) {
  const a = Math.max(0, Math.floor(x0 * profile.length)), b = Math.min(profile.length, Math.ceil(x1 * profile.length));
  let sum = 0;
  for (let i = a; i < b; i++) sum += profile[i]!;
  return b > a ? sum / (b - a) : 0;
}

export function parseScannedPtr(pages: ScanPage[]): { trades: ScannedTrade[]; skipped: { page: number; why: string }[] } {
  const trades: ScannedTrade[] = [];
  const skipped: { page: number; why: string }[] = [];
  let account: string | undefined;

  for (const p of pages) {
    const { vlines: xs, hlines: ys } = p;
    if (xs.length < 8 || ys.length < 3) {
      skipped.push({ page: p.page, why: "no table grid" });
      continue;
    }
    // Words by cell.
    const cells = new Map<string, Word[]>();
    for (const w of p.words) {
      const c = cellOf(xs, (w.x0 + w.x1) / 2), r = cellOf(ys, (w.y0 + w.y1) / 2);
      if (c < 0 || r < 0) continue;
      const k = `${r}:${c}`;
      cells.set(k, [...(cells.get(k) ?? []), w]);
    }
    const text = (r: number, c: number) => (cells.get(`${r}:${c}`) ?? []).map((w) => w.t).join(" ").trim();
    const rowText = (r: number) => Array.from({ length: xs.length - 1 }, (_, c) => text(r, c)).join(" ");

    // Date columns: the two columns that hold the most dates.
    const dateCount = new Map<number, number>();
    for (let r = 0; r < ys.length - 1; r++)
      for (let c = 0; c < xs.length - 1; c++) if (isoDate(text(r, c))) dateCount.set(c, (dateCount.get(c) ?? 0) + 1);
    const dateCols = [...dateCount].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([c]) => c).sort((a, b) => a - b);
    if (dateCols.length < 2 || dateCols[1]! - dateCols[0]! !== 1) {
      skipped.push({ page: p.page, why: dateCount.size ? "can't find the two date columns" : "no dates on page" });
      continue;
    }
    const [tradeCol, notifiedCol] = dateCols as [number, number];

    // Data rows: rows with a trade or notification date, skipping the form's printed example (dated 2012–2015).
    const rows: number[] = [];
    for (let r = 0; r < ys.length - 1; r++) {
      const d = isoDate(text(r, tradeCol)) ?? isoDate(text(r, notifiedCol));
      if (d && d >= "2020" && !/example/i.test(rowText(r))) rows.push(r);
    }

    // Asset name: the widest column left of the transaction checkboxes.
    const leftCols = Array.from({ length: tradeCol }, (_, c) => c);
    const nameCol = leftCols.reduce((best, c) => (xs[c + 1]! - xs[c]! > xs[best + 1]! - xs[best]! ? c : best), 0);
    const txCols = leftCols.filter((c) => c > nameCol);
    // Amount columns: everything right of the dates, less slivers from page edges and doubled rules.
    let amountCols = Array.from({ length: xs.length - 1 - notifiedCol - 1 }, (_, i) => notifiedCol + 1 + i);
    const width = (c: number) => xs[c + 1]! - xs[c]!;
    const typical = median(amountCols.map(width));
    amountCols = amountCols.filter((c) => width(c) > typical * 0.6);

    // Transaction columns, by header words where Vision read them, else by the form's order.
    const header = (c: number) =>
      p.words
        .filter((w) => (w.x0 + w.x1) / 2 >= xs[c]! && (w.x0 + w.x1) / 2 < xs[c + 1]! && w.y1 <= ys[rows[0] ?? 1]!)
        .map((w) => w.t)
        .join(" ");
    const txNames = txCols.map((c, i) => {
      const h = header(c);
      if (/partial/i.test(h)) return "Sold some";
      if (/exch/i.test(h)) return "Exchanged";
      if (/sa[l1]e|sale|saske/i.test(h)) return "Sold";
      if (/purch/i.test(h)) return "Bought";
      if (/capit|gain|\$200/i.test(h)) return "capital gains";
      return (txCols.length === 4 ? ["Bought", "Sold", "Sold some", "Exchanged"] : ["Bought", "Sold", "Exchanged", "capital gains", "Sold some"])[i] ?? "?";
    });
    const typeCols = txCols.filter((_, i) => txNames[i] !== "capital gains");
    // Khanna's form adds a "Partial transaction" column that qualifies a sale.
    const partialCol = txCols.find((_, i) => txNames[i] === "Sold some" && txCols.length === 5);
    // A lost rule merges two boxes into one column ("Sale Exchange"), and the
    // mark can't be told apart: every row's type is in doubt.
    const TX_WORDS = [/partial/i, /exch/i, /sa[l1]e|saske/i, /purch/i, /capit|gain|\$200/i];
    const txMerged =
      txCols.some((c) => TX_WORDS.filter((r) => r.test(header(c))).length > 1) ||
      new Set(txNames.filter((n) => n !== "capital gains")).size < typeCols.length;

    // Rows are the trade dates themselves: scans lose many row rules, so a
    // ruled "row" can hold two trades. Each date's band carries its own ink.
    const inCol = (x0: number, x1: number, c: number) => (x0 + x1) / 2 >= xs[c]! && (x0 + x1) / 2 < xs[c + 1]!;
    // By left edge: Vision sometimes reads both dates as one word ("05/27/26 06/08/26").
    const startsIn = (x0: number, c: number) => x0 >= xs[c]! - 0.01 && x0 < xs[c + 1]!;
    const tradeBands = p.bands.filter((b) => startsIn(b.x0, tradeCol)).sort((a, b) => a.y0 - b.y0);
    const dateWordOf = (b: Band) =>
      p.words.find((w) => startsIn(w.x0, tradeCol) && Math.abs((w.y0 + w.y1) / 2 - (b.y0 + b.y1) / 2) < 0.004);
    const dateWord = (b: Band) => dateWordOf(b)?.t ?? "";
    const dateOf = (b: Band) => isoDate(dateWord(b));
    /** The readings of the trade date don't all agree. */
    const dateUnclear = (b: Band) => (dateWordOf(b)?.reads ?? []).some((a) => isoDate(a) !== dateOf(b));
    // Use the ruled cell when it holds just this trade (more ink to read);
    // the date's own band when lost rules leave several trades in one cell.
    const gridRow = (b: Band) => cellOf(ys, (b.y0 + b.y1) / 2);
    const perRow = new Map<number, number>();
    for (const b of tradeBands) perRow.set(gridRow(b), (perRow.get(gridRow(b)) ?? 0) + 1);
    const inkOf = (b: Band) => (perRow.get(gridRow(b)) === 1 && p.ink[gridRow(b)] ? p.ink[gridRow(b)]! : b.ink);
    const base = (xs.slice(0, -1) as number[]).map((_, c) => median(tradeBands.map((b) => inkOf(b)[c] ?? 0)));

    // Amount columns by their letters, measured in each band's ink profile.
    const firstBand = tradeBands[0];
    const letters = firstBand?.profile ? letterColumns(p.words, xs[notifiedCol + 1]! - 0.01, 0, firstBand.y0) : undefined;
    const letterInk = (b: Band) => letters!.map((l) => profileInk(b.profile!, l.center - l.half, l.center + l.half));
    const letterBase = letters ? letters.map((_, i) => median(tradeBands.map((b) => letterInk(b)[i]!))) : [];

    // Each line in the name column belongs to the first date at or below it;
    // lines far above that date (more than two lines) are a heading instead.
    const nameLines = new Map<Band, Word[]>();
    const headings = new Map<Band, Word[]>();
    const headerBottom = rows.length ? ys[Math.max(0, rows[0]! - 1)]! : 0;
    // A lost rule between the owner and name columns leaves the tags at the
    // name column's left edge, as words of their own.
    const TAG = /^(?:[S5$]P|D[CO0]|J[T1])$/;
    const tagWords: Word[] = [];
    for (const w of p.words.filter((w) => inCol(w.x0, w.x1, nameCol) && (w.y0 + w.y1) / 2 > headerBottom)) {
      const yc = (w.y0 + w.y1) / 2;
      if (TAG.test(w.t) && w.x1 < xs[nameCol]! + 0.03) {
        tagWords.push(w);
        continue;
      }
      // Bands are padded and overlap on tight forms, so go by centers.
      const b = tradeBands.find((b) => (b.y0 + b.y1) / 2 >= yc - (b.y1 - b.y0) / 1.7 * 0.6);
      if (!b) continue;
      const lineH = (b.y1 - b.y0) / 1.7;
      // A line in a ruled row with no trade in it (a trust's name in a shaded bar) is a heading.
      const ruled = cellOf(ys, yc);
      const ownRow = ys.length < 5 || ruled < 0 || perRow.has(ruled);
      const target = ownRow && yc >= b.y0 - lineH * 2.2 ? nameLines : headings;
      target.set(b, [...(target.get(b) ?? []), w]);
    }

    for (const b of tradeBands) {
      const date = dateOf(b);
      const lineH = (b.y1 - b.y0) / 1.7;
      const mid = (b.y0 + b.y1) / 2;
      const sortWords = (ws: Word[]) => [...ws].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
      const heading = sortWords(headings.get(b) ?? []).map((w) => w.t).join(" ").replace(/provide [^,]*name.*?symbol\.?/i, "").trim();
      if (heading && !/example|asset name|nothing to report|full nam|prov[a-z]* full|symbo|ticker/i.test(heading)) account = heading;
      const nameWords = sortWords(nameLines.get(b) ?? []);
      const asset = nameWords.map((w) => w.t).join(" ").trim();
      if (!date || date < "2020" || /example/i.test(asset)) continue;

      const doubts: string[] = [];
      const ink = inkOf(b);
      const choices = typeCols.filter((c) => c !== partialCol);
      const tx = marked(ink, choices, base);
      // The ruled columns read best when the line finder got them all; the
      // letter windows are the fallback when it didn't, or when they're unsure.
      // Too many ruled columns (a page edge, a doubled rule): keep the one under each letter.
      const underLetters =
        letters && amountCols.length > 11
          ? letters.map((l) => amountCols.reduce((best, c) => (Math.abs((xs[c]! + xs[c + 1]!) / 2 - l.center) < Math.abs((xs[best]! + xs[best + 1]!) / 2 - l.center) ? c : best)))
          : undefined;
      const cols = underLetters && new Set(underLetters).size === 11 ? underLetters : amountCols;
      const ruledOk = cols.length === 11 || cols.length === 10;
      const ruled = ruledOk ? marked(ink, cols.slice(0, AMOUNTS.length), base) : undefined;
      const byLetter = letters && b.profile ? marked(letterInk(b), letters.map((_, i) => i), letterBase) : undefined;
      const amt = ruled && !ruled.doubt ? ruled : byLetter && !byLetter.doubt ? byLetter : (ruled ?? byLetter ?? { index: -1, doubt: "no amount columns" });
      if (txMerged) doubts.push("type: columns merged");
      else if (tx.doubt) doubts.push(`type: ${tx.doubt}`);
      if (amt.doubt) doubts.push(`amount: ${amt.doubt}`);
      if (!ruledOk && !(byLetter && !byLetter.doubt)) doubts.push(`${amountCols.length} amount columns`);
      let txName = tx.index >= 0 ? txNames[txCols.indexOf(choices[tx.index]!)] : undefined;
      // Against the row's empty type boxes too: when every sale on a page is
      // partial, the column's median is itself a mark.
      const emptyBox = Math.min(base[partialCol ?? 0] ?? 0, median(choices.map((c) => ink[c] ?? 0)));
      if (partialCol !== undefined && txName === "Sold" && (ink[partialCol] ?? 0) - emptyBox > 0.012) txName = "Sold some";
      const range = amt.index >= 0 ? AMOUNTS[amt.index] : undefined;
      if (nameWords.some((w) => w.c < 0.5)) doubts.push("asset name read with low confidence");
      if (!asset) doubts.push("no asset name");
      // Anywhere left of the name column: stray rules sometimes split the owner column.
      const owner = [...p.words.filter((w) => (w.x0 + w.x1) / 2 < xs[nameCol]!), ...tagWords]
        .filter((w) => Math.abs((w.y0 + w.y1) / 2 - mid) < lineH * 1.5)
        .map((w) => w.t)
        .join("")
        .toUpperCase()
        .replace(/[^A-Z0-9$]/g, "");
      const merged = dateWord(b).split(/\s+/)[1];
      const notifiedWord = p.words.find((w) => startsIn(w.x0, notifiedCol) && Math.abs((w.y0 + w.y1) / 2 - mid) < lineH)?.t ?? merged;
      const notifiedDate = notifiedWord ? isoDate(notifiedWord) : undefined;
      if (notifiedDate && notifiedDate < date) doubts.push("notified before the trade date");
      // A misread year or month shows up as a long gap; real late reports do too, so check either way.
      if (notifiedDate && Date.parse(notifiedDate) - Date.parse(date) > 90 * 864e5) doubts.push("over 90 days between trade and notification");
      if (dateUnclear(b)) doubts.push("trade date unclear");
      // Markets are closed on weekends, and a misread digit often lands on one
      // (06/02/26, a Tuesday, read as 05/02/26, a Saturday).
      if (date && [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay())) doubts.push("trade date falls on a weekend");
      // OCR misreads the tags ("5P", "$P", "SE"), so match loosely, and flag what can't be matched rather than calling it the member's.
      const ownerTag = /^[S5$][PRF]?/.test(owner) ? "SP" : /^D[CGO0]?/.test(owner) ? "DC" : /^[JI][T1]?/.test(owner) ? "JT" : owner;
      if (owner && !OWNERS[ownerTag]) doubts.push("owner unclear");
      trades.push({
        page: p.page,
        owner: OWNERS[ownerTag] ?? "self",
        asset,
        ...(account ? { account } : {}),
        tx: txName,
        date,
        notified: notifiedDate,
        ...(range ? { min: range[0], max: range[1] } : {}),
        doubts,
      });
    }
  }
  return { trades, skipped };
}
