// Privately sponsored travel: the House Clerk's and the Secretary of the
// Senate's yearly indexes, matched to current members, and a polite, cached
// fetch for the filings themselves.
//
// These are filed under House Rule XXV, clause 5 and Senate Rule XXXV, and
// published under sections 304 and 546 of the Honest Leadership and Open
// Government Act of 2007. They aren't financial disclosure reports, so
// 5 U.S.C. § 13107 doesn't reach them (see design/travel/README.md).
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { XMLParser } from "fast-xml-parser";
import { getCurrentLegislators, type Legislator } from "../../lib/legislators.js";
import { USER_AGENT, fold } from "../disclosures/common.js";

export const CACHE = ".cache/travel";
/** Trips are counted from this date on, the day the 119th Congress convened,
 *  and keep accumulating across Congresses. The one place the date is set:
 *  build.ts writes it into data/travel.json, and the site reads it from there. */
export const SINCE = "2025-01-03";
/** The Clerk's yearly indexes go by filing year: from SINCE's to this one. */
export const HOUSE_YEARS = Array.from({ length: new Date().getFullYear() - Number(SINCE.slice(0, 4)) + 1 }, (_, i) => Number(SINCE.slice(0, 4)) + i);
/** Indexes older than this are downloaded again; filings never are. */
const INDEX_MAX_AGE_MS = 20 * 3600 * 1000;

const lastRequest = new Map<string, number>();

/** Fetch a URL at most once (cached under .cache/travel), pacing each host.
 *  With `maxAgeMs`, a cached copy older than that is fetched again. */
export async function cachedFetch(url: string, file: string, intervalMs = 2000, maxAgeMs = Infinity): Promise<Buffer> {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest) && Date.now() - fs.statSync(dest).mtimeMs < maxAgeMs) return fs.readFileSync(dest);
  const host = new URL(url).host;
  const wait = (lastRequest.get(host) ?? 0) + intervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest.set(host, Date.now());
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  const body = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  return body;
}

/** An index ZIP, fetched again once a day and unzipped next to it. */
async function index(url: string, zip: string, dir: string) {
  const before = fs.existsSync(path.join(CACHE, zip)) ? fs.statSync(path.join(CACHE, zip)).mtimeMs : 0;
  await cachedFetch(url, zip, 2000, INDEX_MAX_AGE_MS);
  if (fs.statSync(path.join(CACHE, zip)).mtimeMs !== before || !fs.existsSync(path.join(CACHE, dir))) {
    fs.mkdirSync(path.join(CACHE, dir), { recursive: true });
    execFileSync("unzip", ["-o", "-q", path.join(CACHE, zip), "-d", path.join(CACHE, dir)]);
  }
}

export async function legislators(): Promise<Legislator[]> {
  const file = path.join(CACHE, "legislators-current.json");
  // Members change (resignations, special elections); refetch after a few days.
  if (fs.existsSync(file) && Date.now() - fs.statSync(file).mtimeMs < 3 * 86400_000) return JSON.parse(fs.readFileSync(file, "utf8"));
  const list = await getCurrentLegislators();
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(list));
  return list;
}

