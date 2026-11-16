// Read the cost of every downloaded House filing: form fields or text first
// (house-parse.ts), then OCR of the sponsor's post-travel form when it's a
// scan. Cached per filing under .cache/travel/house/read/.
//
// A scanned cost is kept only when two renders of the page, at different
// sizes, read the same figures, and every figure was read with its dollar
// sign.
//
//   tsx src/scripts/travel/house-read.ts [--limit=N]
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { parseArgs } from "util";
import { CACHE } from "./common.js";
import { parseHouse, costFromOcr, type Cost } from "./house-parse.js";

const VERSION = 3;

export interface HouseRead {
  v: number;
  pages: number;
  scanned: number;
  cost?: Cost;
  /** Joint sponsors' forms, when more than one. */
  others?: Cost[];
  /** Why there's no cost: no sponsor form found, or it couldn't be read. */
  missing?: "no-form" | "unread" | "unsure";
}

function ocrPages(file: string, pages: number[], size: number) {
  if (!pages.length) return [];
  return JSON.parse(
    execFileSync(path.join(CACHE, "ocr"), [`--size=${size}`, file, pages.join(",")], { maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] }).toString()
  ) as { page: number; lines: any[] }[];
}

/** `cachedOnly` returns only what an earlier run read (the build doesn't OCR). */
export async function readHouse(docId: string, cachedOnly = false): Promise<HouseRead | undefined> {
  const cached = path.join(CACHE, "house/read", `${docId}.json`);
  if (fs.existsSync(cached)) {
    const r = JSON.parse(fs.readFileSync(cached, "utf8")) as HouseRead;
    if (r.v === VERSION) return r;
  }
  const file = path.join(CACHE, "house/pdf", `${docId}.pdf`);
  if (cachedOnly || !fs.existsSync(file)) return undefined;
  const parsed = await parseHouse(fs.readFileSync(file));
  const out: HouseRead = { v: VERSION, pages: parsed.pages, scanned: parsed.imagePages.length };
  let costs = parsed.costs;
  if (!costs.length) {
    // The sponsor's form is almost always within the first few pages.
    const candidates = [...new Set([...parsed.imagePages.filter((p) => p <= 6), ...parsed.blankPages])].sort((a, b) => a - b);
    const first = ocrPages(file, candidates, 2200);
    const found = first.flatMap((p) => {
      const c = costFromOcr(p.lines, p.page);
      return c ? [c] : [];
    });
    if (found.length) {
      const again = ocrPages(file, found.map((c) => c.page), 3000);
      for (const c of found) {
        const p = again.find((x) => x.page === c.page);
        const c2 = p && costFromOcr(p.lines, p.page);
        if (!c2 || c2.unsure || Math.abs(c2.total - c.total) > 0.01 || c2.partial !== c.partial) c.unsure = true;
      }
      costs = found;
    }
    const sawForm = first.some((p) => /SPONSOR POST-?TRAVEL|Actual amount of expenses/i.test(p.lines.map((l: any) => l.s).join(" ")));
    if (!found.length) out.missing = sawForm || parsed.blankForm ? "unread" : "no-form";
  }
  const sure = costs.filter((c) => !c.unsure);
  if (costs.length && !sure.length) out.missing = "unsure";
  // Duplicate copies of one sponsor form in a filing count once.
  const distinct = sure.filter((c, i) => sure.findIndex((d) => d.total === c.total && d.sponsor === c.sponsor) === i);
  if (distinct.length) {
    out.cost = distinct[0];
    if (distinct.length > 1) out.others = distinct.slice(1);
  }
  if (costs.some((c) => c.unsure)) (out as any).unsure = costs.filter((c) => c.unsure);
  fs.mkdirSync(path.dirname(cached), { recursive: true });
  fs.writeFileSync(cached, JSON.stringify(out));
  return out;
}

if (process.argv[1]?.endsWith("house-read.ts")) {
  const { values } = parseArgs({ options: { limit: { type: "string", default: "100000" } } });
  const ids = fs.readdirSync(path.join(CACHE, "house/pdf")).map((f) => f.replace(/\.pdf$/, "")).sort().slice(0, Number(values.limit));
  const by: Record<string, number> = {};
  let n = 0;
  for (const id of ids) {
    let r: HouseRead | undefined;
    try {
      r = await readHouse(id);
    } catch (e) {
      console.error(id, String(e).slice(0, 100));
      continue;
    }
    if (!r) continue;
    const k = r.cost ? `cost:${r.cost.via}` : `missing:${r.missing}`;
    by[k] = (by[k] ?? 0) + 1;
    if (++n % 100 === 0) console.error(n, JSON.stringify(by));
  }
  console.log(n, by);
}
