// Year-end holdings from brokerage statements that members attach to paper
// annual reports instead of listing each asset ("See attached").
//
// Only Edward Jones statements so far (Rep. Harold Rogers attaches a year of
// them). Statements give exact values; the site shows only the Schedule A
// range each value falls in, and never keeps account numbers or addresses.
//
//   tsx src/scripts/disclosures/scan/statements.ts
import fs from "fs";
import { CACHE } from "../common.js";
import type { ScanPage, Word } from "./ptr.js";

export interface StatementHolding {
  page: number;
  /** "Living trust" or "IRA": the statement's account type, never its number. */
  account: string;
  section: "stock" | "funds" | "cash" | "bonds";
  asset: string;
  value: number;
  doubts: string[];
}

/** Schedule A's value categories, for turning an exact value into the range a filer would have reported. */
export const RANGES: [number, number | null][] = [
  [1, 1_000], [1_001, 15_000], [15_001, 50_000], [50_001, 100_000], [100_001, 250_000], [250_001, 500_000],
  [500_001, 1_000_000], [1_000_001, 5_000_000], [5_000_001, 25_000_000], [25_000_001, 50_000_000], [50_000_001, null],
];
export function rangeOf(value: number) {
  const v = Math.round(value);
  return RANGES.find(([lo, hi]) => v >= lo && (hi === null || v <= hi)) ?? RANGES[0]!;
}

/** "26 098 56" (OCR loses commas and the decimal point) -> 26098.56. Values always print cents. */
function money(s: string) {
  const digits = s.replace(/[$,.\s]/g, "");
  return /^\d{3,}$/.test(digits) ? Number(digits) / 100 : undefined;
}
/** A price or quantity with an unknown number of decimals: every reading. */
function readings(s: string) {
  const digits = s.replace(/[$,.\s]/g, "");
  if (!/^\d+$/.test(digits)) return [];
  return Array.from({ length: Math.min(6, digits.length) }, (_, k) => Number(digits) / 10 ** k);
}

const SECTIONS: [RegExp, StatementHolding["section"]][] = [
  [/^Stocks\b/i, "stock"],
  [/^(Mutual Funds|Exchange Traded)/i, "funds"],
  [/Municipal Bonds|^Government|^Treasur/i, "cash"],
  [/^(Corporate Bonds|Fixed Income|Bonds)/i, "bonds"],
];

function lines(p: ScanPage) {
  const rows: Word[][] = [];
  for (const w of [...p.words].sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2)) {
    const row = rows.find((r) => Math.abs((r[0]!.y0 + r[0]!.y1) / 2 - (w.y0 + w.y1) / 2) < 0.006);
    if (row) row.push(w);
    else rows.push([w]);
  }
  return rows.map((r) => r.sort((a, b) => a.x0 - b.x0));
}

