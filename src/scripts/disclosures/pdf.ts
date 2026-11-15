// Text out of a disclosure PDF: positioned text runs, and lines in reading
// order.
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

export interface Run {
  x: number;
  y: number;
  s: string;
}

export interface PdfText {
  pages: number;
  /** Text runs per page, top to bottom then left to right. */
  runs: Run[][];
  /** One array of lines per page. */
  lines: string[][];
  chars: number;
}

export async function pdfText(data: Buffer): Promise<PdfText> {
  const doc = await getDocument({
    data: new Uint8Array(data),
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const runs: Run[][] = [];
  const lines: string[][] = [];
  let chars = 0;
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const pageRuns: Run[] = [];
    for (const item of content.items as any[]) {
      if (!item.str?.trim()) continue;
      // Snap baselines so runs on the same printed line share a y.
      pageRuns.push({ x: item.transform[4], y: Math.round(item.transform[5] / 2) * 2, s: item.str });
      chars += item.str.length;
    }
    pageRuns.sort((a, b) => b.y - a.y || a.x - b.x);
    runs.push(pageRuns);

    const rows = new Map<number, Run[]>();
    for (const r of pageRuns) rows.set(r.y, [...(rows.get(r.y) ?? []), r]);
    lines.push([...rows.values()].map((r) => r.map((i) => i.s).join("  ").replace(/\s+/g, " ").trim()));
  }
  await doc.cleanup?.();
  return { pages: doc.numPages, runs, lines, chars };
}
