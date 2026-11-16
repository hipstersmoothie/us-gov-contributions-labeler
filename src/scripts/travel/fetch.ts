// Download the filings for trips this Congress (departing January 3, 2025 or
// later): every House PDF, and the first pages of each Senate PDF.
//
// House PDFs average about 4 MB. Senate PDFs are scans of 20–40 MB, written
// page by page (iText, images first), so one range request for the first
// 8 MB covers the post-travel form, the pre-travel form and usually the
// sponsor's certification: about a fifth of the bytes.
//
// One request every 2 seconds per host, no retries; a failure is logged and
// skipped, and the next run picks up where this one stopped.
//
//   tsx src/scripts/travel/fetch.ts [--chamber=house|senate]
import fs from "fs";
import path from "path";
import { parseArgs } from "util";
import { CACHE, cachedFetch, houseIndex, senateIndex, SINCE } from "./common.js";
import { USER_AGENT } from "../disclosures/common.js";

const { values } = parseArgs({ options: { chamber: { type: "string", default: "house,senate" } } });
const chambers = new Set(values.chamber.split(","));
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (chambers.has("house")) {
  const filings = (await houseIndex()).filter((f) => f.departure >= SINCE && f.bioguide);
  let done = 0, failed = 0;
  for (const f of filings) {
    const file = `house/pdf/${f.docId}.pdf`;
    if (fs.existsSync(path.join(CACHE, file))) { done++; continue; }
    try {
      await cachedFetch(f.url, file);
    } catch {
      // Member (MT) or staff (ST) is guessed from the names; try the other once.
      const alt = f.url.replace(/\/(MT|ST)\//, (_, p) => `/${p === "MT" ? "ST" : "MT"}/`);
      try {
        await cachedFetch(alt, file);
      } catch (e) {
        failed++;
        log(`house ${f.docId}: ${String(e).slice(0, 120)}`);
      }
    }
    if (++done % 100 === 0) log(`house ${done}/${filings.length}, ${failed} failed`);
  }
  log(`house done: ${done}/${filings.length}, ${failed} failed`);
}

if (chambers.has("senate")) {
  const filings = (await senateIndex()).filter((f) => f.departure >= SINCE && f.bioguide);
  let done = 0, failed = 0;
  let last = 0;
  for (const f of filings) {
    const file = path.join(CACHE, `senate/head/${f.id}.pdf`);
    if (fs.existsSync(file)) { done++; continue; }
    const wait = last + 2000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    try {
      const res = await fetch(f.url, { headers: { "User-Agent": USER_AGENT, Range: "bytes=0-8388607" } });
      if (res.status !== 206 && res.status !== 200) throw new Error(`${res.status}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    } catch (e) {
      failed++;
      log(`senate ${f.id}: ${String(e).slice(0, 120)}`);
    }
    if (++done % 50 === 0) log(`senate ${done}/${filings.length}, ${failed} failed`);
  }
  log(`senate done: ${done}/${filings.length}, ${failed} failed`);
}
