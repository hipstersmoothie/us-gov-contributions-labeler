// Runs one query for the MCP server's query tool (see query() in mcp.ts), in
// its own process so a slow one can be killed without stalling the website:
// node:sqlite is synchronous and has no way to interrupt a statement.
//
// What keeps a query from changing anything:
//   - the connection is read-only, and so are the files it attaches;
//   - the authorizer allows reading and nothing else: no writes, no schema
//     changes, no ATTACH of its own (other files on disk), no PRAGMA, VACUUM
//     or transactions, and none of the functions in DENIED;
//   - defensive mode, which closes off the ways to corrupt a database that
//     don't need a write.
// What keeps one from using too much:
//   - SQLite's limits (LIMITS): no value over 1 MB, no huge statements. The
//     heap limit pragma does nothing here (Node builds SQLite without memory
//     statistics), so the value size is what stops randomblob(1e9) and the like;
//   - a small page cache, so big sorts and joins spill to temporary files,
//     which go when the process does, rather than to memory;
//   - the reply is cut off at MAX_REPLY bytes here, so the web server never
//     receives more;
//   - mcp.ts kills the process after 10 seconds, and limits how many run.
// Only the first statement runs; anything after it is ignored.
import { DatabaseSync, constants } from "node:sqlite";

export interface QueryRequest {
  file: string;
  /** Other files to attach, by schema name. */
  attach: Record<string, string>;
  sql: string;
  maxRows: number;
}
/** `read` lists the tables the query read, so the server can attach notices. */
export type QueryResult = { columns: string[]; rows: unknown[][]; truncated: boolean; read: string[] } | { error: string };

const ALLOWED = new Set([constants.SQLITE_SELECT, constants.SQLITE_READ, constants.SQLITE_FUNCTION, constants.SQLITE_RECURSIVE]);
/** Functions no query needs: loading code, and FTS3's tokenizer pointers. */
const DENIED = new Set(["load_extension", "fts3_tokenizer"]);
/** Per connection (sqlite3_limit). attach allows the filing files, which are attached before the authorizer is set. */
const LIMITS = {
  length: 1_000_000,
  sqlLength: 100_000,
  exprDepth: 200,
  compoundSelect: 50,
  vdbeOp: 500_000,
  attach: 2,
  likePatternLength: 1_000,
};
/** Most bytes of rows to send back; mcp.ts trims the reply further. */
const MAX_REPLY = 2_000_000;

/** A value as JSON can carry it: blobs by their size, not their bytes. */
const cell = (v: unknown) => (v instanceof Uint8Array ? `<blob, ${v.length} bytes>` : v);

function run({ file, attach, sql, maxRows }: QueryRequest): QueryResult {
  const db = new DatabaseSync(file, { readOnly: true, limits: LIMITS } as ConstructorParameters<typeof DatabaseSync>[1]);
  // The limits are what bound memory. If this Node doesn't apply them, run nothing.
  try {
    db.prepare("SELECT zeroblob(?)").get(LIMITS.length + 1);
    return { error: "Queries are unavailable: this server's SQLite doesn't apply size limits." };
  } catch {}
  db.enableDefensive(true);
  for (const [schema, path] of Object.entries(attach)) db.prepare(`ATTACH DATABASE ? AS ${schema}`).run(path);
  db.exec("PRAGMA cache_size = -16000"); // 16 MB
  const read = new Set<string>();
  db.setAuthorizer((action, table, fn) => {
    if (action === constants.SQLITE_READ && table) read.add(table);
    if (action === constants.SQLITE_FUNCTION && fn && DENIED.has(fn.toLowerCase())) return constants.SQLITE_DENY;
    return ALLOWED.has(action) ? constants.SQLITE_OK : constants.SQLITE_DENY;
  });
  const statement = db.prepare(sql);
  statement.setReturnArrays(true);
  const rows: unknown[][] = [];
  let truncated = false;
  let bytes = 0;
  for (const row of statement.iterate()) {
    const values = (row as unknown as unknown[]).map(cell);
    bytes += JSON.stringify(values).length;
    if (rows.length === maxRows || bytes > MAX_REPLY) {
      truncated = true;
      break;
    }
    rows.push(values);
  }
  return { columns: statement.columns().map((c) => c.name), rows, truncated, read: [...read] };
}

process.once("message", (request: QueryRequest) => {
  let result: QueryResult;
  try {
    result = run(request);
  } catch (err) {
    result = { error: err instanceof Error ? err.message : String(err) };
  }
  process.send!(result, () => process.exit(0));
});
