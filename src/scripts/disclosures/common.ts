// Shared bits for the financial disclosure exploration: a polite, cached
// fetch and the current members list.
//
// 5 U.S.C. § 13107 (formerly 5 U.S.C. app. § 105(c)) limits what these reports
// may be obtained or used for. Nothing here publishes them anywhere.
import fs from "fs";
import path from "path";

export const CACHE = ".cache/disclosures";
export const USER_AGENT = "contributions.fyi research (https://contributions.fyi)";

const lastRequest = new Map<string, number>();

/** Fetch a URL at most once (cached under .cache/disclosures), pacing each host. */
export async function cachedFetch(
  url: string,
  file: string,
  { intervalMs = 1500, init }: { intervalMs?: number; init?: RequestInit } = {}
): Promise<Buffer> {
  const dest = path.join(CACHE, file);
  if (fs.existsSync(dest)) return fs.readFileSync(dest);

  const host = new URL(url).host;
  const wait = (lastRequest.get(host) ?? 0) + intervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest.set(host, Date.now());

  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": USER_AGENT, ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  const body = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, body);
  return body;
}

export interface Current {
  bioguide: string;
  first: string;
  last: string;
  nickname?: string;
  chamber: "house" | "senate";
  state: string;
  district?: number;
  party: string;
}

export function currentMembers(): Current[] {
  const raw = JSON.parse(
    fs.readFileSync(path.join(CACHE, "legislators-current.json"), "utf8")
  ) as any[];
  return raw.map((l) => {
    const t = l.terms.at(-1);
    return {
      bioguide: l.id.bioguide,
      first: l.name.first,
      last: l.name.last,
      nickname: l.name.nickname,
      chamber: t.type === "sen" ? "senate" : "house",
      state: t.state,
      district: t.district,
      party: t.party,
    };
  });
}

export const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[^A-Z]/g, "");

export function writeJson(file: string, data: unknown) {
  const dest = path.join(CACHE, file);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(data, null, 1));
}
