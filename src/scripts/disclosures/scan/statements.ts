// Year-end holdings from brokerage statements that members attach to paper
// annual reports instead of listing each asset ("See attached").
//
// Edward Jones (Rep. Harold Rogers attaches a year of them) and JPMorgan
// (Rep. Vicente Gonzalez attaches a year-end statement). Each parse has to add
// up to the statement's own totals, to the cent, or the account is left out.
// Statements give exact values; the site shows only the Schedule A range each
// value falls in, and never keeps account numbers or addresses.
//
//   tsx src/scripts/disclosures/scan/statements.ts
import fs from "fs";
import { CACHE } from "../common.js";
import type { ScanPage, Word } from "./ptr.js";

export interface StatementHolding {
  page: number;
  broker: string;
  /** "Living trust" or "IRA": the statement's account type, never its number. */
  account: string;
  section: "stock" | "funds" | "cash" | "bonds";
  asset: string;
  ticker?: string;
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
      holdings.push({ page: p.page, broker: "Edward Jones", account, section: section === "money-market" ? "cash" : section, asset, value, doubts });
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

/**
 * JPMorgan: the Holdings pages of a statement whose period ends Dec 31. A
 * position's first line has quantity, price and market value; its description
 * follows ("Symbol FXAIX"), then tax-lot lines, which have no price. Each
 * section closes with "TOTAL EQUITY $145,028.57" and so on.
 */
export function parseJPMorgan(pages: ScanPage[], year: number) {
  const holdings: StatementHolding[] = [];
  const totals: { account: string; total: number; page: number }[] = [];
  const yearEnd = new RegExp(`December\\s*31,?\\s*${year}`);
  const SECTION: Record<string, StatementHolding["section"]> = { "CASH & MONEY MARKETS": "cash", EQUITY: "stock", "FIXED INCOME": "bonds" };
  let section: string | undefined;
  let priceX: number | undefined;
  let valueX: number | undefined;
  let descEnd = 0.19;
  let current: StatementHolding | undefined;
  let desc: string[] = [];
  const finish = () => {
    if (!current) return;
    const ticker = desc.join(" ").match(/Symbol\s+([A-Z]{2,6})\b/)?.[1];
    const words = desc.filter((l) => !/^Symbol\b/.test(l)).join(" ");
    // The description runs on into yield notes: keep the name before "EST" or a yield.
    current.asset = `${current.asset} ${words}`.replace(/\s+(EST\b|YIELD\b|\d[\d ]*\/).*$/, "").replace(/\s+/g, " ").trim();
    if (ticker) current.ticker = ticker;
    if (/\b(FUND|FD|ETF|INDEX|TRUST|TR)\b/.test(current.asset)) current.section = "funds";
    holdings.push(current);
    current = undefined;
    desc = [];
  };
  for (const p of pages) {
    const text = p.words.map((w) => w.t).join(" ");
    if (!/J\s?P\s?Morgan/i.test(text) || !yearEnd.test(text) || !/Holdings|EQUITY|FIXED INCOME|CASH & MONEY/i.test(text)) continue;
    for (const row of lines(p)) {
      const line = row.map((w) => w.t).join(" ").trim();
      const total = line.match(/^TOTAL (CASH & MONEY MARKETS|EQUITY|FIXED INCOME)\s*\$?\s*([\d ,]+)/);
      if (total) {
        finish();
        const t = money(total[2]!);
        if (t) totals.push({ account: total[1]!, total: t, page: p.page });
        continue;
      }
      const head = Object.keys(SECTION).find((k) => line.startsWith(k));
      if (head) {
        finish();
        section = head;
        continue;
      }
      if (row.some((w) => /^Quantity$/i.test(w.t.trim()))) {
        finish();
        priceX = row.find((w) => /^Price$/i.test(w.t.trim()))?.x1;
        // OCR can read two headers as one word ("Market Value Unit Cost"): find
        // where "Market Value" itself ends within it.
        const mv = row.find((w) => /Market\s*Value|^Value$/i.test(w.t.trim()));
        if (mv) {
          const end = mv.t.search(/Value/i) + 5;
          valueX = mv.x0 + ((mv.x1 - mv.x0) * end) / mv.t.length;
        }
        descEnd = (row.find((w) => /^Acquisition/i.test(w.t.trim()))?.x0 ?? 0.2) - 0.005;
        continue;
      }
      if (!section || priceX === undefined || valueX === undefined) continue;
      const name = row.filter((w) => w.x1 <= descEnd + 0.01).map((w) => w.t).join(" ").trim();
      const price = row.find((w) => w.x0 > descEnd && Math.abs(w.x1 - priceX!) < 0.035);
      const value = row.find((w) => w.x0 > descEnd && Math.abs(w.x1 - valueX!) < 0.035);
      // Summary lines and the page footer end a position. ("TOTAL INTL BD INDEX FD" is
      // a fund's name, not a total: totals carry a dollar figure.)
      if (/^(Market Value vs|Cumulative Cash|Investment Gain)/i.test(name) || /^TOTAL\b.*\$/i.test(line) || /large number of tax lots|additional footnotes|Please read the important/i.test(line)) {
        finish();
        continue;
      }
      // A position line: a name, a price and a market value. Tax lots have no
      // price. Cash has no lots, and its price of "1" is too small for OCR to keep.
      if (name && (price || section === "CASH & MONEY MARKETS") && value && /^[A-Z0-9&.' -]+$/.test(name)) {
        finish();
        const v = money(value.t);
        if (v === undefined) continue;
        current = { page: p.page, broker: "JPMorgan", account: section, section: SECTION[section]!, asset: name, value: v, doubts: [] };
        continue;
      }
      if (current && name && !value) desc.push(name);
    }
  }
  finish();
  const checks = totals.map((t) => {
    const sum = holdings.filter((h) => h.account === t.account).reduce((s, h) => s + h.value, 0);
    return { ...t, sum: Math.round(sum * 100) / 100 };
  });
  for (const c of checks)
    if (Math.abs(c.sum - c.total) >= 0.01) for (const h of holdings.filter((h) => h.account === c.account)) h.doubts.push("section doesn't add up to its total");
  for (const a of new Set(holdings.map((h) => h.account)))
    if (!checks.some((c) => c.account === a)) for (const h of holdings.filter((h) => h.account === a)) h.doubts.push("no section total to check against");
  // Sections group a statement; the account is the statement itself.
  for (const h of holdings) h.account = "Brokerage account";
  return { holdings, checks };
}

if (process.argv[1]?.endsWith("statements.ts")) {
  const out = [];
  const runs: [string, string, string, typeof parseEdwardJones][] = [
    // Rep. Harold Rogers: a year of Edward Jones statements for two accounts.
    ["9116232", "R000395", "Edward Jones", parseEdwardJones],
    // Rep. Vicente Gonzalez: a year-end JPMorgan statement (his Attachment 2).
    ["9116230", "G000581", "JPMorgan", parseJPMorgan],
  ];
  for (const [docId, bioguide, broker, parse] of runs) {
    const pages = fs.readFileSync(`${CACHE}/scan/${docId}.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l) as ScanPage);
    const { holdings, checks } = parse(pages, 2025);
    out.push({ docId, bioguide, holdings });
    console.log(`${broker} (${bioguide}): ${holdings.length} holdings, ${holdings.filter((h) => h.doubts.length).length} with doubts`);
    for (const c of checks) console.log(`  ${c.account} (page ${c.page + 1}): statement total $${c.total.toLocaleString()}, parsed sum $${c.sum.toLocaleString()}`);
  }
  fs.writeFileSync(`${CACHE}/scan/statements.json`, JSON.stringify(out));
}

/** One line of an Edward Jones statement's activity: "11/24 Sell AT&T Inc @ 25.51 481 12,270.31". */
export interface StatementTrade {
  date: string;
  tx: "Bought" | "Sold";
  asset: string;
  amount: number;
  /** The price as printed, digits only ("47342" for 473.42), for matching a trade report that quotes it. */
  price?: string;
  page: number;
}

/**
 * Buys, sells and redemptions from a year of Edward Jones statements. OCR
 * drops commas and decimal points, so price, quantity and amount run together
 * ("@ 25 51 481 12 270 31"); the split that makes price × quantity equal the
 * amount is the right one.
 */
/**
 * The statement line for a trade report row that quotes its price ("Sell Vng
 * Growth Index @ 473.42"): same date, same direction, same price.
 */
export function matchStatementTrade(st: StatementTrade[], t: { date?: string; tx?: string; asset: string }) {
  const quoted = t.asset.match(/@\s*([\d.]+)/)?.[1]?.replace(/\D/g, "").replace(/0+$/, "");
  if (!quoted || !t.date) return undefined;
  const hits = st.filter(
    (x) => x.date === t.date && (!t.tx || (t.tx === "Bought") === (x.tx === "Bought")) && x.price?.replace(/0+$/, "").startsWith(quoted)
  );
  return hits.length === 1 ? hits[0] : undefined;
}

export function parseEdwardJonesActivity(pages: ScanPage[], year: number): StatementTrade[] {
  const out: StatementTrade[] = [];
  for (const p of pages) {
    const text = p.words.map((w) => w.t).join(" ");
    if (!/Edward\s*Jones/i.test(text)) continue;
    for (const row of lines(p)) {
      const line = row.map((w) => w.t).join(" ").trim();
      const m = line.match(/^(\d{1,2})\/(\d{2})\/?\s+(Sell|Buy|Redeemed)\s+(.+)$/);
      if (!m) continue;
      const [, mo, d, verb, rest] = m;
      const date = `${year}-${mo!.padStart(2, "0")}-${d}`;
      let asset = rest!;
      let amount: number | undefined;
      let price: string | undefined;
      const at = rest!.match(/^(.*?)\s+@\s+(.*?)(\s+as of [\d/]+)?\s+([\d ]+)$/);
      if (at) {
        asset = at[1]!;
        price = `${at[2]} ${at[4]}`.trim().split(/\s+/).slice(0, 2).join("");
        const tokens = [...at[2]!.split(/\s+/), ...at[4]!.trim().split(/\s+/)].filter((t) => /^\d+$/.test(t));
        // Try every split into price | quantity | amount.
        search: for (let i = 1; i < tokens.length - 1; i++)
          for (let j = i + 1; j < tokens.length; j++) {
            const value = money(tokens.slice(j).join(" "));
            if (!value) continue;
            for (const price of readings(tokens.slice(0, i).join("")))
              for (const qty of readings(tokens.slice(i, j).join("")))
                if (Math.abs(price * qty - value) <= Math.max(0.01 * value, 1)) {
                  amount = value;
                  break search;
                }
          }
      } else {
        // "Redeemed ... Matured Security 10 000 10 000 00": the last figure is the proceeds.
        const tail = rest!.match(/(\d{1,3}(?:\s\d{3})*\s\d{2})$/);
        asset = rest!.replace(/\s+\d[\d ]*$/, "");
        if (tail) amount = money(tail[1]!);
      }
      if (amount) out.push({ date, tx: verb === "Buy" ? "Bought" : "Sold", asset: asset.trim(), amount, ...(price ? { price } : {}), page: p.page });
    }
  }
  return out;
}
