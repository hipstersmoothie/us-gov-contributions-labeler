// Which congressional district a ZIP code is in, from the Census Bureau's
// relationship file between 2020 ZIP Code Tabulation Areas and the districts
// of the 119th Congress. A ZIP that crosses district lines is split by land
// area, so a district's share of a ZIP's money is an estimate.
// https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/
import fs from "fs";
import path from "path";

const URL = "https://www2.census.gov/geo/docs/maps-data/data/rel2020/cd-sld/tab20_cd11920_zcta520_natl.txt";
const FILE = ".cache/census/cd119_zcta.txt";

const STATE_FIPS: Record<string, string> = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
  "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
  "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
  "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP",
  "72": "PR", "78": "VI",
};

/** "TX-7"; at-large seats and delegates are district 0. */
export const districtKey = (state: string, district: number | undefined) => `${state}-${district ?? 0}`;

/** ZIP (5 digits) -> district key -> share of the ZIP's land in it. */
export type ZipDistricts = Map<string, Map<string, number>>;

export async function loadZipDistricts(): Promise<ZipDistricts> {
  if (!fs.existsSync(FILE)) {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    console.log("  downloading the Census ZCTA-to-district file");
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`Census download failed: ${res.status}`);
    fs.writeFileSync(FILE, Buffer.from(await res.arrayBuffer()));
  }
  const land = new Map<string, Map<string, number>>();
  for (const line of fs.readFileSync(FILE, "utf8").split("\n").slice(1)) {
    const r = line.split("|");
    const geoid = r[1];
    const zcta = r[8];
    const part = Number(r[15]) || 0;
    const state = geoid && STATE_FIPS[geoid.slice(0, 2)];
    if (!state || !zcta) continue;
    const cd = Number(geoid!.slice(2));
    // 00 is an at-large seat, 98 a delegate's.
    const key = districtKey(state, cd === 98 ? 0 : cd);
    let m = land.get(zcta);
    if (!m) land.set(zcta, (m = new Map()));
    m.set(key, (m.get(key) ?? 0) + part);
  }
  for (const m of land.values()) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    for (const [k, v] of m) m.set(k, total ? v / total : 1 / m.size);
  }
  return land;
}
