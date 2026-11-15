// Congressional committee assignments and official photos, both from the
// github.com/unitedstates projects.
import fs from "fs";
import path from "path";
import { mapLimit } from "../lib/async.js";
import type { Legislator } from "../lib/legislators.js";

const BASE = "https://unitedstates.github.io/congress-legislators";
const PHOTO_URL = "https://unitedstates.github.io/images/congress/225x275";
export const PHOTO_DIR = "site/public/photos";

interface RawCommittee {
  thomas_id: string;
  name: string;
  type: "house" | "senate" | "joint";
  url?: string;
  jurisdiction?: string;
  subcommittees?: { thomas_id: string; name: string }[];
}

interface RawMembership {
  bioguide: string;
  title?: string;
  rank?: number;
  party: "majority" | "minority";
}

export interface CongressCommittee {
  id: string;
  name: string;
  chamber: "house" | "senate" | "joint";
  url?: string;
  jurisdiction?: string;
  /** Subcommittee ids are the parent id + the subcommittee's own id. */
  parent?: string;
  members: { bioguide: string; title?: string; rank?: number; majority: boolean }[];
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} from ${url}`);
  return (await res.json()) as T;
}

export async function fetchAssignments() {
  const [committees, membership] = await Promise.all([
    getJson<RawCommittee[]>(`${BASE}/committees-current.json`),
    getJson<Record<string, RawMembership[]>>(`${BASE}/committee-membership-current.json`),
  ]);

  const members = (id: string) =>
    (membership[id] ?? []).map((m) => ({
      bioguide: m.bioguide,
      title: m.title,
      rank: m.rank,
      majority: m.party === "majority",
    }));

  const result: CongressCommittee[] = [];
  for (const c of committees) {
    result.push({
      id: c.thomas_id,
      name: c.name,
      chamber: c.type,
      url: c.url,
      jurisdiction: c.jurisdiction,
      members: members(c.thomas_id),
    });
    for (const sub of c.subcommittees ?? []) {
      const id = c.thomas_id + sub.thomas_id;
      result.push({
        id,
        name: `${sub.name}`,
        chamber: c.type,
        parent: c.thomas_id,
        members: members(id),
      });
    }
  }

  console.log(
    `${committees.length} committees, ${result.length - committees.length} subcommittees, ` +
      `${result.reduce((n, c) => n + c.members.length, 0)} seats`
  );
  return result;
}

/** Official portraits into the site's public folder; skips ones we have. */
export async function fetchPhotos(legislators: Legislator[]) {
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  const missing = legislators.filter((l) => !fs.existsSync(path.join(PHOTO_DIR, `${l.bioguide}.jpg`)));

  let found = 0;
  await mapLimit(missing, 8, async (l) => {
    const res = await fetch(`${PHOTO_URL}/${l.bioguide}.jpg`);
    if (!res.ok) return; // brand-new members may not have one yet
    fs.writeFileSync(path.join(PHOTO_DIR, `${l.bioguide}.jpg`), Buffer.from(await res.arrayBuffer()));
    found++;
  });

  const have = legislators.filter((l) => fs.existsSync(path.join(PHOTO_DIR, `${l.bioguide}.jpg`))).length;
  console.log(`Photos: ${found} downloaded, ${have}/${legislators.length} available`);
}
