// The MCP server's database (site/server/src/mcp.ts), server/data/mcp.sqlite:
//
//   the open data's tables   contributions.sqlite as published (src/lib/sqlite-files.ts),
//                            for the query tool's SQL
//   races, zip_districts,    what the site shows that the open data doesn't have
//   disclosures, ...         (disclosures: members' investments, when HOLDINGS_KEY
//                            decrypted them for the build)
//   records                  each page's record as JSON, with the lists the page
//                            joins in, for get_record
//   search_index             the site search's rows, plus companies members own,
//                            for the search tool
//
// Built with the site, from the same data/*.json and helpers the pages use.
// Then the open data's two filing-level files, fec-lines.sqlite and
// lobbying-filings.sqlite, are fetched from the PDS (they're built from the
// ingest cache, which the build doesn't have) and indexed, for query to attach.
//
// Investments carry the § 13107 notice wherever the server returns them
// (mcp.ts); they're never in the open data itself (design/holdings/README.md).
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { buildDataDb } from "../../src/lib/sqlite-files.ts";
import { TableWriter, type Json } from "../../src/lib/sqlite-tables.ts";
import { CONGRESS } from "../../src/lib/districts.ts";
import { members, memberById, organizations, committees, donors, congressCommittees, type Member } from "../src/lib/data";
import { bills, organizationBills, caucusOf } from "../src/lib/legislation";
import { countries, principalsByCountry, faraGifts, registrantsByOrg, principalsByOrg } from "../src/lib/fara";
import { activeSponsors, tripsByMember, tripsBySponsor, sponsorByOrganization } from "../src/lib/travel";
import { givingByOrg, legalFundByMember } from "../src/lib/irs527";
import { allRaces, candidateRaces, fileByYear, formerMembers, raceOfMember, raceName, personName, partyName } from "../src/lib/races";
import { companies, companyName, disclosures, disclosuresAt } from "../src/lib/holdings";
import { fullIndex } from "../src/lib/search";
import { TYPE_NAMES, urlFor, type SearchType } from "../server/src/search.ts";

const OUT_DIR = path.resolve(process.cwd(), "server/data");
const OUT = path.join(OUT_DIR, "mcp.sqlite");
const DATA = path.resolve(process.cwd(), "../data");
const started = performance.now();

/** The open data's repo, for the filing-level files. */
const PDS = "https://pds.contributions.fyi/xrpc";
const DID = "did:plc:ej5cllsvxdrzdsweyfgr2nge";
const FILINGS = ["fec-lines.sqlite", "lobbying-filings.sqlite"];

/**
 * Index the columns tables join on: ids, links to a parent record, and the
 * filing files' committee, candidate and organization columns.
 */
