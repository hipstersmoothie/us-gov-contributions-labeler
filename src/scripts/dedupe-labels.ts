// One-off cleanup for labels.db. The old create-labels script re-applied
// every label on each run, leaving ~20k duplicate events. For each
// (source, subject, value) this keeps only the events where the label's
// state actually changes (applied -> removed -> applied), so the labels in
// effect are exactly the same, just with a much shorter history.
//
// Run it on the labeler server, next to the database:
//   pnpm dedupe-labels            dry run
//   pnpm dedupe-labels --apply    back up, then delete the duplicates
import Database from "libsql";
import { parseArgs } from "util";

const { values: args } = parseArgs({ options: { apply: { type: "boolean", default: false } } });
const dbPath = process.env.DB_PATH ?? "labels.db";
const db = new Database(dbPath);

const rows = db
  .prepare("SELECT id, src, uri, val, neg FROM labels ORDER BY id ASC")
  .all() as { id: number; src: string; uri: string; val: string; neg: number }[];

const state = new Map<string, number>();
const redundant: number[] = [];
for (const r of rows) {
  const key = `${r.src}\u0000${r.uri}\u0000${r.val}`;
  const prev = state.get(key);
  // A create with nothing before it, or any event that flips the state, stays.
  if (prev === r.neg || (prev === undefined && r.neg)) redundant.push(r.id);
  else state.set(key, r.neg);
}

// Never delete the newest event: subscribers reconnect with the last id they
// saw, and a cursor past the newest remaining id is rejected as FutureCursor.
const newest = rows.at(-1)?.id;
if (newest !== undefined && redundant.at(-1) === newest) redundant.pop();

console.log(`${dbPath}: ${rows.length} label events, ${redundant.length} redundant, ${rows.length - redundant.length} kept`);

if (!args.apply) {
  console.log("Dry run. Re-run with --apply to back up the database and delete the redundant events.");
  process.exit(0);
}

const backup = `${dbPath}.backup-${new Date().toISOString().replace(/[:.]/g, "-")}`;
db.exec(`VACUUM INTO '${backup}'`);
console.log(`Backed up to ${backup}`);

const remove = db.prepare("DELETE FROM labels WHERE id = ?");
db.exec("BEGIN");
for (const id of redundant) remove.run(id);
db.exec("COMMIT");
db.exec("VACUUM");
console.log(`Deleted ${redundant.length} events`);
