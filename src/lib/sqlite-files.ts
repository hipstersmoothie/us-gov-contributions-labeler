// The SQLite files published with the open data (pnpm build-sqlite):
//
//   contributions.sqlite      everything in data/*.json, the same data the
//                             site shows, as tables
//   fec-lines.sqlite          the FEC records behind it: each line counted
//                             toward current members' totals
//   lobbying-filings.sqlite   every lobbying registration and report (LD-1,
//                             LD-2) of the current Congress
//
// The first is built from what's committed, so anyone can rebuild it. The
// others need the ingest cache: .cache/fec/<cycle>/lines.jsonl from the fec
// step, .cache/legis/ld2 from the legislation step. They're separate files to
// stay under the PDS's 100 MB blob limit, gzipped, as the cycle fills in.
import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { TableWriter, type Collection, type Json } from "./sqlite-tables.js";
import { normalizeOrg, sameOrg } from "./names.js";
import { rows } from "../ingest/individuals.js";
import type { FecLine } from "../ingest/fec.js";
import type { Ld2 } from "../ingest/legislation.js";

export const OUT_DIR = ".cache/open-data";
export const DATA_DB = path.join(OUT_DIR, "contributions.sqlite");
export const FEC_DB = path.join(OUT_DIR, "fec-lines.sqlite");
export const LOBBYING_DB = path.join(OUT_DIR, "lobbying-filings.sqlite");

const read = (file: string, dir = "data") => JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as Record<string, Json>;

/** What goes in contributions.sqlite: each file's collections, by field. The rest of a file's top level goes in `metadata`. */
const DATA: Record<string, Record<string, Omit<Collection, "records"> & { description: string }>> = {
  "members.json": {
    members: { table: "members", singular: "member", key: "bioguide", description: "Members of Congress: campaign totals, PAC money by sector, contributors, outside spending, donor makeup, committee seats" },
  },
  "organizations.json": {
    organizations: { table: "organizations", singular: "organization", key: "id", description: "The companies, unions and groups behind PACs: sector, SEC and lobbying records, recipients, employees' donations" },
  },
  "committees.json": {
    committees: { table: "committees", singular: "committee", key: "id", description: "PACs and other FEC committees, including non-committee spenders: who they gave to, outside spending, big donors" },
  },
  "donors.json": {
    donors: { table: "donors", singular: "donor", key: "id", description: "Donors of $50,000 or more to super PACs and other outside spenders" },
  },
  "congress-committees.json": {
    committees: { table: "congress_committees", singular: "congress_committee", key: "id", description: "Committees of Congress and their members" },
  },
  "legislation.json": {
    bills: { table: "bills", singular: "bill", key: "id", description: "Bills of the current Congress with roll call votes (how each member voted) and the organizations lobbying on them" },
    organizations: { table: "organization_bills", singular: "organization", key: "organization", description: "The bills each organization's lobbying reports name" },
    caucus: { table: "member_caucus", singular: "member", key: "bioguide", description: "The party independents caucus with" },
  },
  "revolving-door.json": {
    lobbyists: { table: "lobbyists", singular: "lobbyist", description: "Lobbyists who disclosed former government jobs, with the current members and committees those jobs name" },
  },
  "fara.json": {
    countries: { table: "fara_countries", singular: "country", key: "id", description: "Foreign Agents Registration Act activity by country" },
    registrants: { table: "fara_registrants", singular: "registrant", key: "id", description: "FARA registrants" },
    principals: { table: "fara_principals", singular: "principal", description: "FARA foreign principals" },
    gifts: { table: "fara_gifts", singular: "member", key: "bioguide", description: "Donations to current members from people registered as foreign agents" },
  },
  "travel.json": {
    trips: { table: "travel_trips", singular: "trip", key: "id", description: "Trips paid for by outside groups, from House and Senate gift travel filings" },
    sponsors: { table: "travel_sponsors", singular: "sponsor", key: "key", description: "Groups that paid for trips" },
  },
  "irs527.json": {
    groups: { table: "irs527_groups", singular: "group", key: "ein", description: "State-level political organizations (IRS 527 filers) organizations gave to" },
    organizations: { table: "irs527_organizations", singular: "organization", key: "organization", description: "Organizations' gifts to 527 groups" },
    legalFunds: { table: "legal_defense_funds", singular: "fund", key: "ein", description: "Members' legal defense funds" },
  },
};

