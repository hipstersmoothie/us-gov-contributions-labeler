// The member finder's lookups, without React: ZIP to districts from the
// per-prefix files, and street address to district through site/server's
// Census Geocoder proxy. Shared by the build (names) and the browser.
import type { DelegationFile, ZipFile } from "./types";

export const NO_SENATORS = new Set(["DC", "PR", "GU", "VI", "AS", "MP"]);

export const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

/** "the District of Columbia", "Arizona". */
export const placeName = (st: string, name: string) => (st === "DC" || st === "VI" || st === "MP" ? `the ${name}` : name);
/** "Arizona's", "Texas'", "the U.S. Virgin Islands'". */
export const possessive = (st: string, name: string) => `${placeName(st, name)}${name.endsWith("s") ? "'" : "'s"}`;
export const capitalize = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/** "Arizona's 3rd district", "Wyoming's at-large district"; DC and the territories by name. */
export function districtName(st: string, name: string, district: number) {
  if (NO_SENATORS.has(st)) return placeName(st, name);
  return `${possessive(st, name)} ${district ? `${ordinal(district)} district` : "at-large district"}`;
}

/** "AZ-3", "WY at large", "DC delegate". */
export function shortDistrict(st: string, district: number) {
  if (NO_SENATORS.has(st)) return `${st} ${st === "PR" ? "resident commissioner" : "delegate"}`;
  return district ? `${st}-${district}` : `${st} at large`;
}

export interface Part {
  state: string;
  district: number;
  /** Share of the ZIP's land area; undefined for an exact address match. */
  share?: number;
}

export type ZipAnswer =
  | { kind: "districts"; parts: Part[] }
  /** Not a ZIP the Census maps (PO box, business, new): the states its prefix covers. */
  | { kind: "unmapped"; states: string[] }
  | { kind: "military" }
  | { kind: "unknown" };

const parseKey = (key: string) => {
  const [state, d] = key.split("-");
  return { state: state!, district: Number(d) };
};

// APO/FPO/DPO mail: 090–098 (AE), 340 (AA), 962–966 (AP).
const MILITARY = /^(09[0-8]|340|96[2-6])/;

const zipCache = new Map<string, Promise<ZipFile | undefined>>();
function zipFile(congress: number, prefix: string) {
  let p = zipCache.get(prefix);
  if (!p) {
    p = fetch(`/data/zips/${congress}/${prefix}.json`).then((r) => {
      if (r.status === 404) return undefined;
      if (!r.ok) throw new Error(`ZIP data: HTTP ${r.status}`);
      return r.json() as Promise<ZipFile>;
    });
    p.catch(() => zipCache.delete(prefix));
    zipCache.set(prefix, p);
  }
  return p;
}

export async function lookupZip(congress: number, zip: string): Promise<ZipAnswer> {
  const f = await zipFile(congress, zip.slice(0, 3));
  const parts = f?.zips[zip];
  if (parts) return { kind: "districts", parts: parts.map(([key, share]) => ({ ...parseKey(key), share })) };
  const range = f?.ranges?.find(([from, to]) => zip >= from && zip <= to);
  if (range) return { kind: "districts", parts: [{ ...parseKey(range[2]) }] };
  if (MILITARY.test(zip) && !f?.states.length) return { kind: "military" };
  if (f?.states.length) return { kind: "unmapped", states: f.states };
  return { kind: "unknown" };
}

const delegationCache = new Map<string, Promise<DelegationFile>>();
export function loadDelegation(state: string) {
  let p = delegationCache.get(state);
  if (!p) {
    p = fetch(`/data/delegations/${state.toLowerCase()}.json`).then((r) => {
      if (!r.ok) throw new Error(`Delegation data: HTTP ${r.status}`);
      return r.json() as Promise<DelegationFile>;
    });
    p.catch(() => delegationCache.delete(state));
    delegationCache.set(state, p);
  }
  return p;
}

export type AddressAnswer =
  | { status: "match"; matched: string; state: string; district: number; zip?: string }
  | { status: "nomatch" }
  /** The geocoder or the proxy is down, slow, or rate-limited us: fall back to the ZIP. */
  | { status: "unavailable" | "limited" | "bad" };

/** The address goes in a POST body, so it never appears in a URL or a log. */
export async function lookupAddress(congress: number, address: string): Promise<AddressAnswer> {
  try {
    const res = await fetch("/api/district", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address, congress }),
      signal: AbortSignal.timeout(12_000),
    });
    const body = (await res.json().catch(() => ({ status: "unavailable" }))) as AddressAnswer;
    return body.status ? body : { status: "unavailable" };
  } catch {
    return { status: "unavailable" };
  }
}
