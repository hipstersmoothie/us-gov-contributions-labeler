// Which Bluesky lists and starter packs the labeler account keeps, and their
// record keys. Pure: sync-lists publishes these, and the site links to them
// without a network call, so both always agree.
import crypto from "crypto";
import type { Member } from "../ingest/build.js";
import type { CongressCommittee } from "../ingest/assignments.js";

export const LABELER_DID = "did:plc:ylmdlijvrvgbe4md6v4dyce6";
export const HANDLE = "contributions.fyi";
const SITE = "https://contributions.fyi";
const SECTOR_TOP = 25;
const MIN_STATE = 2;
const MIN_COMMITTEE = 3;
export const PACK_MAX = 150; // accounts per starter pack, Bluesky app limit
const SKIP_SECTORS = new Set(["Unknown", "Party & Candidate Committees", "Retired", "Not employed"]);

export interface Spec {
  key: string;
  name: string;
  description: string;
  purpose: "curatelist" | "referencelist";
  dids: string[];
  pack?: { name: string; description: string };
  /** For the site: what the list is of, and which members are on it. */
  group: "everyone" | "pack" | "state" | "committee" | "sector";
  /** The state code, committee id or sector name it's for. */
  ref?: string;
  bioguides: string[];
}

export const STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming", DC: "District of Columbia", PR: "Puerto Rico", GU: "Guam", VI: "U.S. Virgin Islands",
  AS: "American Samoa", MP: "Northern Mariana Islands",
};
// The House halves for starter packs: Northeast and South, Midwest and West
// (census regions; territories go with the first).
const MIDWEST_WEST = new Set(
  "IL IN IA KS MI MN MO NE ND OH SD WI AZ CO ID MT NV NM UT WY AK CA HI OR WA".split(" ")
);
// Names too long for "<name> on Bluesky" in 64 characters, or awkward.
const COMMITTEE_NAMES: Record<string, string> = {
  HSHA: "House Administration Committee",
  HSZS: "House Select Committee on China",
  SCNC: "Senate Narcotics Caucus",
  JSLC: "Joint Committee on the Library",
  JCSE: "Helsinki Commission",
};
const committeeName = (c: CongressCommittee) =>
  COMMITTEE_NAMES[c.id] ?? c.name.replace(/^(House|Senate) (Permanent |Select |Special )*Committee on (the )?/, "$1 ");

const footer = `\n\nAuto-maintained from FEC and congress-legislators data by @${HANDLE}. More: ${SITE}`;
const dids = (ms: Member[]) => [...new Set(ms.flatMap((m) => m.accounts.map((a) => a.did)))];
const bioguides = (ms: Member[]) => ms.map((m) => m.bioguide);
// Starter packs follow everyone in them, so one account per member: the official one if there is.
const mainAccount = (m: Member) =>
  (m.accounts.find((a) => /\.(house|senate)\.gov$/.test(a.handle)) ?? m.accounts[0]!).did;
const byName = (a: Member, b: Member) => a.name.localeCompare(b.name);