const usDate = (s: string) => {
  const m = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}` : "";
};

const clean = (s: unknown) => String(s ?? "").replace(/\s+/g, " ").trim();

/** Match a "Last, First" office name to a current member, by state when given. */
export function matcher(list: Legislator[]) {
  return (office: string, state?: string, district?: number) => {
    const [lastRaw, firstRaw = ""] = office.split(",").map((s) => s.trim());
    const last = fold(lastRaw!);
    const first = fold(firstRaw.split(" ")[0] ?? "");
    let pool = list.filter((l) => !state || l.state === state);
    const sameLast = pool.filter((l) => {
      const ll = fold(l.last);
      return ll === last || ll.endsWith(last) || last.endsWith(ll) || fold(`${l.first}${l.last}`).includes(last);
    });
    if (sameLast.length === 1) return sameLast[0];
    const byFirst = sameLast.filter((l) => [l.first, l.nickname ?? ""].some((n) => n && fold(n).slice(0, 3) === first.slice(0, 3)));
    if (byFirst.length === 1) return byFirst[0];
    const byDistrict = sameLast.filter((l) => l.chamber === "house" && district !== undefined && l.district === district);
    if (byDistrict.length === 1) return byDistrict[0];
    return undefined;
  };
}

export interface HouseFiling {
  docId: string;
  year: number;
  filer: string;
  office: string;
  state: string;
  district: number;
  destination: string;
  amendment: boolean;
  departure: string;
  return: string;
  sponsor: string;
  bioguide?: string;
  /** Filed by the member themself rather than a staffer. */
  self: boolean;
  url: string;
}

export async function houseIndex(): Promise<HouseFiling[]> {
  const list = await legislators();
  const match = matcher(list);
  const parser = new XMLParser({ parseTagValue: false });
  const out: HouseFiling[] = [];
  for (const year of HOUSE_YEARS) {
    const zip = `house/${year}Travel.zip`;
    await index(`https://disclosures-clerk.house.gov/public_disc/gift-pdfs/${year}Travel.zip`, zip, `house/${year}`);
    const xml = path.join(CACHE, `house/${year}/${year}Travel.xml`);
    if (!fs.existsSync(xml)) throw new Error(`${zip} has no ${year}Travel.xml`);
    const rows = parser.parse(fs.readFileSync(xml, "utf8")).GiftTravel.Travel as Record<string, unknown>[];
    for (const r of rows) {
      const office = clean(r.MemberName);
      const filer = clean(r.FilerName);
      const state = clean(r.State);
      const district = Number(r.District);
      const m = match(office, state, district);
      // A member's own filing: the filer's surname is the office's.
      const officeLast = fold(office.split(",")[0]!.split(" ").at(-1)!);
      const self = fold(filer).endsWith(officeLast) || fold(filer.split(" ").at(-1) ?? "") === officeLast;
      const docId = clean(r.DocID);
      out.push({
        docId,
        year,
        filer,
        office,
        state,
        district,
        destination: clean(r.Destination),
        amendment: clean(r.FilingType) === "Amendment",
        departure: usDate(clean(r.DepartureDate)),
        return: usDate(clean(r.ReturnDate)),
        sponsor: clean(r.TravelSponsor),
        bioguide: m?.bioguide,
        self,
        url: `https://disclosures-clerk.house.gov/gtimages/${self ? "MT" : "ST"}/${year}/${docId}.pdf`,
      });
    }
  }
  return out;
}

export interface SenateFiling {
  id: string;
  filer: string;
  office: string;
  reportingYear: number;
  departure: string;
  return: string;
  received: string;
  pages: number;
  self: boolean;
  bioguide?: string;
  url: string;
}

export async function senateIndex(): Promise<SenateFiling[]> {
  const list = (await legislators()).filter((l) => l.chamber === "senate");
  const match = matcher(list);
  await index("https://giftrule-disclosure.senate.gov/media/giftruledownloads/giftruledata.zip", "senate/giftruledata.zip", "senate");
  const xml = path.join(CACHE, "senate/giftrule.xml");
  if (!fs.existsSync(xml)) throw new Error("giftruledata.zip has no giftrule.xml");
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", isArray: (n) => n.startsWith("dbo.") });
  const root = parser.parse(fs.readFileSync(xml, "utf8").replace(/^﻿/, "")).GiftRule;
  const out: SenateFiling[] = [];
  for (const f of root["dbo.filer"]) {
    for (const o of f["dbo.Office"] ?? []) {
      // "BUDD,TED", "BLUNT ROCHESTER,LISA"
      const office = clean(o.OfficeName).replace(/,(?=\S)/, ", ");
      const m = match(office);
      for (const d of o["dbo.Document"] ?? []) {
        for (const r of d["dbo.Reports"] ?? []) {
          const url = clean(r.DocURL);
          out.push({
            id: url.split("/").at(-1)!.replace(/\.pdf$/, ""),
            filer: `${clean(f.FirstName)} ${clean(f.LastName)}`,
            office,
            reportingYear: Number(d.ReportingYear),
            departure: usDate(clean(d.BeginTravelDate)),
            return: usDate(clean(d.EndTravelDate)),
            received: usDate(clean(d.DateReceived)),
            pages: Number(d.Pages),
            self: clean(r.ReportTitle).startsWith("Member"),
            bioguide: m?.bioguide,
            url,
          });
        }
      }
    }
  }
  return out;
}

export function writeJson(file: string, data: unknown) {
  const dest = path.join(CACHE, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(data, null, 1));
}