/** Views over the tables for the questions people ask most. */
const DATA_VIEWS = `
CREATE VIEW pac_contributions AS
  SELECT r.id AS bioguide, m.name AS member, m.party, m.chamber, m.state,
         c.id AS committee_id, c.name AS committee, c.kind, c.organization AS organization_id, o.name AS organization,
         c.sector, c.industry, r.total
  FROM committees_recipients r
  JOIN committees c ON c.id = r.committee_id
  LEFT JOIN members m ON m.bioguide = r.id
  LEFT JOIN organizations o ON o.id = c.organization;

CREATE VIEW outside_spending AS
  SELECT t.id AS bioguide, m.name AS member, m.party, c.id AS committee_id, c.name AS committee, c.kind, c.sector,
         t.support, t.oppose
  FROM committees_outside_targets t
  JOIN committees c ON c.id = t.committee_id
  LEFT JOIN members m ON m.bioguide = t.id;

CREATE VIEW member_votes AS
  SELECT v.bill_id, b.label AS bill, b.name, v.vote_id, v.chamber, v.date, v.question, v.result, p.position, p.bioguide, m.name AS member, m.party
  FROM (
    SELECT bill_id, parent_row, 'yes' AS position, value AS bioguide FROM bills_votes_yes
    UNION ALL SELECT bill_id, parent_row, 'no', value FROM bills_votes_no
    UNION ALL SELECT bill_id, parent_row, 'other', value FROM bills_votes_other
  ) p
  JOIN (SELECT row, bill_id, id AS vote_id, chamber, date, question, result FROM bills_votes) v ON v.row = p.parent_row
  JOIN bills b ON b.id = v.bill_id
  LEFT JOIN members m ON m.bioguide = p.bioguide;
`;

function writeDb(file: string, build: (db: DatabaseSync) => void) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  db.exec("PRAGMA journal_mode = OFF; PRAGMA page_size = 4096;");
  build(db);
  db.exec("VACUUM");
  db.close();
  fs.renameSync(tmp, file);
}

/** A `tables` table: what each one holds and how many rows. */
function describe(writer: TableWriter, descriptions: Map<string, string>) {
  for (const table of writer.names.sort()) {
    const root = [...descriptions.keys()].filter((t) => table === t || table.startsWith(`${t}_`)).sort((a, b) => b.length - a.length)[0];
    const description = table === root ? descriptions.get(root) : root ? `Part of ${root}: ${table.slice(root.length + 1).replace(/_/g, " ")}` : undefined;
    writer.addRow("tables", { name: table, rows: writer.count(table), description });
  }
}

/** contributions.sqlite, from the data files in `dir` (the website's build runs from site/, so passes ../data). */
export function buildDataDb(file = DATA_DB, dir = "data") {
  const writer = new TableWriter();
  const descriptions = new Map<string, string>();
  for (const [name, collections] of Object.entries(DATA)) {
    if (!fs.existsSync(path.join(dir, name))) {
      console.warn(`  ${name}: missing, skipped`);
      continue;
    }
    const json = read(name, dir);
    for (const [field, value] of Object.entries(json)) {
      const c = collections[field];
      if (c && value && typeof value === "object") {
        writer.add({ ...c, records: value as Collection["records"] });
        descriptions.set(c.table, c.description);
      } else writer.addRow("metadata", { file: name, field, value });
    }
  }
  descriptions.set("metadata", "The rest of each file: when it was generated, the cycles and quarters it covers, run statistics");
  describe(writer, descriptions);
  writeDb(file, (db) => {
    writer.write(db);
    db.exec(DATA_VIEWS);
  });
  return { file, rows: writer.rows, tables: writer.names.length };
}

const FEC_TABLES: Record<string, string> = {
  fec_contributions: "PAC and other committee contributions to current members' campaigns (FEC pas2: 24K direct, 24Z in-kind), line by line, as filed",
  fec_independent_expenditures: "Independent expenditures naming a current member, or a candidate running against one (pas2, 24/48-hour notices, Form 5)",
  fec_electioneering: "Electioneering communications (Form 9) naming a current member: the member's share of each disbursement",
  fec_candidates: "Candidates running against current members, as named in independent expenditures (members' own FEC ids are in members_fec_ids)",
  members: "Current members of Congress (contributions.sqlite has everything else about them)",
  committees: "The FEC committees in the lines: the ones giving or spending, with the organization and sector contributions.fyi assigned, and the campaigns receiving",
  organizations: "Organizations behind the committees",
  metadata: "When it was built and the cycles it covers",
};

