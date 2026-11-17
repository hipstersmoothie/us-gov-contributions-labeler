// The member finder's address lookup: POST /api/district with
// { address, congress } returns the congressional district the Census
// Geocoder puts that address in. The geocoder doesn't allow cross-origin
// requests from browsers, so the site asks through here.
//
// Privacy: the address is in the request body, never the URL, so the
// request log (index.ts) never sees it; nothing here logs or keeps it, and
// errors are logged by kind only. It goes to the Census Bureau and back.
//
// Districts are versioned by Congress: the page asks for the Congress its
// ZIP data is for, and the answer is read from that Congress's layer, never
// whichever map the geocoder treats as current. Census updates its
// "Current" vintage to new maps before the members elected under them take
// office (it had the 120th's in November 2026), so each Congress is pinned
// to a vintage, and the layer name is checked on every answer.
import type http from "node:http";

export const DISTRICT_PATH = "/api/district";

// Keep in step with DISTRICT_MAPS in src/lib/districts.ts.
const LAYERS: Record<number, { vintage: string; layer: string }> = {
  119: { vintage: "ACS2025_Current", layer: "119th Congressional Districts" },
  // Checked November 2026; recheck when the site switches to the 120th.
  120: { vintage: "Current_Current", layer: "120th Congressional Districts" },
};
const GEOCODER = "https://geocoding.geo.census.gov/geocoder/geographies/onelineaddress";
const TIMEOUT_MS = 8000;

const STATE_FIPS: Record<string, string> = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC",
  "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY",
  "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT",
  "31": "NE", "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH",
  "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT",
  "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY", "60": "AS", "66": "GU", "69": "MP",
  "72": "PR", "78": "VI",
};

// --- rate limits: per client, and for everyone together, so the site stays a
// polite user of a free service. Counts only; addresses never enter. ----------------

const WINDOW_MS = 10 * 60 * 1000;
export const PER_CLIENT = 20;
const OVERALL = 600;
const hits = new Map<string, number[]>();
let overall: number[] = [];

/** Whether a client is over its share of lookups (the MCP server's find_members counts too). */
export function limited(client: string, now = Date.now()) {
  const since = now - WINDOW_MS;
  overall = overall.filter((t) => t > since);
  const mine = (hits.get(client) ?? []).filter((t) => t > since);
  if (mine.length >= PER_CLIENT || overall.length >= OVERALL) {
    hits.set(client, mine);
    return true;
  }
  mine.push(now);
  overall.push(now);
  hits.set(client, mine);
  return false;
}
setInterval(() => {
  const since = Date.now() - WINDOW_MS;
  for (const [k, v] of hits) if (!v.some((t) => t > since)) hits.delete(k);
}, WINDOW_MS).unref();

/** Railway's proxy puts the client first in X-Forwarded-For. */
const clientOf = (req: http.IncomingMessage) =>
  String(req.headers["x-forwarded-for"] ?? "").split(",")[0]!.trim() || req.socket.remoteAddress || "unknown";

// --- the lookup ------------------------------------------------------------------------

export type DistrictAnswer =
  | { status: "match"; matched: string; state: string; district: number; zip?: string }
  | { status: "nomatch" }
  | { status: "unavailable" }
  | { status: "limited" }
  | { status: "bad" };

interface CensusResponse {
  result?: {
    addressMatches?: {
      matchedAddress: string;
      addressComponents?: { zip?: string };
      geographies?: Record<string, { GEOID?: string }[]>;
    }[];
  };
}

export async function lookup(address: string, congress: number): Promise<DistrictAnswer> {
  const layer = LAYERS[congress];
  if (!layer) return { status: "bad" };
  const url = new URL(GEOCODER);
  url.search = new URLSearchParams({
    address,
    benchmark: "Public_AR_Current",
    vintage: layer.vintage,
    // The congressional districts layer, by its name, so the answer is small.
    layers: layer.layer,
    format: "json",
  }).toString();
  let body: CensusResponse;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: "application/json" } });
    if (!res.ok) {
      console.error(`geocoder: HTTP ${res.status}`);
      return { status: "unavailable" };
    }
    body = (await res.json()) as CensusResponse;
  } catch (err) {
    // The error's name only: a message could carry the URL, and so the address.
    console.error(`geocoder: ${(err as Error)?.name ?? "error"}`);
    return { status: "unavailable" };
  }
  const match = body.result?.addressMatches?.[0];
  if (!body.result?.addressMatches) return { status: "unavailable" };
  if (!match) return { status: "nomatch" };
  const geoid = match.geographies?.[layer.layer]?.[0]?.GEOID;
  if (!geoid) {
    // The vintage no longer has this Congress's layer: tell the page to use
    // its ZIP table, and say so in the log.
    console.error(`geocoder: no "${layer.layer}" layer in ${layer.vintage}`);
    return { status: "unavailable" };
  }
  const state = STATE_FIPS[geoid.slice(0, 2)];
  const cd = Number(geoid.slice(2));
  if (!state || !Number.isFinite(cd)) return { status: "nomatch" };
  // 00 is an at-large seat, 98 a delegate's.
  return { status: "match", matched: match.matchedAddress, state, district: cd === 98 ? 0 : cd, zip: match.addressComponents?.zip };
}

export async function findDistrict(req: http.IncomingMessage, res: http.ServerResponse) {
  const send = (status: number, answer: DistrictAnswer, extra: Record<string, string> = {}) => {
    const json = JSON.stringify(answer);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(json),
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      ...extra,
    });
    res.end(json);
  };
  let raw = "";
  try {
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 2048) return send(413, { status: "bad" });
    }
  } catch {
    return send(400, { status: "bad" });
  }
  let address: unknown;
  let congress: unknown;
  try {
    ({ address, congress } = JSON.parse(raw));
  } catch {
    return send(400, { status: "bad" });
  }
  if (typeof address !== "string" || typeof congress !== "number") return send(400, { status: "bad" });
  const clean = address.replace(/\s+/g, " ").trim();
  if (clean.length < 5 || clean.length > 200) return send(400, { status: "bad" });
  if (limited(clientOf(req))) return send(429, { status: "limited" }, { "Retry-After": "600" });
  const answer = await lookup(clean, congress);
  send(answer.status === "unavailable" ? 502 : answer.status === "bad" ? 400 : 200, answer);
}
