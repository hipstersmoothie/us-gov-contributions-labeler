// Download big files in parallel byte ranges; the FEC's bulk host caps each
// connection at a couple of MB/s.
import fs from "fs";
import path from "path";

const PARTS = 8;

export async function downloadFile(url: string, dest: string) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const head = await fetch(url, { method: "HEAD", redirect: "follow" });
  // Range requests go straight to where the redirect lands.
  url = head.url || url;
  const size = Number(head.headers.get("content-length"));
  const ranges = head.headers.get("accept-ranges") === "bytes" && size > 50_000_000;

  const tmp = `${dest}.part`;
  const fd = fs.openSync(tmp, "w");
  try {
    if (!ranges) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${res.status} downloading ${url}`);
      fs.writeSync(fd, Buffer.from(await res.arrayBuffer()));
    } else {
      const chunk = Math.ceil(size / PARTS);
      let done = 0;
      let lastLog = 0;
      await Promise.all(
        Array.from({ length: PARTS }, async (_, i) => {
          const start = i * chunk;
          const end = Math.min(size, start + chunk) - 1;
          const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } });
          if (res.status !== 206 || !res.body) throw new Error(`${res.status} on range ${start}-${end} of ${url}`);
          let pos = start;
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
        })
      );
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, dest);
  return dest;
}
