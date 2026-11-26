// The MCP server at /mcp: everything the site shows, for AI assistants, over
// Streamable HTTP with no sign-in (the data is public). It reads
// data/mcp.sqlite, which site/scripts/mcp-data.ts builds with the site, and
// the open data's filing-level files beside it (fec-lines.sqlite,
// lobbying-filings.sqlite), attached as the schemas fec and lobbying.
//
//   search        the site search: names of members, candidates, races, organizations, PACs...
//   get_record    one page's record, as JSON
//   find_members  who represents a ZIP code or street address
//   list_tables   the tables and views for query, with their columns
//   query         read-only SQL over them
//
// Members' investments come with the § 13107 notice, in get_record and in any
// query that reads them, and the instructions carry the site's rules for
// reading them (design/holdings/README.md). Reading them in bulk (any query on
// the disclosures tables, or more than a few dozen records an hour) needs the
// user's own agreement to the § 13107 terms, asked through their client
// (elicitation, protocol 2026-07-28): the click-through the Senate asks of its
// readers. Clients that can't ask the user don't get bulk access.
//
// Each request gets a fresh, stateless server instance (createMcpHandler), so
// nothing is held between requests. Queries run in a child process
// (sql-worker.ts) with a time limit.
import { fork } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { Readable, pipeline } from "node:stream";
import zlib from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { CLIENT_CAPABILITIES_META_KEY, McpServer, acceptedContent, createMcpHandler, inputRequired } from "@modelcontextprotocol/server";
import * as z from "zod";
import { search, TYPE_NAMES, type SearchRow, type SearchType } from "./search.ts";
import { limited, lookup } from "./geocode.ts";
import { AGREED_HOURS, FREE_RECORDS, FREE_RECORDS_OVERALL, MAX_ROWS, MAX_SQL_CHARS, QUERIES_PER_CLIENT, QUERY_TIMEOUT_MS } from "./mcp-limits.ts";
import type { QueryRequest, QueryResult } from "./sql-worker.ts";

export const MCP_PATH = "/mcp";

const SITE = (process.env.SITE_URL ?? "https://contributions.fyi").replace(/\/$/, "");
const WORKER = path.join(import.meta.dirname, "sql-worker.ts");
/** Roughly 25K tokens: past this, a record's longest lists are cut short. */
const MAX_CHARS = 100_000;
const MAX_QUERIES = 4;

const TYPE_LETTER = Object.fromEntries(Object.entries(TYPE_NAMES).map(([letter, name]) => [name, letter])) as Record<string, SearchType>;
/** The filing-level files, by the schema they're attached as. */
const FILINGS = { fec: "fec-lines.sqlite", lobbying: "lobbying-filings.sqlite" };

const NOTICE =
  "Source: U.S. House Clerk financial disclosure reports. Under 5 U.S.C. § 13107, these reports may not be used for any commercial purpose (other than news media's), to determine a credit rating, or to solicit money for any political, charitable or other purpose.";
/** Record types and tables that come from financial disclosures. */
const DISCLOSURE_TYPES = new Set(["investments", "company"]);
const isDisclosureTable = (table: string) => table === "disclosures" || table.startsWith("disclosures_");

// --- agreeing to the disclosure terms ------------------------------------------------

const HOUR = 3600_000;
const AGREED_MS = AGREED_HOURS * HOUR;
/** Signs agreement tokens. A new deploy has a new key, so users agree again. */
const TERMS_KEY = crypto.randomBytes(32);
const TERMS = `This asks for House members' financial disclosures in bulk. Under 5 U.S.C. § 13107, it is unlawful to obtain or use these reports for any unlawful purpose; for any commercial purpose, other than by news and communications media for dissemination to the general public; to determine or establish anyone's credit rating; or, directly or indirectly, to solicit money for any political, charitable or other purpose. Agree only if you'll use this data within those limits. Your agreement lasts ${AGREED_HOURS} hours.`;
const agreement = z.object({ agree: z.boolean().describe("I'll use this data only within the limits of 5 U.S.C. § 13107") });

