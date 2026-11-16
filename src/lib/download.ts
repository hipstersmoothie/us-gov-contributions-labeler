// Download big files in parallel byte ranges; the FEC's bulk host caps each
// connection at a couple of MB/s.
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { currentCycle } from "./cycles.js";

const PARTS = 8;
const BIG = 50_000_000;
const DAY = 24 * 60 * 60 * 1000;
export const USER_AGENT = "contributions.fyi research (https://contributions.fyi)";
const HEADERS = { "User-Agent": USER_AGENT };

/** What the server said about a file when we downloaded it, kept next to it as `<file>.meta.json`. */
interface Remote {
  url: string;
  size: number;
  etag?: string;
  lastModified?: string;
  fetchedAt?: string;
}

async function head(url: string): Promise<Remote & { ranges: boolean }> {
  const res = await fetch(url, { method: "HEAD", redirect: "follow", headers: HEADERS });
  if (!res.ok) throw new Error(`${res.status} on HEAD ${url}`);
  return {
    // Range requests go straight to where the redirect lands.
    url: res.url || url,
    size: Number(res.headers.get("content-length")),
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
    ranges: res.headers.get("accept-ranges") === "bytes",
  };
}

const metaFile = (dest: string) => `${dest}.meta.json`;
function readMeta(dest: string): Remote | undefined {
  try {
    return JSON.parse(fs.readFileSync(metaFile(dest), "utf8"));
  } catch {
    return undefined;
  }
}

export async function downloadFile(url: string, dest: string, remote?: Remote & { ranges: boolean }) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  remote ??= await head(url);
  const { size } = remote;
  const ranges = remote.ranges && size > BIG;

  // Per process, so two runs sharing a cache can't write into the same file.
  const tmp = `${dest}.${process.pid}.part`;
  const fd = fs.openSync(tmp, "w");
  try {
    if (!ranges) {
      for (let attempt = 1; ; attempt++) {
        try {
          const res = await fetch(remote.url, { headers: HEADERS });
          if (!res.ok) throw new Error(`${res.status} downloading ${url}`);
          fs.writeSync(fd, Buffer.from(await res.arrayBuffer()), 0, undefined, 0);
          break;
        } catch (e) {
          if (attempt >= 3) throw e;
          await new Promise((r) => setTimeout(r, attempt * 5000));
        }
      }
    } else {
      const chunk = Math.ceil(size / PARTS);
      let done = 0;
      let lastLog = 0;
      await Promise.all(
        Array.from({ length: PARTS }, async (_, i) => {
          const start = i * chunk;
          const end = Math.min(size, start + chunk) - 1;
          let pos = start;
          // fec.gov drops a long connection now and then; pick up where it stopped.
          for (let attempt = 1; pos <= end; attempt++) {
            try {
              const res = await fetch(remote.url, { headers: { ...HEADERS, Range: `bytes=${pos}-${end}` } });
              if (res.status !== 206 || !res.body) throw new Error(`${res.status} on range ${pos}-${end} of ${url}`);
              for await (const piece of res.body as unknown as AsyncIterable<Uint8Array>) {
                fs.writeSync(fd, piece, 0, piece.length, pos);
                pos += piece.length;
                done += piece.length;
                if (done - lastLog > 500_000_000) {
                  lastLog = done;
                  console.log(`    ${path.basename(dest)}: ${Math.round((done / size) * 100)}%`);
                }
              }
              if (pos !== end + 1) throw new Error(`Short read on range ${start}-${end} of ${url}`);
            } catch (e) {
              if (attempt >= 5) throw e;
              console.log(`    ${path.basename(dest)}: ${(e as Error).message}; retrying from byte ${pos}`);
              await new Promise((r) => setTimeout(r, attempt * 5000));
            }
          }
        })
      );
    }
  } catch (e) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  fs.closeSync(fd);
  const got = fs.statSync(tmp).size;
  if (size && got !== size) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`Got ${got} bytes of ${size} for ${url}`);
  }
  // A zip with a broken central directory fails here rather than mid-ingest.
  if (dest.endsWith(".zip")) execFileSync("unzip", ["-Z1", tmp], { stdio: "ignore" });
  fs.renameSync(tmp, dest);
  const { ranges: _, ...meta } = remote;
  fs.writeFileSync(metaFile(dest), JSON.stringify({ ...meta, url, fetchedAt: new Date().toISOString() }) + "\n");
  return dest;
}

/**
 * Why a cached copy of `url` should be fetched again, or undefined if it's
 * current. The FEC rebuilds its bulk files every day or week, so a new ETag or
 * Last-Modified often means the same rows with new timestamps in the zip. A
 * different size always means new data. Small files are refetched on any
 * change; big ones on a size change, or once they're `maxAgeDays` old.
 */
export function staleReason(dest: string, remote: Remote, maxAgeDays: number): string | undefined {
  if (!fs.existsSync(dest)) return "not cached";
  const local = fs.statSync(dest).size;
  if (remote.size && local !== remote.size) return `size ${local} → ${remote.size}`;
  const saved = readMeta(dest);
  // Downloaded before we kept headers, and the same size: take it as current.
  if (!saved) return undefined;
  const changed =
    (remote.etag && saved.etag && remote.etag !== saved.etag) ||
    (remote.lastModified && saved.lastModified && remote.lastModified !== saved.lastModified);
  if (!changed) return undefined;
  if (remote.size <= BIG) return `republished ${remote.lastModified ?? ""}`.trim();
  const age = Date.now() - new Date(saved.fetchedAt ?? fs.statSync(dest).mtime).getTime();
  if (age > maxAgeDays * DAY) return `republished, copy ${Math.floor(age / DAY)} days old`;
  return undefined;
}

// One check per file per run, and one download even if two steps ask at once.
const pending = new Map<string, Promise<string>>();

/** `url` cached at `dest`, fetched again when the server's copy changed. */
export function cachedDownload(url: string, dest: string, maxAgeDays: number) {
  // Worktrees link to one shared cache; update the shared copy, not the link.
  if (fs.lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink()) dest = fs.realpathSync(dest);
  let p = pending.get(dest);
  if (!p) {
    p = refresh(url, dest, maxAgeDays);
    pending.set(dest, p);
  }
  return p;
}

async function refresh(url: string, dest: string, maxAgeDays: number) {
  let remote;
  try {
    remote = await head(url);
  } catch (e) {
    if (!fs.existsSync(dest)) throw e;
    console.warn(`  couldn't check ${path.basename(dest)} (${(e as Error).message}); using the cached copy`);
    return dest;
  }
  const reason = staleReason(dest, remote, maxAgeDays);
  if (!reason) {
    if (!readMeta(dest)) {
      const { ranges: _, ...meta } = remote;
      fs.writeFileSync(metaFile(dest), JSON.stringify({ ...meta, url, fetchedAt: fs.statSync(dest).mtime.toISOString() }) + "\n");
    }
    return dest;
  }
  console.log(`  downloading ${path.basename(dest)} (${reason})`);
  return downloadFile(url, dest, remote);
}

export const FEC_BULK_URL = "https://www.fec.gov/files/bulk-downloads";

/**
 * A file from the FEC's bulk downloads, cached in .cache/fec/<cycle>/. Past
 * cycles do get republished with late amendments, so they're checked too, but
 * a same-size republish of a big file is only taken every few months.
 */
export function fecBulk(cycle: number, file: string) {
  const dest = path.join(".cache/fec", String(cycle), file);
  return cachedDownload(`${FEC_BULK_URL}/${cycle}/${file}`, dest, cycle >= currentCycle() ? 7 : 90);
}
