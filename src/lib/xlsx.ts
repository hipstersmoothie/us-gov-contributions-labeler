// Just enough of the .xlsx format to read the FEC's election spreadsheets:
// each sheet as rows of cell text. An .xlsx is a zip of XML parts; cell
// strings live in a shared table, referenced by index.
import { execFileSync } from "child_process";
import { XMLParser } from "fast-xml-parser";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", textNodeName: "text", parseTagValue: false, isArray: (name) => ["si", "r", "row", "c", "sheet", "Relationship"].includes(name) });
const part = (file: string, name: string) => {
  try {
    return execFileSync("unzip", ["-p", file, name], { encoding: "utf8", maxBuffer: 1 << 30 });
  } catch {
    return "";
  }
};
/** Text of a node that may be a string, a number, { text }, or rich-text runs. */
const text = (n: unknown): string => {
  if (n === undefined || n === null) return "";
  if (typeof n === "string" || typeof n === "number" || typeof n === "boolean") return String(n);
  const o = n as { text?: unknown; t?: unknown; r?: unknown[] };
  if (o.r) return o.r.map((x) => text((x as { t?: unknown }).t)).join("");
  if (o.t !== undefined) return text(o.t);
  return o.text !== undefined ? String(o.text) : "";
};
/** "BC12" -> 54 (0-based column). */
const column = (ref: string) => {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

/** Every sheet in the workbook, by name, as rows of trimmed cell text. */
export function readXlsx(file: string): Map<string, string[][]> {
  const strings = ((parser.parse(part(file, "xl/sharedStrings.xml")).sst?.si ?? []) as unknown[]).map(text);
  const book = parser.parse(part(file, "xl/workbook.xml")).workbook;
  const rels = (parser.parse(part(file, "xl/_rels/workbook.xml.rels")).Relationships?.Relationship ?? []) as { "@Id": string; "@Target": string }[];
  const out = new Map<string, string[][]>();
  for (const sheet of (book?.sheets?.sheet ?? []) as Record<string, string>[]) {
    const target = rels.find((r) => r["@Id"] === sheet["@r:id"])?.["@Target"] ?? "";
    const xml = part(file, `xl/${target.replace(/^\/?xl\//, "")}`);
    const rows: string[][] = [];
    for (const row of (parser.parse(xml).worksheet?.sheetData?.row ?? []) as { c?: { "@r": string; "@t"?: string; v?: unknown; is?: unknown }[] }[]) {
      const cells: string[] = [];
      for (const c of row.c ?? []) {
        const v = c["@t"] === "s" ? strings[Number(text(c.v))] ?? "" : c["@t"] === "inlineStr" ? text(c.is) : text(c.v);
        cells[column(c["@r"])] = v.trim();
      }
      rows.push(Array.from(cells, (x) => x ?? ""));
    }
    out.set(sheet["@name"]!, rows);
  }
  return out;
}
