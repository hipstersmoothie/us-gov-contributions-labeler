// Coverage of the two travel indexes, and a sample of filings: is there a
// text layer, and can the cost be read from it?
//
//   tsx src/scripts/travel/measure.ts [--sample=40]
import { parseArgs } from "util";
import { houseIndex, senateIndex, legislators, cachedFetch, writeJson } from "./common.js";
import { pdfText } from "../disclosures/pdf.js";

const { values } = parseArgs({ options: { sample: { type: "string", default: "0" } } });
const SAMPLE = Number(values.sample);

const members = await legislators();
const house = await houseIndex();
const senate = await senateIndex();
writeJson("house/index.json", house);
writeJson("senate/index.json", senate);

const pctOf = (a: number, b: number) => `${((a / b) * 100).toFixed(1)}%`;
const since = (d: string) => d >= "2025-01-01";

console.log("House Clerk gift travel");
const h25 = house.filter((f) => since(f.departure));
console.log(`  ${house.length} filings 2023-26; ${h25.length} for trips departing 2025 or later`);
console.log(`  matched to a current member's office: ${pctOf(house.filter((f) => f.bioguide).length, house.length)}; since 2025 ${pctOf(h25.filter((f) => f.bioguide).length, h25.length)}`);
console.log(`  filed by the member: ${house.filter((f) => f.self).length}; amendments: ${house.filter((f) => f.amendment).length}`);
const hOffices = new Set(h25.filter((f) => f.bioguide).map((f) => f.bioguide));
console.log(`  current members whose office reported a trip since 2025: ${hOffices.size}; self-reported: ${new Set(h25.filter((f) => f.self && f.bioguide).map((f) => f.bioguide)).size}`);
const unmatched = new Map<string, number>();
for (const f of h25.filter((f) => !f.bioguide)) unmatched.set(`${f.office} ${f.state}-${f.district}`, (unmatched.get(`${f.office} ${f.state}-${f.district}`) ?? 0) + 1);
console.log(`  unmatched offices since 2025: ${[...unmatched].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${k} (${v})`).join("; ")}`);
const senatorsInHouse = new Set(house.filter((f) => f.bioguide && members.find((m) => m.bioguide === f.bioguide)?.chamber === "senate").map((f) => f.office));
console.log(`  House filings from offices of members now in the Senate: ${[...senatorsInHouse].join("; ")}`);

console.log("\nSenate gift rule travel");
const s25 = senate.filter((f) => since(f.departure));
console.log(`  ${senate.length} filings; ${s25.length} for trips departing 2025 or later`);
console.log(`  matched to a current senator's office: ${pctOf(senate.filter((f) => f.bioguide).length, senate.length)}; since 2025 ${pctOf(s25.filter((f) => f.bioguide).length, s25.length)}`);
console.log(`  filed by the senator: ${senate.filter((f) => f.self).length} (since 2025: ${s25.filter((f) => f.self).length})`);
const sUn = new Set(s25.filter((f) => !f.bioguide).map((f) => f.office));
console.log(`  unmatched offices since 2025: ${[...sUn].join("; ")}`);
console.log(`  senators whose office reported a trip since 2025: ${new Set(s25.filter((f) => f.bioguide).map((f) => f.bioguide)).size}`);

if (SAMPLE) {
  // Spread the sample across the index: every nth filing since 2025.
  const pick = <T,>(xs: T[], n: number) => xs.filter((_, i) => i % Math.max(1, Math.floor(xs.length / n)) === 0).slice(0, n);
  for (const [chamber, rows] of [
    ["house", pick(h25, SAMPLE).map((f) => ({ id: f.docId, url: f.url, alt: f.url.replace(/\/(MT|ST)\//, (_, p) => `/${p === "MT" ? "ST" : "MT"}/`) }))],
    ["senate", pick(s25, SAMPLE).map((f) => ({ id: f.id, url: f.url, alt: "" }))],
  ] as const) {
    let text = 0, pages = 0, textPages = 0, bytes = 0, fetched = 0;
    for (const r of rows) {
      let buf: Buffer;
      try {
        buf = await cachedFetch(r.url, `${chamber}/pdf/${r.id}.pdf`);
      } catch (e) {
        if (!r.alt) { console.log(`  ${r.id}: ${e}`); continue; }
        console.log(`  ${r.id}: ${String(e).slice(0, 80)}; trying the other path`);
        buf = await cachedFetch(r.alt, `${chamber}/pdf/${r.id}.pdf`);
      }
      fetched++;
      bytes += buf.length;
      const t = await pdfText(buf);
      pages += t.pages;
      const tp = t.lines.filter((l) => l.join("").length > 200).length;
      textPages += tp;
      if (tp) text++;
    }
    console.log(`\n${chamber} sample: ${fetched} PDFs, ${(bytes / fetched / 1e6).toFixed(2)} MB each, ${text} with any text page, ${pctOf(textPages, pages)} of ${pages} pages have text`);
  }
}
