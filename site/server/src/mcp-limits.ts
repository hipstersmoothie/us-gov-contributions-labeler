// The MCP server's limits (mcp.ts), here so the site's /mcp/ page can quote them.

/** How long a query may run. */
export const QUERY_TIMEOUT_MS = 10_000;
/** Most rows a query returns. */
export const MAX_ROWS = 1000;
/** Disclosure records a client can read in an hour before it needs the user's agreement. */
export const FREE_RECORDS = 25;
/** And all clients together, since a client can claim to be many (X-Forwarded-For). */
export const FREE_RECORDS_OVERALL = 500;
/** How long an agreement to the disclosure terms lasts. */
export const AGREED_HOURS = 24;
