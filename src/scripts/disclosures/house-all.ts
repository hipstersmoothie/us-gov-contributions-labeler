// Fetch and parse every current House member's CY2025 annual report and
// 2025-26 PTRs, to measure a full ingest and feed the prototype pages.
//
//   tsx src/scripts/disclosures/house-all.ts
import { cachedFetch, writeJson } from "./common.js";
import { loadHouseIndex, type HouseFiling } from "./house-index.js";
import { pdfText } from "./pdf.js";
import { parseAnnualAssets, parsePtr, type Holding, type Trade } from "./house-parse.js";

const pdfUrl = (f: HouseFiling) =>
  `https://disclosures-clerk.house.gov/public_disc/${f.type === "P" ? "ptr-pdfs" : "financial-pdfs"}/${f.year}/${f.docId}.pdf`;

const index = await loadHouseIndex();
const wanted = index.filter(
  (f) => f.bioguide && ((f.year === 2025 && (f.type === "O" || f.type === "A")) || (f.year >= 2025 && f.type === "P"))
);
console.log(`${wanted.length} filings`);

export interface Parsed {
  filing: HouseFiling;
  bytes: number;
  pages: number;
  text: boolean;
  holdings?: Holding[];
  trades?: Trade[];
  error?: string;
}

const out: Parsed[] = [];
const started = Date.now();
let fetched = 0;
for (const [i, f] of wanted.entries()) {
  try {
    const t0 = Date.now();
    const buf = await cachedFetch(pdfUrl(f), `house/pdf/${f.docId}.pdf`);
    if (Date.now() - t0 > 100) fetched++;
    const text = await pdfText(buf);
    const hasText = text.chars / text.pages > 150;
    const p: Parsed = { filing: f, bytes: buf.length, pages: text.pages, text: hasText };
    if (hasText && f.type === "P") p.trades = parsePtr(text);
    if (hasText && f.type !== "P") p.holdings = parseAnnualAssets(text);
    out.push(p);
  } catch (e) {
    out.push({ filing: f, bytes: 0, pages: 0, text: false, error: String(e) });
  }
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${wanted.length}, ${fetched} fetched, ${Math.round((Date.now() - started) / 1000)}s`);
}
writeJson("house/all.json", out);
const mb = out.reduce((s, p) => s + p.bytes, 0) / 1e6;
console.log(`done: ${Math.round((Date.now() - started) / 1000)}s, ${fetched} fetched, ${mb.toFixed(0)} MB of PDFs`);
