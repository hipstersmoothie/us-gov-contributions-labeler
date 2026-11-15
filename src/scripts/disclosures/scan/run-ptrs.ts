// Parse every analyzed paper PTR into .cache/disclosures/scan/ptrs.json and
// report how many rows read cleanly.
//
//   tsx src/scripts/disclosures/scan/run-ptrs.ts
import fs from "fs";
import { CACHE } from "../common.js";
import type { Parsed } from "../house-all.js";
import { parseScannedPtr, type ScanPage } from "./ptr.js";

const all = JSON.parse(fs.readFileSync(`${CACHE}/house/all.json`, "utf8")) as Parsed[];
const out = [];
let pages = 0, skippedPages = 0;
const why: Record<string, number> = {};
const doubts: Record<string, number> = {};
for (const p of all.filter((p) => p.filing.type === "P" && !p.text)) {
  const file = `${CACHE}/scan/${p.filing.docId}.jsonl`;
  if (!fs.existsSync(file)) continue;
  const scan = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as ScanPage);
  const { trades, skipped } = parseScannedPtr(scan);
  pages += scan.length;
  skippedPages += skipped.length;
  for (const s of skipped) why[s.why] = (why[s.why] ?? 0) + 1;
  for (const t of trades) for (const d of t.doubts) doubts[d] = (doubts[d] ?? 0) + 1;
  out.push({ filing: p.filing, trades, skipped });
}
fs.writeFileSync(`${CACHE}/scan/ptrs.json`, JSON.stringify(out));
const trades = out.flatMap((o) => o.trades.map((t) => ({ ...t, bioguide: o.filing.bioguide })));
const clean = trades.filter((t) => !t.doubts.length);
console.log(`${out.length} PTRs, ${pages} pages (${skippedPages} without a readable trade table: ${JSON.stringify(why)})`);
console.log(`${trades.length} trade rows, ${clean.length} (${((clean.length / trades.length) * 100).toFixed(1)}%) with no doubts`);
console.log("doubts:", doubts);
const by: Record<string, [number, number]> = {};
for (const t of trades) {
  by[t.bioguide!] ??= [0, 0];
  by[t.bioguide!]![0]++;
  if (!t.doubts.length) by[t.bioguide!]![1]++;
}
console.log(Object.entries(by).sort((a, b) => b[1][0] - a[1][0]).map(([b, [n, c]]) => `${b} ${c}/${n}`).join(", "));