/** Tokens are for the client that agreed, so one can't be passed around. */
const sign = (until: number, client: string) => crypto.createHmac("sha256", TERMS_KEY).update(`${until} ${client}`).digest("base64url");
const termsToken = (client: string) => {
  const until = Date.now() + AGREED_MS;
  return `${until}.${sign(until, client)}`;
};
function validToken(token: string | undefined, client: string) {
  const [until, signature] = token?.split(".") ?? [];
  if (!until || !signature || !(Number(until) > Date.now())) return false;
  const expected = Buffer.from(sign(Number(until), client));
  const given = Buffer.from(signature);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

/** Disclosure records each client, and everyone ("*"), read in the last hour. */
const recordReads = new Map<string, number[]>();
function readsThisHour(client: string) {
  const since = Date.now() - HOUR;
  const reads = (recordReads.get(client) ?? []).filter((t) => t > since);
  recordReads.set(client, reads);
  return reads;
}
setInterval(() => {
  for (const client of recordReads.keys()) if (!readsThisHour(client).length) recordReads.delete(client);
}, HOUR).unref();

interface AgreementContext {
  mcpReq: { inputResponses?: Record<string, unknown>; envelope?: object };
}
/**
 * Whether the user has agreed to the terms: by a token from an earlier
 * agreement, or just now, answering the form this sends them. Otherwise, the
 * result to return instead: the form, or why there's none.
 */
function agreed(ctx: AgreementContext, token: string | undefined, client: string) {
  if (validToken(token, client)) return { agreed: true as const };
  if (acceptedContent(ctx.mcpReq.inputResponses, "terms", agreement)?.agree === true) return { agreed: true as const, termsToken: termsToken(client) };
  if (ctx.mcpReq.inputResponses?.terms) {
    return { agreed: false as const, result: fail("The user didn't agree to the terms, so members' financial disclosures can't be read in bulk. get_record has one member's investments or one company's holders at a time.") };
  }
  const capabilities = (ctx.mcpReq.envelope as Record<string, { elicitation?: unknown } | undefined> | undefined)?.[CLIENT_CAPABILITIES_META_KEY];
  if (!capabilities?.elicitation) {
    return {
      agreed: false as const,
      result: fail(
        `Reading members' financial disclosures in bulk needs the user to agree to the terms of 5 U.S.C. § 13107, and this client can't ask them (that needs elicitation, on MCP protocol 2026-07-28). get_record has one member's investments or one company's holders at a time, ${FREE_RECORDS} an hour, and the site has the rest: ${SITE}/holdings/`
      ),
    };
  }
  return { agreed: false as const, result: inputRequired({ inputRequests: { terms: inputRequired.elicit({ message: TERMS, requestedSchema: agreement }) } }) };
}
/** Said with a new token, so the model passes it on. */
const TOKEN_NOTE = `The user agreed to the disclosure terms. Pass termsToken as terms_token in later calls that read disclosures, for the next ${AGREED_HOURS} hours.`;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

/**
 * Cut a record's longest lists until it fits, longest first, and say what was
 * cut: { "votes": 212 } means votes had 212 items.
 */
function fit(record: Record<string, unknown>) {
  const cut: Record<string, number> = {};
  for (let size = JSON.stringify(record).length; size > MAX_CHARS; size = JSON.stringify(record).length) {
    let longest: { path: string; list: unknown[]; holder: Record<string, unknown> | unknown[]; key: string | number; size: number } | undefined;
    const walk = (value: unknown, at: string, holder: Record<string, unknown> | unknown[], key: string | number) => {
      if (Array.isArray(value)) {
        const s = JSON.stringify(value).length;
        if (value.length > 1 && (!longest || s > longest.size)) longest = { path: at, list: value, holder, key, size: s };
        value.forEach((v, i) => walk(v, `${at}[${i}]`, value, i));
      } else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) walk(v, at ? `${at}.${k}` : k, value as Record<string, unknown>, k);
      }
    };
    for (const [k, v] of Object.entries(record)) walk(v, k, record, k);
    if (!longest) break;
    cut[longest.path] ??= longest.list.length;
    (longest.holder as Record<string | number, unknown>)[longest.key] = longest.list.slice(0, Math.floor(longest.list.length / 2));
  }
  return cut;
}

let running = 0;
/** Clients with a query running, and when each client's recent queries started. */
const busy = new Set<string>();
const started = new Map<string, number[]>();
setInterval(() => {
  const since = Date.now() - 10 * 60_000;
  for (const [client, times] of started) if (!times.some((t) => t > since)) started.delete(client);
}, 10 * 60_000).unref();

