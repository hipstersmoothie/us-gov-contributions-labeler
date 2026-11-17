// The data files the posts are written from: fetched from `main` on GitHub
// with ETags (cached in DATA_DIR), or read from a local data/ directory.
import fs from "fs";
import path from "path";
import type { Member } from "../src/ingest/build.js";
import type { RacesFile } from "../src/ingest/races.js";

export type { Member };
export type { Race, RaceCandidate } from "../src/ingest/races.js";

export const RACE_YEAR = 2026;

const FILES = {
  members: "members.json",
  organizations: "organizations.json",
  races: `races-${RACE_YEAR}.json`,
} as const;
type Name = keyof typeof FILES;

export interface Data {
  members: Member[];
  memberById: Map<string, Member>;
  /** Organization id -> its sector, for leaving party committees out of contributors (as memberLabels does). */
  orgById: Map<string, { sector?: string }>;
  races: RacesFile;
  /** The newest generatedAt of the files, for logs. */
  generatedAt: string;
}

function build(raw: Record<Name, string>): Data {
  const membersFile = JSON.parse(raw.members) as { members: Member[]; generatedAt: string };
  const members = membersFile.members;
  const orgs = (JSON.parse(raw.organizations) as { organizations: { id: string; sector?: string }[] | Record<string, { id: string; sector?: string }> })
    .organizations;
  const races = JSON.parse(raw.races) as RacesFile;
  if (!members.length) throw new Error("members.json has no members");
  if (!races.races.length) throw new Error(`${FILES.races} has no races`);
  return {
    members,
    memberById: new Map(members.map((m) => [m.bioguide, m])),
    orgById: new Map(Object.values(orgs).map((o) => [o.id, { sector: o.sector }])),
    races,
    generatedAt: [races.generatedAt, membersFile.generatedAt].sort().at(-1)!,
  };
}

/** Read every file from a local data/ directory. */
export function readLocal(dir = "data"): Data {
  const raw = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, fs.readFileSync(path.join(dir, f), "utf8")]));
  return build(raw as Record<Name, string>);
}

/**
 * Fetches the files from `baseUrl`, sending each one's ETag so unchanged
 * files cost a 304. Returns new Data when any file changed, the cached Data
 * when none did, and throws when a file can't be had at all.
 */
export class RemoteData {
  private current?: Data;
  constructor(
    private baseUrl: string,
    private cacheDir: string
  ) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  async load(): Promise<Data> {
    let changed = !this.current;
    const raw: Partial<Record<Name, string>> = {};
    for (const [name, file] of Object.entries(FILES) as [Name, string][]) {
      const cached = path.join(this.cacheDir, file);
      const etagFile = `${cached}.etag`;
      const etag = fs.existsSync(cached) && fs.existsSync(etagFile) ? fs.readFileSync(etagFile, "utf8") : undefined;
      try {
        const res = await fetch(`${this.baseUrl}/${file}`, { headers: etag ? { "if-none-match": etag } : {} });
        if (res.status === 304) continue;
        if (!res.ok) throw new Error(`${file}: ${res.status}`);
        const text = await res.text();
        JSON.parse(text); // don't cache a truncated file
        fs.writeFileSync(cached, text);
        const next = res.headers.get("etag");
        if (next) fs.writeFileSync(etagFile, next);
        else fs.rmSync(etagFile, { force: true });
        raw[name] = text;
        changed = true;
      } catch (err) {
        if (!fs.existsSync(cached)) throw err;
        console.error(`Fetching ${file} failed, using the cached copy:`, err);
      }
    }
    if (!changed) return this.current!;
    for (const [name, file] of Object.entries(FILES) as [Name, string][]) {
      raw[name] ??= fs.readFileSync(path.join(this.cacheDir, file), "utf8");
    }
    this.current = build(raw as Record<Name, string>);
    return this.current;
  }
}
