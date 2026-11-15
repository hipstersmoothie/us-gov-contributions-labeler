// Download a sample of House disclosure PDFs, measure how many have a text
// layer, and parse the e-filed ones.
//
//   tsx src/scripts/disclosures/house-sample.ts
import { cachedFetch, writeJson } from "./common.js";
import { loadHouseIndex, type HouseFiling } from "./house-index.js";
import { pdfText } from "./pdf.js";
import { parseAnnualAssets, parsePtr, type Holding, type Trade } from "./house-parse.js";

// Both parties; heavy traders, paper filers and members with few holdings.
const NAMED = [
  "P000197", // Pelosi (D-CA)
  "G000583", // Gottheimer (D-NJ)
  "K000389", // Khanna (D-CA), paper
  "W000797", // Wasserman Schultz (D-FL)
  "M001217", // Moskowitz (D-FL)
  "O000172", // Ocasio-Cortez (D-NY)
  "M001157", // McCaul (R-TX), paper
  "F000459", // Fleischmann (R-TN), paper
  "B001327", // Bresnahan (R-PA)
  "H001082", // Hern (R-OK)
  "D000032", // Donalds (R-FL)
  "J000289", // Jordan (R-OH)
];

// Deterministic shuffle so reruns hit the cache.
function sample<T>(xs: T[], n: number, seed = 7) {
  const a = [...xs];
  let s = seed;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 9301 + 49297) % 233280;
    const j = Math.floor((s / 233280) * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a.slice(0, n);
}

const pdfUrl = (f: HouseFiling) =>
  `https://disclosures-clerk.house.gov/public_disc/${f.type === "P" ? "ptr-pdfs" : "financial-pdfs"}/${f.year}/${f.docId}.pdf`;

const index = await loadHouseIndex();
const members = index.filter((f) => f.bioguide);

const picked = new Map<string, HouseFiling & { why: string }>();
for (const id of NAMED) {
  const mine = members.filter((f) => f.bioguide === id);
  for (const f of mine.filter((f) => f.year === 2025 && f.type === "O")) picked.set(f.docId, { ...f, why: "named" });
  for (const f of mine.filter((f) => f.type === "A" && f.year >= 2025)) picked.set(f.docId, { ...f, why: "named" });
  const ptrs = mine.filter((f) => f.type === "P" && f.year >= 2025).sort((a, b) => b.filed.localeCompare(a.filed));
  for (const f of ptrs.slice(0, 12)) picked.set(f.docId, { ...f, why: "named" });
}
for (const f of sample(members.filter((f) => f.year === 2025 && f.type === "O" && !NAMED.includes(f.bioguide!)), 40))
  picked.set(f.docId, { ...f, why: "random" });
for (const f of sample(members.filter((f) => f.year >= 2025 && f.type === "P" && !NAMED.includes(f.bioguide!)), 50))
  picked.set(f.docId, { ...f, why: "random" });

console.log(`${picked.size} PDFs`);

interface Result {
  filing: HouseFiling & { why: string };
  bytes: number;
  pages: number;
  chars: number;
  text: boolean;
  holdings?: Holding[];
  trades?: Trade[];
  error?: string;
}
const results: Result[] = [];
let n = 0;
const started = Date.now();
for (const f of picked.values()) {
  n++;
  try {
    const buf = await cachedFetch(pdfUrl(f), `house/pdf/${f.docId}.pdf`);
    const text = await pdfText(buf);
    const hasText = text.chars / text.pages > 150;
    const r: Result = { filing: f, bytes: buf.length, pages: text.pages, chars: text.chars, text: hasText };
    if (hasText && f.type === "P") r.trades = parsePtr(text);
    if (hasText && (f.type === "O" || f.type === "A")) r.holdings = parseAnnualAssets(text);
    results.push(r);
  } catch (e) {
    results.push({ filing: f, bytes: 0, pages: 0, chars: 0, text: false, error: String(e) });
  }
  if (n % 25 === 0) console.log(`  ${n}/${picked.size} (${Math.round((Date.now() - started) / 1000)}s)`);
}
writeJson("house/sample.json", results);
console.log(`done in ${Math.round((Date.now() - started) / 1000)}s`);