/**
 * Run one query in a child process, killed if it runs past the time limit:
 * MAX_QUERIES at once, and for each client, one at a time and
 * QUERIES_PER_CLIENT every ten minutes, so no one client can take them all.
 */
function query(client: string, request: QueryRequest): Promise<QueryResult> {
  const since = Date.now() - 10 * 60_000;
  const recent = (started.get(client) ?? []).filter((t) => t > since);
  started.set(client, recent);
  if (busy.has(client)) return Promise.resolve({ error: "Another of your queries is still running; run one at a time." });
  if (recent.length >= QUERIES_PER_CLIENT) return Promise.resolve({ error: `That's ${QUERIES_PER_CLIENT} queries in ten minutes; try again in a few minutes.` });
  if (running >= MAX_QUERIES) return Promise.resolve({ error: "Too many queries running at once; try again in a few seconds." });
  running++;
  busy.add(client);
  recent.push(Date.now());
  return new Promise<QueryResult>((resolve) => {
    const child = fork(WORKER, { execArgv: ["--max-old-space-size=384"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, QUERY_TIMEOUT_MS);
    let result: QueryResult | undefined;
    let settled = false;
    const finish = (fallback: QueryResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running--;
      busy.delete(client);
      resolve(result ?? fallback);
    };
    child.once("message", (r: QueryResult) => (result = r));
    child.once("exit", () =>
      finish(
        timedOut
          ? { error: `The query took longer than ${QUERY_TIMEOUT_MS / 1000} seconds and was stopped. Narrow it with WHERE on an indexed id, or LIMIT.` }
          : { error: "The query used too much memory and was stopped. Narrow it, or select fewer or smaller columns." }
      )
    );
    // A process that couldn't start, or a closed channel: without a listener, this error would take the server down.
    const failed = (err: Error | null) => {
      if (!err) return;
      console.error("mcp query worker:", err.message);
      child.kill("SIGKILL");
      finish({ error: "The query couldn't run; try again in a few seconds." });
    };
    child.once("error", failed);
    child.send(request, failed);
  });
}

export function createMcp(dir: string) {
  const file = path.join(dir, "mcp.sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  const attach = Object.fromEntries(
    Object.entries(FILINGS)
      .map(([schema, name]) => [schema, path.join(dir, name)])
      .filter(([, f]) => fs.existsSync(f!))
  ) as Record<string, string>;
  for (const [schema, f] of Object.entries(attach)) db.prepare(`ATTACH DATABASE ? AS ${schema}`).run(f);

  const rows = db.prepare("SELECT type, id, label, detail, weight FROM search_index").all().map((r) => Object.values(r) as SearchRow);
  const metadata = Object.fromEntries(
    (db.prepare("SELECT file, field, value FROM metadata").all() as { file: string; field: string; value: string }[]).map((r) => [`${r.file} ${r.field}`, r.value])
  );
  const cycles = (JSON.parse(metadata["members.json cycles"] ?? "[]") as number[]).join(", ");
  const updated = (metadata["members.json generatedAt"] ?? "").slice(0, 10);
  const congress = Number(metadata["districts congress"]);
  const types = (db.prepare("SELECT DISTINCT type FROM records ORDER BY type").all() as { type: string }[]).map((r) => r.type) as [string, ...string[]];
  const searchTypes = types.filter((t) => t in TYPE_LETTER) as [string, ...string[]];
  const holdings = types.includes("investments");

  const getRecord = db.prepare("SELECT type, id, name, url, json FROM records WHERE type = ? AND id = ? COLLATE NOCASE");
  const zipDistricts = db.prepare("SELECT state, district, share FROM zip_districts WHERE zip = ? ORDER BY share DESC");
  const representative = db.prepare("SELECT bioguide, name, party FROM members WHERE chamber = 'house' AND state = ? AND district = ?");
  const senators = db.prepare("SELECT bioguide, name, party FROM members WHERE chamber = 'senate' AND state = ? ORDER BY name");
  const tablesIn = (schema: string) =>
    [
      ...(db.prepare(`SELECT name, rows, description FROM ${schema}.tables WHERE name NOT IN ('records', 'search_index') ORDER BY name`).all() as { name: string; rows?: number; description: string }[]),
      ...(db.prepare(`SELECT name FROM ${schema}.sqlite_schema WHERE type = 'view' ORDER BY name`).all() as { name: string }[]).map((v) => ({ name: v.name, rows: undefined, description: "View" })),
    ].map((t) => ({
      ...t,
      name: schema === "main" ? t.name : `${schema}.${t.name}`,
      columns: (db.prepare("SELECT name, type FROM pragma_table_info(?, ?)").all(t.name, schema) as { name: string; type: string }[])
        .map((c) => (c.type ? `${c.name} ${c.type}` : c.name))
        .join(", "),
    }));
  const allTables = [...tablesIn("main"), ...Object.keys(attach).flatMap(tablesIn)];
  const member = (m: { bioguide: string; name: string; party: string }) => ({ ...m, url: `${SITE}/members/${m.bioguide}/` });

  const instructions = [
    `contributions.fyi tracks who funds the US Congress: campaign money, PAC contributions by industry, outside spending, big donors, lobbying, the revolving door, foreign agents (FARA), sponsored travel, bills and votes, House and Senate races${holdings ? ", and House members' investments" : ""}. The data is public (FEC filings, lobbying disclosures, FARA registrations, SEC EDGAR, congress.gov and House and Senate roll calls, gift travel filings, IRS 527 filings${holdings ? ", House financial disclosures" : ""}) and refreshed weekly; this copy is from ${updated}, covering the ${cycles} election cycles.`,
    `Start with search to find an id by name, then get_record for the full record; find_members answers "who represents" a ZIP code or address. For questions across many records (rankings, totals, filters), use list_tables, then query with SQL.${attach.fec ? " The fec schema has every FEC line behind members' totals, as filed, with links to the filings; the lobbying schema has every LD-1 and LD-2 lobbying filing of the current Congress." : ""} Amounts are US dollars. An organization's total combines its PAC's contributions, donations from people who list it as their employer, and donations earmarked through its PAC. When you cite a figure, link the record's page on contributions.fyi (the url field).`,
    holdings &&
      `Members' investments (get_record types investments and company; the disclosures tables) are from House financial disclosures only: senators aren't included, and rows on paper forms that couldn't be read aren't either. Read them as the site does. Values are the ranges filed: give ranges, never a midpoint, net worth or return. Say whose a holding is (the member's, a spouse's, joint, a child's). A fund isn't a bet on an industry. Don't present a company's PAC money to members who hold its stock as a link: across companies, holders get a company's PAC money at about the rate every member does. Committee overlap means little without the baseline of all House members. Rows marked scanned were read by machine from paper forms; link the filing. Pass on the § 13107 notice that comes with this data. Reading them in bulk (any query on the disclosures tables, or more than ${FREE_RECORDS} investments or company records an hour) needs the user's agreement to the § 13107 terms: the server asks them through the client, and returns a termsToken to pass as terms_token in later calls.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const factory = (ctx: { requestInfo?: Request }) => {
    const client = (ctx.requestInfo?.headers.get("x-forwarded-for") ?? "").split(",")[0]!.trim() || "mcp";
    const server = new McpServer({ name: "contributions.fyi", title: "contributions.fyi: who funds Congress", version: updated || "1", websiteUrl: SITE }, { instructions });
    const readOnly = { readOnlyHint: true, openWorldHint: false };

    server.registerTool(
      "search",
      {
        title: "Search",
        description: `Find members of Congress, candidates, races, organizations, PACs and outside groups, big donors, trip sponsors, bills, congressional committees, countries (foreign lobbying)${holdings ? " and companies members own" : ""} by name, as the site's search box does. Every word must appear in the name; races match "AZ-04" or "Arizona's 4th District", bills match "H.R. 1"${holdings ? ", companies their ticker" : ""}. Returns each hit's type and id for get_record.`,
        inputSchema: z.object({
          query: z.string().min(1).describe("Words in the name"),
          type: z.enum(searchTypes).optional().describe("Only this type"),
          limit: z.number().int().min(1).max(50).default(10),
        }),
        annotations: readOnly,
      },
      async ({ query: q, type, limit }) => {
        const hits = search(type ? rows.filter((r) => r[0] === TYPE_LETTER[type]) : rows, q).slice(0, limit);
        return json(hits.map((h) => ({ type: TYPE_NAMES[h.type], id: h.id, name: h.label, detail: h.detail, url: SITE + h.url })));
      }
    );

    server.registerTool(
      "get_record",
      {
        title: "Get a record",
        description: `One page's full record from contributions.fyi, as JSON: a member's money by cycle, sectors, top organizations and PACs, outside spending, committee seats, trips and race; an organization's PAC giving, recipients, employees' donations, lobbying and bills; a race's candidates, money and outside spending; and so on.${holdings ? " investments is a House member's financial disclosure (holdings and trades, by bioguide); company is who holds and trades a company's stock (by SEC CIK)." : ""} Ids: members by bioguide (S000033), PACs by FEC committee id (C00303024), races by year/slug (2026/az-04), candidates by FEC candidate id (h0al01055); for anything else, use search. Long lists are cut short to fit (see "truncated"); query has them in full.`,
        inputSchema: z.object({
          type: z.enum(types),
          id: z.string().min(1),
          fields: z.array(z.string()).optional().describe("Only these top-level fields of the record"),
          ...(holdings ? { terms_token: z.string().optional().describe("termsToken from an earlier agreement to the disclosure terms") } : {}),
        }),
        annotations: readOnly,
      },
      async ({ type, id, fields, terms_token }, ctx) => {
        const row = getRecord.get(type, id) as { type: string; id: string; name: string; url: string; json: Uint8Array } | undefined;
        if (!row) return fail(`No ${type} with id "${id}". Find the id with search.`);
        let gate: ReturnType<typeof agreed> | undefined;
        if (DISCLOSURE_TYPES.has(row.type)) {
          const reads = readsThisHour(client);
          const overall = readsThisHour("*");
          if (reads.length >= FREE_RECORDS || overall.length >= FREE_RECORDS_OVERALL) {
            gate = agreed(ctx, terms_token as string | undefined, client);
            if (!gate.agreed) return gate.result;
          }
          reads.push(Date.now());
          overall.push(Date.now());
        }
        let record = JSON.parse(zlib.gunzipSync(row.json).toString("utf8")) as Record<string, unknown>;
        if (fields?.length) record = Object.fromEntries(Object.entries(record).filter(([k]) => fields.includes(k)));
        const truncated = fit(record);
        return json({
          type: row.type,
          id: row.id,
          name: row.name,
          url: SITE + row.url,
          ...(DISCLOSURE_TYPES.has(row.type) ? { notice: NOTICE } : {}),
          ...(gate?.agreed && gate.termsToken ? { termsToken: gate.termsToken, note: TOKEN_NOTE } : {}),
          ...(Object.keys(truncated).length ? { truncated } : {}),
          record,
        });
      }
    );

    server.registerTool(
      "find_members",
      {
        title: "Find members by ZIP or address",
        description: `Who represents a place in Congress: the House member for each district a ZIP code or street address is in, and the state's two senators. A ZIP can span districts (share is the part of its population in each); a full address gives the one district, from the Census Bureau's geocoder. Districts are the ${congress}th Congress's.`,
        inputSchema: z.object({
          zip: z.string().regex(/^\d{5}$/).optional().describe("A five-digit ZIP code"),
          address: z.string().min(5).max(200).optional().describe("A street address with city and state, or ZIP"),
        }),
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ zip, address }) => {
        let places: { state: string; district: number; share?: number }[];
        let matched: string | undefined;
        if (address) {
          if (limited(client)) return fail("Too many address lookups; try again in ten minutes, or use a ZIP code.");
          const answer = await lookup(address.replace(/\s+/g, " ").trim(), congress);
          if (answer.status === "nomatch") return fail("The Census geocoder couldn't find that address. Check it, or use the ZIP code.");
          if (answer.status !== "match") return fail("The Census geocoder isn't answering; use the ZIP code instead.");
          places = [{ state: answer.state, district: answer.district }];
          matched = answer.matched;
        } else if (zip) {
          places = zipDistricts.all(zip) as typeof places;
          if (!places.length) return fail(`No districts for ZIP ${zip}. It may be a PO box or business ZIP; try a street address.`);
        } else return fail("Give a zip or an address.");
        const states = [...new Set(places.map((p) => p.state))];
        return json({
          ...(matched ? { matchedAddress: matched } : {}),
          house: places.map((p) => ({
            ...p,
            representative: (representative.all(p.state, p.district) as { bioguide: string; name: string; party: string }[]).map(member)[0] ?? null,
          })),
          senate: states.flatMap((s) => (senators.all(s) as { bioguide: string; name: string; party: string }[]).map((m) => ({ state: s, ...member(m) }))),
        });
      }
    );

    server.registerTool(
      "list_tables",
      {
        title: "List tables",
        description: `The tables and views for query, with row counts, descriptions and columns. Lists inside records are child tables named for their path (members_sectors), linked to the record by a column like member_bioguide or committee_id, and below that by parent_row = the parent table's row. Views: pac_contributions (PAC to member), outside_spending (for or against a member), member_votes (roll call votes).${attach.fec ? " Tables named fec.* and lobbying.* are the filing-level files: FEC lines as filed (fec.fec_contributions_with_links has links to each filing) and every LD-1/LD-2 lobbying filing (lobbying.lobbying_filings_with_links)." : ""}`,
        inputSchema: z.object({
          tables: z.array(z.string()).optional().describe("Only these; leave out for all"),
        }),
        annotations: readOnly,
      },
      async ({ tables }) => json(tables?.length ? allTables.filter((t) => tables.includes(t.name)) : allTables)
    );

    server.registerTool(
      "query",
      {
        title: "Query with SQL",
        description: `Run one read-only SQLite SELECT over the tables from list_tables, for rankings, totals and filters across records.${attach.fec ? " Name the filing-level tables with their schema: fec.fec_contributions, lobbying.lobbying_filings." : ""} Up to ${MAX_ROWS.toLocaleString("en-US")} rows, ${QUERY_TIMEOUT_MS / 1000} seconds. Filter or join on ids (indexed) and use LIMIT.`,
        inputSchema: z.object({
          sql: z.string().min(1).max(MAX_SQL_CHARS),
          limit: z.number().int().min(1).max(MAX_ROWS).default(100).describe("Most rows to return"),
          ...(holdings ? { terms_token: z.string().optional().describe("termsToken from an earlier agreement to the disclosure terms") } : {}),
        }),
        annotations: readOnly,
      },
      async ({ sql, limit, terms_token }, ctx) => {
        // Asked before running anything that names the disclosure tables, and,
        // in case a query reaches them some other way, before returning rows from them.
        let gate: ReturnType<typeof agreed> | undefined;
        if (holdings && /disclosures/i.test(sql)) {
          gate = agreed(ctx, terms_token as string | undefined, client);
          if (!gate.agreed) return gate.result;
        }
        const result = await query(client, { file, attach, sql, maxRows: limit });
        if ("error" in result) return fail(result.error);
        if (!gate && result.read.some(isDisclosureTable)) {
          gate = agreed(ctx, terms_token as string | undefined, client);
          if (!gate.agreed) return gate.result;
        }
        // Keep the reply to a size a model can read, as get_record does.
        let { rows: out, truncated } = result;
        while (out.length > 1 && JSON.stringify(out).length > MAX_CHARS) {
          out = out.slice(0, Math.floor(out.length / 2));
          truncated = true;
        }
        return json({
          columns: result.columns,
          rows: out,
          ...(truncated ? { truncated: true } : {}),
          ...(result.read.some(isDisclosureTable) ? { notice: NOTICE } : {}),
          ...(gate?.agreed && gate.termsToken ? { termsToken: gate.termsToken, note: TOKEN_NOTE } : {}),
        });
      }
    );

    return server;
  };

  const handler = createMcpHandler(factory, { onerror: (err) => console.error("mcp:", err.message) });

  /** Serve one HTTP request to /mcp, from any origin. */
  return async function serve(req: http.IncomingMessage, res: http.ServerResponse) {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": req.headers["access-control-request-headers"] ?? "*",
      "Access-Control-Expose-Headers": "*",
      "Access-Control-Max-Age": "86400",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    try {
      const response = await handler.fetch(
        new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
          method: req.method,
          headers,
          body: hasBody ? (Readable.toWeb(req) as ReadableStream) : undefined,
          signal: abort.signal,
          duplex: "half",
        } as RequestInit)
      );
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), ...cors });
      // pipeline, not pipe: a client that hangs up mid-stream errors the body, and pipe leaves that error unhandled.
      if (response.body) pipeline(Readable.fromWeb(response.body as never), res, () => {});
      else res.end();
    } catch (err) {
      console.error("mcp:", err);
      if (!res.headersSent) res.writeHead(500, cors);
      res.end();
    }
  };
}
