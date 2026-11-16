// Build the open data's SQLite files (src/lib/sqlite-files.ts) in .cache/open-data/.
//
//   pnpm build-sqlite                  all three
//   pnpm build-sqlite --only=data      contributions.sqlite, from data/*.json
//   pnpm build-sqlite --only=fec       fec-lines.sqlite, from the ingest cache
//   pnpm build-sqlite --only=lobbying  lobbying-filings.sqlite, from the ingest cache
//
// publish-records builds contributions.sqlite itself, and publishes the other
// two when they're here.
import { parseArgs } from "util";
import fs from "fs";
import { buildDataDb, buildFecDb, buildLobbyingDb } from "./lib/sqlite-files.js";

const { values: args } = parseArgs({ options: { only: { type: "string" } } });
const only = new Set(args.only?.split(",") ?? ["data", "fec", "lobbying"]);
const report = (r: { file: string; tables: number; rows: number }) =>
  console.log(`${r.file}: ${r.tables} tables, ${r.rows.toLocaleString()} rows, ${(fs.statSync(r.file).size / 1e6).toFixed(1)} MB`);

if (only.has("data")) report(buildDataDb());
if (only.has("fec")) {
  const r = await buildFecDb();
  report(r);
  console.log(`  ${Object.entries(r.counts).map(([k, n]) => `${n.toLocaleString()} ${k}`).join(", ")} lines`);
}
if (only.has("lobbying")) {
  const r = buildLobbyingDb();
  report(r);
  console.log(`  ${r.filings.toLocaleString()} filings`);
}