export function buildSpecs(members: Member[], committees: CongressCommittee[], cycles: number[], did: string = LABELER_DID) {
  const onBluesky = members.filter((m) => m.accounts.length);
  const range = `${cycles[0]! - 1}–${cycles.at(-1)}`;
  const specs: Spec[] = [];

  specs.push({
    key: "congress",
    name: "Congress on Bluesky",
    description: `Members of the House and Senate on Bluesky, including their official and campaign accounts.${footer}`,
    purpose: "curatelist",
    dids: dids(onBluesky),
    group: "everyone",
    bioguides: bioguides(onBluesky),
  });

  const packs = [
    { key: "pack-senate", name: "Congress on Bluesky: Senate", who: "Every senator", filter: (m: Member) => m.chamber === "senate" },
    {
      key: "pack-house-northeast-south",
      name: "Congress on Bluesky: House, Northeast & South",
      who: "Every House member from the Northeast and South",
      filter: (m: Member) => m.chamber === "house" && !MIDWEST_WEST.has(m.state),
    },
    {
      key: "pack-house-midwest-west",
      name: "Congress on Bluesky: House, Midwest & West",
      who: "Every House member from the Midwest and West",
      filter: (m: Member) => m.chamber === "house" && MIDWEST_WEST.has(m.state),
    },
  ];
  for (const p of packs) {
    const ms = onBluesky.filter(p.filter).sort(byName);
    const accounts = [did, ...ms.map(mainAccount)];
    if (accounts.length > PACK_MAX) {
      console.warn(`! ${p.name}: ${accounts.length} accounts, over the ${PACK_MAX} limit; keeping the first ${PACK_MAX}. Split it.`);
    }
    const description = `${p.who} on Bluesky, and @${HANDLE}, which labels them with their top funders.${footer}`;
    specs.push({
      key: p.key,
      name: p.name,
      description,
      purpose: "referencelist",
      dids: accounts.slice(0, PACK_MAX),
      pack: { name: p.name, description },
      group: "pack",
      bioguides: bioguides(ms.slice(0, PACK_MAX - 1)),
    });
  }

  const byState = Map.groupBy(onBluesky, (m) => m.state);
  for (const [state, ms] of [...byState].sort(([a], [b]) => a.localeCompare(b))) {
    if (ms.length < MIN_STATE) continue;
    const name = STATES[state] ?? state;
    specs.push({
      key: `state-${state.toLowerCase()}`,
      name: `${name} delegation on Bluesky`,
      description: `${name}'s members of Congress on Bluesky.${footer}`,
      purpose: "curatelist",
      dids: dids(ms),
      group: "state",
      ref: state,
      bioguides: bioguides(ms),
    });
  }

  const byBioguide = new Map(onBluesky.map((m) => [m.bioguide, m]));
  // Full committees have 4-letter ids; subcommittees add a number.
  for (const c of committees.filter((c) => /^[A-Z]{4}$/.test(c.id) && !/subcommittee/i.test(c.name))) {
    const ms = c.members.map((s) => byBioguide.get(s.bioguide)).filter((m) => m !== undefined);
    if (ms.length < MIN_COMMITTEE) continue;
    specs.push({
      key: `committee-${c.id.toLowerCase()}`,
      name: `${committeeName(c)} on Bluesky`,
      description: `Members of the ${c.name.replace(/^United States /, "")} on Bluesky.${footer}`,
      purpose: "curatelist",
      dids: dids(ms),
      group: "committee",
      ref: c.id,
      bioguides: bioguides(ms),
    });
  }

  const sectorNames = [...new Set(onBluesky.flatMap((m) => m.combinedSectors.map((s) => s.id)))]
    .filter((s) => !SKIP_SECTORS.has(s))
    .sort();
  for (const sector of sectorNames) {
    const top = onBluesky
      .map((m) => ({ m, total: m.combinedSectors.find((s) => s.id === sector)?.total ?? 0 }))
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total)
      .slice(0, SECTOR_TOP);
    specs.push({
      key: `sector-${sector.toLowerCase().replace(/&/g, "and").replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "")}`,
      name: `Top recipients of ${sector} money`,
      description:
        `The ${top.length} members of Congress on Bluesky who got the most from ${sector}, ${range}: ` +
        `PAC contributions plus donations from people who work in it.${footer}`,
      purpose: "curatelist",
      dids: dids(top.map((r) => r.m)),
      group: "sector",
      ref: sector,
      bioguides: bioguides(top.map((r) => r.m)),
    });
  }
  return specs;
}

// --- record keys --------------------------------------------------------------

// TIDs are 13 base32-sortable characters: 53 bits of microseconds, 10 of clock id.
const S32 = "234567abcdefghijklmnopqrstuvwxyz";
export const encodeTid = (n: bigint) => {
  let s = "";
  for (let i = 0; i < 13; i++, n >>= 5n) s = S32[Number(n & 31n)] + s;
  return s;
};
const decodeTid = (s: string) => [...s].reduce((n, c) => n * 32n + BigInt(S32.indexOf(c)), 0n);
const EPOCH = BigInt(Date.UTC(2023, 0, 1)) * 1000n; // µs
const SPAN = 2n ** 32n; // µs, about 71 minutes
/** A list's record key: a TID dated in 2023, derived from its key. */
export const rkeyFor = (key: string) => {
  const h = crypto.createHash("sha256").update(`fyi.contributions.list:${key}`).digest();
  return encodeTid(((EPOCH + BigInt(h.readUInt32BE(0))) << 10n) | BigInt(h.readUInt16BE(4) & 0x3ff));
};
/** Whether a record key is one rkeyFor makes, so ours to manage. */
export const isManaged = (rkey: string) => {
  if (!/^[2-7a-j][2-7a-z]{12}$/.test(rkey)) return false;
  const t = decodeTid(rkey) >> 10n;
  return t >= EPOCH && t < EPOCH + SPAN;
};

/** Where a list or starter pack opens in the Bluesky app. */
export const specUrl = (s: Pick<Spec, "key" | "pack">) =>
  s.pack ? `https://bsky.app/starter-pack/${HANDLE}/${rkeyFor(s.key)}` : `https://bsky.app/profile/${HANDLE}/lists/${rkeyFor(s.key)}`;