const LOBBYING_TABLES: Record<string, string> = {
  lobbying_filings: "Every lobbying registration (LD-1) and quarterly report (LD-2) filed for the current Congress, amendments included",
  organizations: "contributions.fyi organizations that appear on the filings as the client, or as the registrant for lobbying firms",
  metadata: "When it was built and the quarters it covers",
};

// Links to the filings, as views so the URLs don't take space in every row.
const FEC_VIEWS = ["fec_contributions", "fec_independent_expenditures", "fec_electioneering"]
  .map((t) => `CREATE VIEW ${t}_with_links AS SELECT *, 'https://docquery.fec.gov/cgi-bin/fecimg/?' || image AS image_url FROM ${t};`)
  .join("\n");
const LOBBYING_VIEWS = `CREATE VIEW lobbying_filings_with_links AS SELECT *, 'https://lda.gov/filings/public/filing/' || uuid || '/print/' AS url FROM lobbying_filings;`;

type Lookup = { id: string; name: string; kind?: string; state?: string; organization?: string; sector?: string; industry?: string };
const members = () => read("members.json").members as { bioguide: string; name: string; chamber: string; state: string; district?: number; party: string; fecIds: string[] }[];
const committees = () => read("committees.json").committees as unknown as Lookup[];
const organizations = () => read("organizations.json").organizations as unknown as (Lookup & { lobbying?: { client: string; firm?: boolean } })[];
/** When its newest input was written, so the same inputs build the same file. */
const newest = (files: string[]) => new Date(Math.max(...files.map((f) => fs.statSync(f).mtimeMs))).toISOString();

/** The FEC lines the fec step wrote for the cycles the published data covers. */
export function fecInputs() {
  const { cycles } = read("members.json") as { cycles: number[] };
  const files = cycles.map((cycle) => path.join(".cache/fec", String(cycle), "lines.jsonl"));
  return { cycles, files, missing: files.filter((f) => !fs.existsSync(f)) };
}

/** The lobbying filings the legislation step cached, a file per quarter. */
export function lobbyingInputs() {
  const dir = ".cache/legis/ld2";
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => path.join(dir, f)) : [];
  return { files, missing: files.length ? [] : [dir] };
}

export async function buildFecDb(file = FEC_DB) {
  const inputs = fecInputs();
  if (inputs.missing.length) throw new Error(`Missing ${inputs.missing.join(", ")}: run pnpm ingest --steps=fec first`);
  const writer = new TableWriter();
  writer.add({ table: "members", singular: "member", key: "bioguide", records: members().map(({ bioguide, name, chamber, state, district, party, fecIds }) => ({ bioguide, name, chamber, state, district, party, fecIds })) });

  const named = new Map<string, Lookup>();
  const counts: Record<FecLine["kind"], number> = { contribution: 0, independent: 0, electioneering: 0 };
  for (const lineFile of inputs.files) {
    const rows: Record<FecLine["kind"], Json[]> = { contribution: [], independent: [], electioneering: [] };
    for (const text of fs.readFileSync(lineFile, "utf8").split("\n")) {
      if (!text) continue;
      const line = JSON.parse(text) as FecLine;
      if (!named.has(line.committee)) named.set(line.committee, { id: line.committee, name: "" });
      if (line.kind === "contribution") {
        // The receiving campaign's name goes in committees, once.
        const { kind, recipientName, ...fields } = line;
        if (!named.has(line.recipient)) named.set(line.recipient, { id: line.recipient, name: recipientName, kind: "candidate" });
        rows[kind].push(fields);
      } else {
        const { kind, ...fields } = line;
        rows[kind].push(fields);
      }
    }
    writer.add({ table: "fec_contributions", singular: "contribution", records: rows.contribution });
    writer.add({ table: "fec_independent_expenditures", singular: "expenditure", records: rows.independent });
    writer.add({ table: "fec_electioneering", singular: "communication", records: rows.electioneering });
    for (const k of Object.keys(rows) as FecLine["kind"][]) counts[k] += rows[k].length;
  }

  const fec = JSON.parse(fs.readFileSync(".cache/fec/data.json", "utf8")) as { candidates: Record<string, Json>; committees: Record<string, Lookup> };
  const ours = new Map(committees().map((c) => [c.id, c]));
  // Committees whose giving nets out to nothing aren't in the data: name them from the FEC's committee master.
  const unnamed = new Set([...named.keys()].filter((id) => !ours.has(id) && !fec.committees[id] && !named.get(id)!.name));
  for (const cycle of [...inputs.cycles].reverse()) {
    const cm = path.join(".cache/fec", String(cycle), `cm${String(cycle).slice(2)}.zip`);
    if (!unnamed.size || !fs.existsSync(cm)) continue;
    for await (const line of rows(cm)) {
      const [id, name] = line.split("|");
      if (unnamed.delete(id!)) named.set(id!, { id: id!, name: name! });
    }
  }
  const used = new Set<string>();
  writer.add({
    table: "committees",
    singular: "committee",
    key: "id",
    records: [...named.keys()].sort().map((id) => {
      const c = ours.get(id) ?? fec.committees[id] ?? named.get(id)!;
      if (c.organization) used.add(c.organization);
      return { id, name: c.name || undefined, kind: c.kind, state: c.state, organization: c.organization, sector: c.sector, industry: c.industry };
    }),
  });
  writer.add({ table: "fec_candidates", singular: "candidate", key: "id", records: fec.candidates });
  writer.add({ table: "organizations", singular: "organization", key: "id", records: organizations().filter((o) => used.has(o.id)).map(({ id, name, sector, industry }) => ({ id, name, sector, industry })) });

  writer.addRow("metadata", { field: "generatedAt", value: newest(inputs.files) });
  writer.addRow("metadata", { field: "cycles", value: inputs.cycles });
  describe(writer, new Map(Object.entries(FEC_TABLES)));
  writeDb(file, (db) => {
    writer.write(db);
    db.exec(FEC_VIEWS);
  });
  return { file, rows: writer.rows, tables: writer.names.length, counts };
}

