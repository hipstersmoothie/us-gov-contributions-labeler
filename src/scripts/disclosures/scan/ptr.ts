// Turn analyzed pages of a scanned paper PTR (scan/analyze.swift) into trades.
//
// Paper PTRs are grids: owner, asset, a checkbox per transaction type, two
// dates, then a checkbox per amount range. Rows are the bands between ruling
// lines that hold a date; a checkbox is "marked" when its cell has clearly
// more ink than that column's empty cells on the same page.
export interface Word { t: string; x0: number; y0: number; x1: number; y1: number; c: number; reads?: string[] }
export interface Band { x0: number; x1: number; y0: number; y1: number; ink: number[] }
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
const AMOUNTS: [number, number | null][] = [
  [1_001, 15_000], [15_001, 50_000], [50_001, 100_000], [100_001, 250_000], [250_001, 500_000],
  [500_001, 1_000_000], [1_000_001, 5_000_000], [5_000_001, 25_000_000], [25_000_001, 50_000_000],
  [50_000_001, null], [1_000_001, null],
];
const OWNERS: Record<string, ScannedTrade["owner"]> = { SP: "spouse", JT: "joint", DC: "child" };

function isoDate(s: string) {
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

    // Each line in the name column belongs to the first date at or below it;
    // lines far above that date (more than two lines) are a heading instead.
    const nameLines = new Map<Band, Word[]>();
    const headings = new Map<Band, Word[]>();
    const headerBottom = rows.length ? ys[Math.max(0, rows[0]! - 1)]! : 0;
    for (const w of p.words.filter((w) => inCol(w.x0, w.x1, nameCol) && (w.y0 + w.y1) / 2 > headerBottom)) {
      const yc = (w.y0 + w.y1) / 2;
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
      const amt = marked(ink, amountCols.slice(0, AMOUNTS.length), base);
      if (tx.doubt) doubts.push(`type: ${tx.doubt}`);
      if (amt.doubt) doubts.push(`amount: ${amt.doubt}`);
      if (amountCols.length !== 11 && amountCols.length !== 10) doubts.push(`${amountCols.length} amount columns`);
      let txName = tx.index >= 0 ? txNames[txCols.indexOf(choices[tx.index]!)] : undefined;
      if (partialCol !== undefined && txName === "Sold" && (ink[partialCol] ?? 0) - (base[partialCol] ?? 0) > 0.012) txName = "Sold some";
      const range = amt.index >= 0 ? AMOUNTS[amt.index] : undefined;
      if (nameWords.some((w) => w.c < 0.5)) doubts.push("asset name read with low confidence");
      if (!asset) doubts.push("no asset name");
      // Anywhere left of the name column: stray rules sometimes split the owner column.
      const owner = p.words
        .filter((w) => (w.x0 + w.x1) / 2 < xs[nameCol]! && Math.abs((w.y0 + w.y1) / 2 - mid) < lineH * 1.5)
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