/** Edward Jones: the "Asset Details" pages of the statement dated through Dec 31. */
export function parseEdwardJones(pages: ScanPage[], year: number) {
  const holdings: StatementHolding[] = [];
  const totals: { account: string; total: number; page: number }[] = [];
  const yearEnd = new RegExp(`Dec\\s*31,?\\s*${year}`);
  let account = "";
  for (const p of pages) {
    const text = p.words.map((w) => w.t).join(" ");
    if (!/Edward\s*Jones/i.test(text) || !yearEnd.test(text)) continue;
    if (/Account Holder\(s\)[^A-Z]*Harold Rogers TTEE/i.test(text) || /TTEE/.test(text)) account = "Living trust";
    else if (/Account Holder/.test(text)) account = "IRA";
    if (!/Asset Details/i.test(text)) continue;

    let section: StatementHolding["section"] | "money-market" | undefined;
    let valueX: number | undefined; // right edge of the Value column
    let priceX: number | undefined; // right edge of the Price column
    let nameEnd = 0.32; // names sit left of the first numeric column
    let pendingName: string[] = [];
    let prevLine = "";
    for (const row of lines(p)) {
      const line = row.map((w) => w.t).join(" ").trim();
      if (/^Total Account Value/i.test(line)) {
        const t = money(row.slice(1).map((w) => w.t).join(" ").replace(/^[^$\d]*/, ""));
        if (t) totals.push({ account, total: t, page: p.page });
        continue;
      }
      const header = SECTIONS.find(([re]) => re.test(line));
      // OCR may split "Ending Balance" into two words.
      const valueHeader = row.find((w) => /^(Value|Ending Balance|Balance)$/i.test(w.t.trim()) && w === row.filter((x) => /Value|Balance/i.test(x.t)).at(-1));
      if (valueHeader) {
        valueX = valueHeader.x1;
        const firstNumCol = row.find((w) => /^(Price|Maturity Date|Beginning Balance|Beginning)$/i.test(w.t.trim()));
        if (firstNumCol) nameEnd = firstNumCol.x0 - 0.01;
        priceX = row.find((w) => /^Price$/i.test(w.t.trim()))?.x1;
        if (/Beginning/i.test(line)) section = "money-market";
        if (header) section = header[1] === "bonds" && /Municipal/i.test(prevLine + " " + line) ? "cash" : header[1];
        pendingName = [];
        continue;
      }
      if (header) {
        // "Federally Tax Exempt Municipal" / "Bonds" wraps: municipal bonds are government debt.
        section = header[1] === "bonds" && /Municipal/i.test(prevLine + " " + line) ? "cash" : header[1];
        pendingName = [];
        prevLine = line;
        continue;
      }
      prevLine = line;
      if (!section || valueX === undefined) continue;

      const name = row.filter((w) => w.x1 <= nameEnd + 0.02).map((w) => w.t).join(" ").trim();
      const nums = row.filter((w) => w.x0 > nameEnd - 0.02);
      // The value is the number right-aligned under the Value header.
      const valueWord = nums.find((w) => Math.abs(w.x1 - valueX!) < 0.03);
      if (!valueWord) {
        // A name that wraps onto two lines ("New York St Rev Rfdg Ser 2016A" / "5.00%").
        if (name && !nums.length) pendingName.push(name);
        continue;
      }
      const asset = [...pendingName, name].join(" ").replace(/\s+\d[\d\s]*\/\s*$/, "").trim();
      pendingName = [];
      const value = money(valueWord.t);
      if (!asset || value === undefined) continue;
      const doubts: string[] = [];
      if (section === "stock" || section === "funds") {
        // Check the value against price × quantity, whatever their decimals.
        // Price is right-aligned under its header; OCR can split it ("7 292" "77").
        const others = nums.filter((w) => w !== valueWord && w.x1 < valueWord.x0);
        const priceWords = priceX === undefined ? others.slice(0, 1) : others.filter((w) => w.x1 <= priceX! + 0.02);
        const qtyWords = others.filter((w) => !priceWords.includes(w));
        const price = priceWords.map((w) => w.t).join(" ");
        const qty = qtyWords.map((w) => w.t).join(" ");
        const ok =
          price && qty && readings(price).some((pr) => readings(qty).some((q) => Math.abs(pr * q - value) <= Math.max(0.02 * value, 1)));
        if (!ok) doubts.push("value doesn't match price × quantity");
      }
      holdings.push({ page: p.page, account, section: section === "money-market" ? "cash" : section, asset, value, doubts });
    }
  }
  // Each account's values should add up to its total. When they do to the
  // cent, every value in it is confirmed, whatever the price × quantity check said.
  const checks = totals.map((t) => {
    const sum = holdings.filter((h) => h.account === t.account).reduce((s, h) => s + h.value, 0);
    return { ...t, sum: Math.round(sum * 100) / 100 };
  });
  for (const c of checks) {
    if (Math.abs(c.sum - c.total) >= 0.01) {
      for (const h of holdings.filter((h) => h.account === c.account)) h.doubts.push("account doesn't add up to its total");
      continue;
    }
    for (const h of holdings.filter((h) => h.account === c.account)) h.doubts = h.doubts.filter((d) => !d.startsWith("value doesn't match"));
  }
  for (const a of new Set(holdings.map((h) => h.account)))
    if (!checks.some((c) => c.account === a)) for (const h of holdings.filter((h) => h.account === a)) h.doubts.push("no account total to check against");
  return { holdings, checks };
}

if (process.argv[1]?.endsWith("statements.ts")) {
  // Rep. Harold Rogers (R000395), 2025 annual report filed on paper.
  const docId = "9116232";
  const pages = fs.readFileSync(`${CACHE}/scan/${docId}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ScanPage);
  const { holdings, checks } = parseEdwardJones(pages, 2025);
  fs.writeFileSync(`${CACHE}/scan/statements.json`, JSON.stringify([{ docId, bioguide: "R000395", holdings }]));
  console.log(`${holdings.length} holdings, ${holdings.filter((h) => h.doubts.length).length} with doubts`);
  for (const c of checks) console.log(`  ${c.account} (page ${c.page + 1}): statement total $${c.total.toLocaleString()}, parsed sum $${c.sum.toLocaleString()}`);
  const by: Record<string, number> = {};
  for (const h of holdings) by[`${h.account} ${h.section}`] = (by[`${h.account} ${h.section}`] ?? 0) + 1;
  console.log(by);
  for (const h of holdings.filter((h) => h.doubts.length)) console.log("  doubt:", h.page, h.asset, h.value, h.doubts.join(", "));
}
