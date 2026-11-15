// Parse Schedule A from every analyzed paper annual report into
// .cache/disclosures/scan/annuals.json and report how many rows read cleanly.
//
//   tsx src/scripts/disclosures/scan/run-annuals.ts
import fs from "fs";
import { CACHE } from "../common.js";
import type { Parsed } from "../house-all.js";
import { isScheduleA, parseScannedScheduleA } from "./annual.js";
import type { ScanPage } from "./ptr.js";

const all = JSON.parse(fs.readFileSync(`${CACHE}/house/all.json`, "utf8")) as Parsed[];
const out = [];
for (const p of all.filter((p) => p.filing.type !== "P" && !p.text)) {
  const file = `${CACHE}/scan/${p.filing.docId}.jsonl`;
  if (!fs.existsSync(file)) continue;
  const scan = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as ScanPage);
  const { holdings, skipped } = parseScannedScheduleA(scan);
  out.push({ filing: p.filing, pages: scan.length, scheduleA: scan.filter(isScheduleA).length, holdings, skipped });
}
fs.writeFileSync(`${CACHE}/scan/annuals.json`, JSON.stringify(out));
const hs = out.flatMap((o) => o.holdings);
const clean = hs.filter((h) => !h.doubts.length);
console.log(`${out.length} reports, ${out.reduce((s, o) => s + o.pages, 0)} pages, ${out.reduce((s, o) => s + o.scheduleA, 0)} Schedule A grid pages`);
console.log(`${hs.length} asset rows, ${clean.length} (${((clean.length / hs.length) * 100).toFixed(1)}%) with no doubts`);
const doubts: Record<string, number> = {};
for (const h of hs) for (const d of h.doubts) doubts[d] = (doubts[d] ?? 0) + 1;
console.log(doubts);
console.log(out.map((o) => `${o.filing.last} ${o.holdings.filter((h) => !h.doubts.length).length}/${o.holdings.length} (${o.scheduleA} p)`).join(", "));
