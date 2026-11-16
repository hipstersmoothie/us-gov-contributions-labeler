// Which cached FEC bulk files are out of date with fec.gov. HEAD requests only.
//
//   pnpm fec-audit            .cache/fec
//   pnpm fec-audit <dir>      another cache's fec/ directory
import fs from "fs";
import path from "path";
import { FEC_BULK_URL, USER_AGENT, staleReason } from "../lib/download.js";
import { currentCycle } from "../lib/cycles.js";

const root = process.argv[2] ?? ".cache/fec";
let stale = 0;
for (const cycle of fs.readdirSync(root).filter((d) => /^\d{4}$/.test(d)).sort()) {
  for (const file of fs.readdirSync(path.join(root, cycle)).filter((f) => /\.(zip|csv)$/.test(f)).sort()) {
    const res = await fetch(`${FEC_BULK_URL}/${cycle}/${file}`, { method: "HEAD", headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) {
      console.log(`${cycle}/${file}: ${res.status}`);
      continue;
    }
    const remote = {
      url: res.url,
      size: Number(res.headers.get("content-length")),
      etag: res.headers.get("etag") ?? undefined,
      lastModified: res.headers.get("last-modified") ?? undefined,
    };
    const reason = staleReason(path.join(root, cycle, file), remote, Number(cycle) >= currentCycle() ? 7 : 90);
    if (reason) stale++;
    console.log(`${reason ? "STALE" : "ok   "} ${cycle}/${file}${reason ? `: ${reason}` : ""}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}
console.log(`${stale} stale`);