export function buildLobbyingDb(file = LOBBYING_DB) {
  const inputs = lobbyingInputs();
  if (inputs.missing.length) throw new Error(`Missing ${inputs.missing.join(", ")}: run pnpm ingest --steps=legislation first`);
  const writer = new TableWriter();
  // Clients and registrants -> our organizations, as the legislation and revolving steps match
  // them (sameOrg), with the organizations indexed by word so each name is only compared with
  // ones it shares a word with.
  const orgs = organizations();
  const lobbying = orgs.filter((o) => o.lobbying);
  const exact = new Map(lobbying.map((o) => [normalizeOrg(o.lobbying!.client), o.id]));
  const byWord = new Map<string, typeof lobbying>();
  for (const o of lobbying) for (const w of new Set(normalizeOrg(o.lobbying!.client).split(" "))) byWord.set(w, [...(byWord.get(w) ?? []), o]);
  const matched = new Map<string, string | undefined>();
  const orgFor = (name: string) => {
    const key = normalizeOrg(name);
    if (!matched.has(key)) {
      const nearby = new Set(key.split(" ").flatMap((w) => byWord.get(w) ?? []));
      matched.set(key, exact.get(key) ?? [...nearby].find((o) => sameOrg(o.lobbying!.client, name))?.id);
    }
    return matched.get(key);
  };
  const used = new Set<string>();
  const filings = new Map<string, Ld2>();
  for (const f of inputs.files) for (const filing of JSON.parse(fs.readFileSync(f, "utf8")) as Ld2[]) filings.set(filing.uuid, filing);
  writer.add({
    table: "lobbying_filings",
    singular: "filing",
    key: "uuid",
    records: [...filings.values()].map((f) => {
      const organization = orgFor(f.client.name);
      const registrantOrganization = orgFor(f.registrant.name);
      if (organization) used.add(organization);
      if (registrantOrganization) used.add(registrantOrganization);
      return { ...f, organization, registrantOrganization } as unknown as Json;
    }),
  });
  writer.add({ table: "organizations", singular: "organization", key: "id", records: orgs.filter((o) => used.has(o.id)).map(({ id, name, sector, industry }) => ({ id, name, sector, industry })) });
  writer.addRow("metadata", { field: "generatedAt", value: newest(inputs.files) });
  writer.addRow("metadata", { field: "quarters", value: inputs.files.map((f) => path.basename(f, ".json")) });
  describe(writer, new Map(Object.entries(LOBBYING_TABLES)));
  writeDb(file, (db) => {
    writer.write(db);
    db.exec(LOBBYING_VIEWS);
  });
  return { file, rows: writer.rows, tables: writer.names.length, filings: filings.size };
}
