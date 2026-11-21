// Polite, cached access to the USAspending.gov API (free, no key) for the
// feasibility study in design/usaspending/README.md. One request a second,
// every response cached under .cache/usaspending/ keyed by endpoint and body.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const API = "https://api.usaspending.gov/api/v2";
export const USER_AGENT = "contributions.fyi research (https://contributions.fyi)";
export const CACHE = ".cache/usaspending";
const INTERVAL_MS = 1000;

export const FY = {
  2024: { start_date: "2023-10-01", end_date: "2024-09-30" },
  2025: { start_date: "2024-10-01", end_date: "2025-09-30" },
} as const;

let lastRequest = 0;
export let requests = 0;

async function pace() {
  const wait = lastRequest + INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
}

/** POST (or GET when body is undefined) once; later calls read the cache. */
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const key = createHash("sha1").update(path + "\n" + (body === undefined ? "" : JSON.stringify(body))).digest("hex");
  const dir = join(CACHE, path.replace(/^\/|\/$/g, "").replace(/[^a-z0-9_]+/gi, "_"));
  const file = join(dir, key + ".json");
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as T;
  mkdirSync(dir, { recursive: true });
  await pace();
  requests++;
  const res = await fetch(API + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "User-Agent": USER_AGENT, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 429) {
    await new Promise((r) => setTimeout(r, 10_000));
    return api(path, body);
  }
  if (!res.ok) throw new Error(`${res.status} ${path} ${await res.text()}`);
  const text = await res.text();
  writeFileSync(file, text);
  return JSON.parse(text) as T;
}

export interface RecipientRow {
  id: string; // "<hash>-P" | "-C" | "-R"
  duns: string | null;
  uei: string | null;
  name: string;
  recipient_level: "P" | "C" | "R";
  amount: number; // trailing 12 months
}

export interface RecipientProfile {
  name: string;
  alternate_names: string[];
  duns: string | null;
  uei: string | null;
  recipient_id: string;
  recipient_level: "P" | "C" | "R";
  parent_id: string | null;
  parent_name: string | null;
  parents: { parent_id: string | null; parent_name: string | null }[];
  business_types: string[];
  total_transaction_amount: number;
  total_transactions: number;
}

export interface OverTime {
  results: {
    time_period: { fiscal_year: string };
    aggregated_amount: number;
    Contract_Obligations: number;
    Idv_Obligations: number;
    Grant_Obligations: number;
    Loan_Obligations: number;
    Direct_Obligations: number;
    Other_Obligations: number;
  }[];
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
}
export function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value, null, 1));
}
