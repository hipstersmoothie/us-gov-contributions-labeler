// Fetch real responses from the data repository for the examples on the
// /open-data page, with long lists shortened so they stay readable.
//
//   pnpm open-data-examples
//
// Writes site/src/data/open-data-examples.json. Re-run after a publish if the
// record shapes change.
import fs from "fs";
import path from "path";

const XRPC = "https://pds.contributions.fyi/xrpc";
const DID = "did:plc:ej5cllsvxdrzdsweyfgr2nge";
const OUT = "site/src/data/open-data-examples.json";

// Pelosi's official account and Cantwell's member record are the examples.
const ACCOUNT_DID = "did:plc:sp4ywsk4ykfkw2cshoqo3s7p";
const MEMBER = "C000127";

/** Keep the first few entries of every list, at any depth. */
function shorten(value: unknown, keep: number): unknown {
  if (Array.isArray(value)) return value.slice(0, keep).map((v) => shorten(v, keep));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v, keep)]));
  }
  return value;
}

async function get(method: string, params: Record<string, string>) {
  const url = `${XRPC}/${method}?${new URLSearchParams({ repo: DID, ...params })}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return res.json();
}

const examples = {
  account: shorten(
    await get("com.atproto.repo.getRecord", { collection: "fyi.contributions.account", rkey: ACCOUNT_DID }),
    3
  ),
  dataset: shorten(await get("com.atproto.repo.getRecord", { collection: "fyi.contributions.dataset", rkey: "self" }), 2),
  member: shorten(await get("com.atproto.repo.getRecord", { collection: "fyi.contributions.member", rkey: MEMBER }), 2),
  list: shorten(
    await get("com.atproto.repo.listRecords", { collection: "fyi.contributions.committee", limit: "2" }),
    2
  ),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ fetchedAt: new Date().toISOString(), ...examples }, null, 2) + "\n");
console.log(`Wrote ${OUT}`);