function indexLinks(db: DatabaseSync, skip: string[] = []) {
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table'").all() as { name: string }[];
  for (const { name } of tables.filter((t) => !skip.includes(t.name))) {
    const columns = db.prepare("SELECT name FROM pragma_table_info(?)").all(name) as { name: string }[];
    for (const { name: column } of columns) {
      if (/^(id|uuid|bioguide|key|parent_row|committee|candidate|recipient|organization|registrant_organization|[a-z]+_(id|bioguide|key|row|uuid))$/.test(column)) {
        db.exec(`CREATE INDEX IF NOT EXISTS "${name}__${column}" ON "${name}" ("${column}")`);
      }
    }
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const tmp = `${OUT}.tmp`;
buildDataDb(tmp, DATA);
const db = new DatabaseSync(tmp);
db.exec("PRAGMA journal_mode = OFF;");

// --- tables the open data doesn't have ------------------------------------------------

const writer = new TableWriter();
const descriptions: Record<string, string> = {
  races: "House and Senate general-election races, every election year with data: candidates, their money, PAC and outside spending, results. `key` is year/slug, e.g. 2026/az-04",
  race_committees: "Names of committees that spent in races but aren't in `committees`",
  elections: "Each election year's facts: dates, redistricting, primary systems, runoffs, certification calendar",
  zip_districts: `ZIP codes to House districts of the ${CONGRESS}th Congress, with the share of the ZIP's land area in each (district 0 is at-large)`,
  former_members: "Members who have left Congress, as they were when they left (`former_left` is the date)",
  disclosures: `Members' financial disclosures from the House Clerk (House only; the Senate's aren't included), as of ${disclosuresAt.slice(0, 10)}: annual report, holdings and trades (since 2025), keyed by bioguide. Values are the ranges filed (min, max; open = "over"), owner is whose it is (self, spouse, joint, child), scanned rows were read by machine from paper forms. Under 5 U.S.C. § 13107 these reports may not be used for any commercial purpose (other than news media's), to determine a credit rating, or to solicit money for any political, charitable or other purpose`,
  records: "Each page's full record as JSON (for get_record; compressed)",
  search_index: "The site search's rows (for the search tool)",
};
writer.add({
  table: "races",
  singular: "race",
  key: "key",
  records: allRaces.map(({ election, ...r }) => ({ key: `${r.year}/${r.slug}`, ...r }) as unknown as Json),
});
for (const f of fileByYear.values()) {
  writer.add({ table: "race_committees", singular: "committee", key: "id", records: f.committees as unknown as Record<string, Json> });
  writer.addRow("elections", { year: f.year, ...(f.election as unknown as Record<string, Json>) });
}
writer.add({ table: "former_members", singular: "member", key: "bioguide", records: formerMembers as unknown as Json[] });
writer.add({ table: "disclosures", singular: "member", key: "bioguide", records: Object.fromEntries(disclosures) as unknown as Record<string, Json> });
const zips: { zips: Record<string, Record<string, number>> } = JSON.parse(fs.readFileSync(path.join(DATA, `districts/${CONGRESS}.json`), "utf8"));
for (const [zip, parts] of Object.entries(zips.zips)) {
  for (const [district, share] of Object.entries(parts)) {
    const [state, n] = district.split("-");
    writer.addRow("zip_districts", { zip, state, district: Number(n), share });
  }
}
writer.write(db);
db.prepare("INSERT INTO metadata (file, field, value) VALUES ('districts', 'congress', ?)").run(CONGRESS);
const describe = db.prepare("INSERT INTO tables (name, rows, description) VALUES (?, ?, ?)");
for (const table of writer.names) {
  const root = Object.keys(descriptions).filter((t) => table === t || table.startsWith(`${t}_`)).sort((a, b) => b.length - a.length)[0];
  describe.run(table, writer.count(table), table === root ? descriptions[root] : `Part of ${root}: ${table.slice(root!.length + 1).replace(/_/g, " ")}`);
}

// --- records ---------------------------------------------------------------------------

db.exec(`CREATE TABLE records (type TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, json BLOB NOT NULL, PRIMARY KEY (type, id))`);
const insert = db.prepare("INSERT INTO records (type, id, name, url, json) VALUES (?, ?, ?, ?, ?)");
const counts: Record<string, number> = {};
function put(type: SearchType | "investments", id: string, name: string, record: object) {
  const name_ = type === "investments" ? type : TYPE_NAMES[type];
  const url = type === "investments" ? `/members/${id}/investments/` : urlFor(type, id);
  insert.run(name_, id, name, url, zlib.gzipSync(JSON.stringify(record)));
  counts[name_] = (counts[name_] ?? 0) + 1;
}
const who = (m: Member) => ({ bioguide: m.bioguide, name: m.name, party: m.party, chamber: m.chamber, state: m.state, district: m.district });

db.exec("BEGIN");
for (const m of [...members, ...formerMembers]) {
  const race = raceOfMember(m.bioguide);
  put("m", m.bioguide, m.name, {
    ...m,
    caucus: caucusOf(m),
    race: race && { key: `${race.race.year}/${race.race.slug}`, name: raceName(race.race), onBallot: race.onBallot },
    trips: tripsByMember.get(m.bioguide),
    foreignAgentDonations: faraGifts[m.bioguide],
    legalDefenseFund: legalFundByMember.get(m.bioguide),
  });
}
// The candidates with a page: members running for their own seat are found as members.
for (const [id, list] of candidateRaces) {
  const { c, race } = list[0]!;
  if (c.bioguide && race.incumbents.includes(c.bioguide)) continue;
  put("n", id.toLowerCase(), personName(c), {
    id,
    name: personName(c),
    party: partyName(c),
    bioguide: c.bioguide,
    races: list.map(({ c, race }) => ({ race: `${race.year}/${race.slug}`, raceName: raceName(race), ...c })),
  });
}
for (const { election, ...r } of allRaces) put("r", `${r.year}/${r.slug}`, raceName({ ...r, election }), r);
for (const o of organizations) {
  put("o", o.id, o.name, {
    ...o,
    bills: organizationBills[o.id],
    stateLevelGiving: givingByOrg[o.id],
    foreignAgentRegistrants: registrantsByOrg.get(o.id),
    foreignPrincipals: principalsByOrg.get(o.id),
    tripSponsor: sponsorByOrganization.get(o.id)?.slug,
  });
}
for (const c of committees) put("p", c.id, c.name, c);
for (const d of donors) put("d", d.id, d.name, d);
for (const sp of activeSponsors) put("t", sp.slug, sp.name, { ...sp, trips: tripsBySponsor.get(sp.key) });
for (const b of bills) put("b", b.id, `${b.name} (${b.label})`, b);
for (const c of congressCommittees) put("c", c.id, c.name, c);
for (const c of countries) put("f", c.id, c.name, { ...c, principals: principalsByCountry.get(c.id) });
for (const [bioguide, d] of disclosures) {
  const m = memberById.get(bioguide);
  if (m) put("investments", bioguide, m.name, { member: who(m), asOf: disclosuresAt, ...d });
}
for (const c of companies.values()) {
  put("h", String(c.cik), companyName(c.name), {
    cik: c.cik,
    name: companyName(c.name),
    ticker: c.ticker,
    sector: c.sector,
    industry: c.industry,
    organization: c.org,
    holders: c.holders.map((h) => ({ member: who(h.member), holdings: h.holdings })),
    traders: c.traders.map((t) => ({ member: who(t.member), trades: t.trades })),
  });
}
db.exec("COMMIT");

// --- search ----------------------------------------------------------------------------

db.exec("CREATE TABLE search_index (type TEXT, id TEXT, label TEXT, detail TEXT, weight REAL)");
const row = db.prepare("INSERT INTO search_index VALUES (?, ?, ?, ?, ?)");
db.exec("BEGIN");
for (const r of fullIndex()) row.run(...r);
for (const c of companies.values()) {
  const name = companyName(c.name);
  row.run("h", String(c.cik), c.ticker ? `${name} (${c.ticker})` : name, `Held by ${c.holders.length} House ${c.holders.length === 1 ? "member" : "members"}`, c.holders.length);
}
db.exec("COMMIT");

// The open data has no indexes; queries here join on ids and links, so index those.
indexLinks(db, ["records", "search_index"]);

const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
describe.run("records", n("SELECT count(*) AS n FROM records"), descriptions.records);
describe.run("search_index", n("SELECT count(*) AS n FROM search_index"), descriptions.search_index);
db.exec("VACUUM");
db.close();
fs.renameSync(tmp, OUT);
console.log(
  `mcp data: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}; ${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB in ${((performance.now() - started) / 1000).toFixed(1)}s`
);

// --- the filing-level files ------------------------------------------------------------

/**
 * Fetch a file from the dataset record, unless the copy here is the same blob
 * (its CID is kept beside it), and index it. On failure, keep whatever copy
 * there is: query runs without the file when there's none.
 */
async function fetchFiling(name: string, files: { name: string; blob: { ref: { $link: string } } }[]) {
  const file = path.join(OUT_DIR, name);
  const cid = files.find((f) => f.name === `${name}.gz`)?.blob.ref.$link;
  if (!cid) throw new Error(`${name}.gz isn't in the dataset record`);
  if (fs.existsSync(file) && fs.existsSync(`${file}.cid`) && fs.readFileSync(`${file}.cid`, "utf8") === cid) return `${name}: unchanged`;
  const res = await fetch(`${PDS}/com.atproto.sync.getBlob?did=${DID}&cid=${cid}`);
  if (!res.ok || !res.body) throw new Error(`${name}: HTTP ${res.status}`);
  const tmp = `${file}.tmp`;
  await pipeline(Readable.fromWeb(res.body as never), zlib.createGunzip(), fs.createWriteStream(tmp));
  const db = new DatabaseSync(tmp);
  indexLinks(db);
  db.close();
  fs.renameSync(tmp, file);
  fs.writeFileSync(`${file}.cid`, cid);
  return `${name}: ${(fs.statSync(file).size / 1e6).toFixed(1)} MB`;
}

try {
  const res = await fetch(`${PDS}/com.atproto.repo.getRecord?repo=${DID}&collection=fyi.contributions.dataset&rkey=self`);
  if (!res.ok) throw new Error(`dataset record: HTTP ${res.status}`);
  const { value } = (await res.json()) as { value: { files: Parameters<typeof fetchFiling>[1] } };
  for (const name of FILINGS) console.log(`mcp data: ${await fetchFiling(name, value.files)}`);
} catch (err) {
  console.warn(`mcp data: couldn't fetch the filing files (${(err as Error).message}); keeping ${FILINGS.filter((f) => fs.existsSync(path.join(OUT_DIR, f))).join(", ") || "none"}`);
}
