// Page images out of the first 8 MB of a Senate travel filing.
//
// The Senate's PDFs are written by iText one page at a time: a gray
// soft mask, the page's RGB scan (3400 × 4400, Flate), then the page object.
// A truncated file can't be opened as a PDF, but every page whose image is
// complete can be decoded straight from its stream.
import fs from "fs";
import zlib from "zlib";

export interface PageImage {
  width: number;
  height: number;
  /** 8-bit gray, row by row. */
  gray: Buffer;
}

export function pageImages(pdf: Buffer, max = 4): PageImage[] {
  const out: PageImage[] = [];
  const re = /\d+ 0 obj\s*<<([^]*?)>>\s*stream\r?\n/g;
  const head = pdf.toString("latin1");
  let m: RegExpExecArray | null;
  while ((m = re.exec(head)) && out.length < max) {
    const dict = m[1]!;
    if (!/\/Subtype\s*\/Image/.test(dict) || !/\/DeviceRGB/.test(dict) || !/\/FlateDecode/.test(dict)) continue;
    const width = Number(dict.match(/\/Width (\d+)/)?.[1]);
    const height = Number(dict.match(/\/Height (\d+)/)?.[1]);
    const length = Number(dict.match(/\/Length (\d+)/)?.[1]);
    const start = m.index + m[0].length;
    if (!width || !height || !length || start + length > pdf.length) break;
    re.lastIndex = start + length;
    let rgb: Buffer;
    try {
      rgb = zlib.inflateSync(pdf.subarray(start, start + length));
    } catch {
      break;
    }
    if (rgb.length < width * height * 3) break;
    // Half size, gray: plenty for OCR at 300 dpi scans.
    const w = width >> 1, h = height >> 1;
    const gray = Buffer.alloc(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = ((y * 2) * width + x * 2) * 3;
        gray[y * w + x] = (rgb[i]! * 299 + rgb[i + 1]! * 587 + rgb[i + 2]! * 114) / 1000;
      }
    out.push({ width: w, height: h, gray });
  }
  return out;
}

/** A minimal 8-bit grayscale PNG. */
export function png({ width, height, gray }: PageImage): Buffer {
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) gray.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 3 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

if (process.argv[1]?.endsWith("senate-pages.ts")) {
  const id = process.argv[2]!;
  const pages = pageImages(fs.readFileSync(`.cache/travel/senate/head/${id}.pdf`));
  pages.forEach((p, i) => fs.writeFileSync(`/tmp/${id}-${i + 1}.png`, png(p)));
  console.log(`${pages.length} pages`);
}
