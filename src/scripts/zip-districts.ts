// Writes data/districts/<congress>.json, the ZIP-to-district table the
// website's member finder uses, from the Census relationship file for that
// Congress (src/lib/districts.ts). Committed, so the site build doesn't
// depend on census.gov; it only changes when a new Congress's map does.
//   pnpm zip-districts          # the current Congress (CONGRESS)
//   pnpm zip-districts 120      # another one, once it's in DISTRICT_MAPS
import fs from "fs";
import path from "path";
import { CONGRESS, DISTRICT_MAPS, loadZipDistricts } from "../lib/districts.js";

const congress = Number(process.argv[2] ?? CONGRESS);
const zips = await loadZipDistricts(congress);

const out: Record<string, Record<string, number>> = {};
for (const zip of [...zips.keys()].sort()) {
  const parts = [...zips.get(zip)!]
    .map(([key, share]) => [key, Math.round(share * 10_000) / 10_000] as const)
    .filter(([, share]) => share > 0)
    .sort((a, b) => b[1] - a[1]);
  out[zip] = Object.fromEntries(parts);
}

const file = path.resolve("data/districts", `${congress}.json`);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(
  file,
  JSON.stringify({ congress, source: DISTRICT_MAPS[congress]!.zcta, share: "land area", zips: out }).replace(/\},"/g, '},\n"') + "\n"
);
const single = Object.values(out).filter((d) => Object.keys(d).length === 1).length;
const total = Object.keys(out).length;
console.log(`${path.relative(process.cwd(), file)}: ${total.toLocaleString()} ZIPs, ${single.toLocaleString()} (${Math.round((single / total) * 100)}%) in one district`);
