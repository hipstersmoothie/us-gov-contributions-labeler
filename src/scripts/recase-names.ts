// Re-apply fixCase to organization names already in data/, so acronym and
// brand fixes show up without re-running the whole ingest.
//
//   pnpm tsx src/scripts/recase-names.ts
//
// Only organization-like fields are touched; people's names are left alone.
import fs from "fs";
import { fixCase } from "../lib/names.js";

let changed = 0;
const fix = (s: string | undefined) => {
  if (!s) return s;
  const out = fixCase(s);
  if (out !== s) changed++;
  return out;
};

function update(file: string, pretty: boolean, edit: (data: any) => void) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const before = changed;
  edit(data);
  fs.writeFileSync(file, (pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data)) + "\n");
  console.log(`${file}: ${changed - before} names`);
}

update("data/members.json", true, ({ members }) => {
  for (const m of members) {
    for (const c of m.contributors ?? []) c.name = fix(c.name);
    for (const e of m.individuals?.employers ?? []) e.name = fix(e.name);
  }
});
update("data/organizations.json", true, ({ organizations }) => {
  for (const o of organizations) {
    o.name = fix(o.name);
    if (o.lobbying?.client) o.lobbying.client = fix(o.lobbying.client);
  }
});
update("data/donors.json", true, ({ donors }) => {
  for (const d of donors) {
    if (d.type !== "individual") d.name = fix(d.name);
    d.employer = fix(d.employer);
  }
});
update("data/legislation.json", false, ({ bills }) => {
  for (const b of bills) for (const l of b.lobbying ?? []) l.name = fix(l.name);
});
console.log(`${changed} names re-cased`);
