// OCR the first pages of every downloaded Senate filing (cached per filing
// under .cache/travel/senate/ocr/) and parse them.
//
//   tsx src/scripts/travel/senate-read.ts [--limit=N] [--show]
import fs from "fs";
import path from "path";
import os from "os";
import { execFileSync } from "child_process";
import { parseArgs } from "util";
import { CACHE } from "./common.js";
import { pageImages, png } from "./senate-pages.js";
import { parseSenate, type OcrPage, type SenateParse } from "./senate-parse.js";

const OCR_BIN = path.join(CACHE, "ocr");

/** OCR'd pages for one filing, from cache or by decoding its first pages. */
export function senateOcr(id: string, cachedOnly = false): OcrPage[] | undefined {
  const cached = path.join(CACHE, "senate/ocr", `${id}.json`);
  if (fs.existsSync(cached)) return JSON.parse(fs.readFileSync(cached, "utf8"));
  const head = path.join(CACHE, "senate/head", `${id}.pdf`);
  if (cachedOnly || !fs.existsSync(head)) return undefined;
  const images = pageImages(fs.readFileSync(head), 4);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "senate-"));
  const files = images.map((img, i) => {
    const f = path.join(tmp, `${i + 1}.png`);
    fs.writeFileSync(f, png(img));
    return f;
  });
  const pages: OcrPage[] = files.length ? JSON.parse(execFileSync(OCR_BIN, files, { maxBuffer: 64 << 20 }).toString()) : [];
  fs.rmSync(tmp, { recursive: true });
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, JSON.stringify(pages));
  return pages;
}

export function readSenate(id: string, cachedOnly = false): SenateParse | undefined {
  const pages = senateOcr(id, cachedOnly);
  return pages && parseSenate(pages);
}

if (process.argv[1]?.endsWith("senate-read.ts")) {
  const { values } = parseArgs({ options: { limit: { type: "string", default: "100000" }, show: { type: "boolean", default: false } } });
  const ids = fs.readdirSync(path.join(CACHE, "senate/head")).map((f) => f.replace(/\.pdf$/, "")).slice(0, Number(values.limit));
  let sponsor = 0, cost = 0, dest = 0, n = 0;
  for (const id of ids) {
    const r = readSenate(id);
    if (!r) continue;
    n++;
    if (r.sponsor) sponsor++;
    if (r.cost && !r.cost.partial) cost++;
    if (r.destination) dest++;
    if (values.show) console.log(id, "|", r.sponsor, "|", r.destination, "|", r.cost ? `${JSON.stringify(r.cost.parts)}${r.cost.partial ? " partial" : ""}` : "-");
    if (n % 50 === 0) console.error(`${n}/${ids.length}`);
  }
  console.log({ n, sponsor, destination: dest, cost });
}
