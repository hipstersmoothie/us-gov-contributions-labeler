// Match disclosed assets to SEC companies, our sectors and the site's
// organizations.
import fs from "fs";
import { normalizeOrg } from "../../lib/names.js";
import { sectorForSic, type Sector } from "../../lib/sectors.js";
import { USER_AGENT } from "./common.js";

const tickers = JSON.parse(fs.readFileSync(".cache/enrich/sec-tickers.json", "utf8")) as Record<
  string,
  { cik_str: number; ticker: string; title: string }
>;
const byTicker = new Map<string, { cik: number; title: string }>();
const byName = new Map<string, { cik: number; ticker: string; title: string }>();
for (const t of Object.values(tickers)) {
  const tk = t.ticker.toUpperCase().replace(/-/g, ".");
  if (!byTicker.has(tk)) byTicker.set(tk, { cik: t.cik_str, title: t.title });
  const key = normalizeOrg(t.title);
  if (key && !byName.has(key)) byName.set(key, { cik: t.cik_str, ticker: t.ticker, title: t.title });
}

const SIC_FILE = ".cache/disclosures/sic.json";
const sics: Record<string, { sic?: number; sicDescription?: string; name?: string }> = fs.existsSync(SIC_FILE)
  ? JSON.parse(fs.readFileSync(SIC_FILE, "utf8"))
  : {};
for (const [cik, e] of Object.entries(
  JSON.parse(fs.readFileSync(".cache/enrich/sec.json", "utf8")) as Record<string, { value: any }>
)) {
  sics[cik] ??= { sic: e.value.sic, sicDescription: e.value.sicDescription, name: e.value.name };
}

let last = 0;
async function sicFor(cik: number) {
  if (sics[cik]) return sics[cik];
  const wait = last + 200 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const res = await fetch(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`, {
    headers: { "User-Agent": process.env.SEC_USER_AGENT ?? USER_AGENT },
  });
  const json = res.ok ? ((await res.json()) as any) : {};
  sics[cik] = { sic: json.sic ? Number(json.sic) : undefined, sicDescription: json.sicDescription, name: json.name };
  fs.writeFileSync(SIC_FILE, JSON.stringify(sics));
  return sics[cik]!;
}

const orgs = JSON.parse(fs.readFileSync("data/organizations.json", "utf8")).organizations as {
  id: string;
  name: string;
  sec?: { cik: number };
  total: number;
}[];
const orgByCik = new Map(orgs.filter((o) => o.sec?.cik).map((o) => [o.sec!.cik, o]));

export interface Match {
  how: "ticker" | "name";
  cik: number;
  ticker?: string;
  company: string;
  sic?: number;
  industry?: string;
  sector: Sector;
  /** The site's organization page for this company, if it has a PAC we track. */
  org?: string;
}

/** Strip share classes and filing boilerplate off an asset name. */
function companyName(asset: string) {
  return asset
    .replace(/\[[A-Z0-9]{2}\]\s*$/, "")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+-\s+(Class|Series|Common|Ordinary|ADR|American Depositary|Sponsored).*$/i, "")
    .replace(/\b(Common Stock|Ordinary Shares|Class [A-C]|Cl [A-C]|CMN|COM)\b.*$/i, "")
    .trim();
}

// --- loose names, for assets read from scanned paper forms ---------------------

const SEC_NAMES = [...byName.keys()].sort();
const ABBREVIATIONS: [RegExp, string][] = [
  [/\bINTL\b/g, "INTERNATIONAL"], [/\bPMTS\b/g, "PAYMENTS"], [/\bAPT\b/g, "APARTMENT"],
  [/\bCMNTYS\b/g, "COMMUNITIES"], [/\bMC (?=[A-Z])/g, "MC"], [/\bHLDGCO\b/g, ""], [/\bHLDGS?\b/g, ""],
  [/\bEXCHG\b/g, "EXCHANGE"], [/\bSVCS\b/g, "SERVICES"], [/\bTECH\b/g, "TECHNOLOGIES"],
];
/** Suffixes that scans cut short ("INCORPORA", "CORPORATI", "PUBLIC LIMITED COMPA"). */
const CUT = /\s+(INCORP\w*|CORPOR\w*|COMPA\w*|PUBLIC LIMITED\w*|PUBLIC\b.*|LIMITED|IN|HOLDING\w*|N ?V|NV.*|SE|AG|PLC|ADR|SPON\w*|UNSP\w*|REG SHS|ORD|NEW|GEORGIA|DEL\w*)$/;

function looseKey(asset: string) {
  let n = normalizeOrg(companyName(asset).replace(/\/THE$|\bTHE\b/gi, ""));
  for (const [re, to] of ABBREVIATIONS) n = n.replace(re, to);
  n = n.replace(/\s+/g, " ").trim();
  for (let i = 0; i < 4; i++) n = n.replace(CUT, "").trim();
  return n;
}

/** A unique SEC company whose normalized name is, or starts with, the loose key. */
function looseMatch(asset: string) {
  const key = looseKey(asset);
  if (key.length < 3) return undefined;
  const exact = byName.get(key);
  if (exact) return exact;
  // Plural/singular drift ("PHARMACEUTICAL" for "PHARMACEUTICALS").
  const starts = SEC_NAMES.filter((n) => n.startsWith(key) && (n.length === key.length || n[key.length] === " " || n[key.length] === "S"));
  if (starts.length === 1 || (starts.length > 1 && starts.length <= 3 && key.split(" ").length >= 2)) return byName.get(starts.sort((a, b) => a.length - b.length)[0]!);
  return undefined;
}

export async function matchAsset(asset: string, ticker?: string, loose = false): Promise<Match | undefined> {
  let hit: { cik: number; title: string; ticker?: string; how: Match["how"] } | undefined;
  const tk = ticker?.toUpperCase().replace(/-/g, ".");
  if (tk && byTicker.has(tk)) hit = { ...byTicker.get(tk)!, ticker: tk, how: "ticker" };
  if (!hit) {
    const n = byName.get(normalizeOrg(companyName(asset))) ?? (loose ? looseMatch(asset) : undefined);
    if (n) hit = { cik: n.cik, title: n.title, ticker: n.ticker, how: "name" };
  }
  if (!hit) return undefined;
  const s = await sicFor(hit.cik);
  return {
    how: hit.how,
    cik: hit.cik,
    ticker: hit.ticker,
    company: s.name ?? hit.title,
    sic: s.sic,
    industry: s.sicDescription,
    sector: s.sic ? sectorForSic(s.sic) : "Unknown",
    org: orgByCik.get(hit.cik)?.id,
  };
}
