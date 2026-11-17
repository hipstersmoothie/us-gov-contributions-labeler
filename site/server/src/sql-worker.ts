// Runs one query for the MCP server's query tool (see query() in mcp.ts), in
// its own process so a slow one can be killed without stalling the website:
// node:sqlite is synchronous and has no way to interrupt a statement.
//
// The connection is read-only, and the authorizer allows reading and nothing
// else: no ATTACH of its own (other files on disk), no PRAGMA, no writes to
// temp tables. The filing-level files are attached before it's set.
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

function run({ file, attach, sql, maxRows }: QueryRequest): QueryResult {
  const db = new DatabaseSync(file, { readOnly: true });
  for (const [schema, path] of Object.entries(attach)) db.prepare(`ATTACH DATABASE ? AS ${schema}`).run(path);
  // Sorts and temp b-trees count against this; a query that needs more fails instead of growing.
  db.exec("PRAGMA hard_heap_limit = 268435456");
  const read = new Set<string>();
  db.setAuthorizer((action, table) => {
    if (action === constants.SQLITE_READ && table) read.add(table);
    return ALLOWED.has(action) ? constants.SQLITE_OK : constants.SQLITE_DENY;
  });
  const statement = db.prepare(sql);
  statement.setReturnArrays(true);
  const rows: unknown[][] = [];
  let truncated = false;
  for (const row of statement.iterate()) {
    if (rows.length === maxRows) {
      truncated = true;
      break;
    }
    rows.push(row as unknown as unknown[]);
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
