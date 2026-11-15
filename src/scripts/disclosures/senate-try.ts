// One slow attempt at Senate eFD: agree, list senators' 2025-26 annual
// reports and PTRs, and stop at the first error. No retries.
//
//   tsx src/scripts/disclosures/senate-try.ts
import { writeJson } from "./common.js";
import { agree, search } from "./senate.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), ...a);

try {
  log("agreeing to the use restrictions");
  await agree();
  log("searching PTRs and annual reports filed since Jan 1, 2025");
  const reports = await search({ reportTypes: [7, 11], start: "01/01/2025", end: "11/15/2026" });
  writeJson("senate/index.json", reports);
  const kinds: Record<string, number> = {};
  for (const r of reports) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1;
  log(`${reports.length} reports`, kinds);
} catch (e) {
  log("stopped:", String(e).slice(0, 300));
  process.exitCode = 1;
}
