// Label values have to match ^[a-z-]+$ on Bluesky.
const DIGITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"];

export function labelValue(name: string) {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/\d/g, (d) => ` ${DIGITS[Number(d)]} `)
    .replace(/[^a-z]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/, "");
}

export interface LiveLabel {
  src: string;
  uri: string;
  val: string;
  neg?: boolean;
  cts: string;
}

/** Every label currently in effect on the labeler, via its public endpoint. */
export async function fetchLiveLabels(serviceUrl: string, labelerDid: string) {
  const events: LiveLabel[] = [];
  let cursor = "0";
  for (;;) {
    const qs = new URLSearchParams({ uriPatterns: "*", limit: "250", cursor });
    const res = await fetch(`${serviceUrl}/xrpc/com.atproto.label.queryLabels?${qs}`);
    if (!res.ok) throw new Error(`queryLabels failed: ${res.status}`);
    const page = (await res.json()) as { labels: LiveLabel[]; cursor: string };
    events.push(...page.labels);
    if (page.labels.length < 250) break;
    cursor = page.cursor;
  }

  // Replay in order; a negation cancels the label before it.
  const active = new Map<string, Set<string>>();
  for (const e of events) {
    if (e.src !== labelerDid) continue;
    const vals = active.get(e.uri) ?? new Set<string>();
    if (e.neg) vals.delete(e.val);
    else vals.add(e.val);
    active.set(e.uri, vals);
  }
  return { events: events.length, active };
}

/** The labeler's service URL, from its DID document. */
export async function labelerServiceUrl(did: string) {
  const res = await fetch(`https://plc.directory/${did}`);
  const doc = (await res.json()) as { service: { id: string; serviceEndpoint: string }[] };
  const service = doc.service.find((s) => s.id === "#atproto_labeler");
  if (!service) throw new Error(`${did} has no labeler service`);
  return service.serviceEndpoint;
}

export const PER_KIND = 3;
// Not industries, or not informative as a label.
const SKIP_SECTORS = new Set(["Unknown", "Party & Candidate Committees", "Retired", "Not employed"]);

/** Sector names short enough for a label chip: "Finance & real estate". */
export function shortSector(name: string) {
  return name
    .replace("Finance, Insurance & Real Estate", "Finance & real estate")
    .replace("Communications & Technology", "Tech & communications")
    .replace("Energy & Natural Resources", "Energy")
    .replace("Ideological & Single-Issue", "Ideological")
    .replace("Party & Candidate Committees", "Party & candidates");
}

// Well-known short names for organizations whose filed names don't include
// one, keyed by organization id. Checked by hand; add to it as new
// organizations reach members' top contributors.
const SHORT_NAMES: Record<string, string> = {
  "international-association-of-sheet-metal-air-rail-and-transportation-workers": "SMART",
  "united-food-and-commercial-workers-international-union-active-ballot-club": "UFCW",
  "american-federation-of-state-county-and-municipal-afl-cio": "AFSCME",
  "international-association-of-machinists-and-aerospace-workers": "IAM",
  "intl-union-of-bricklayers-and-allied-craftworkers": "BAC",
  "health-care-service": "HCSC",
  "national-association-of-insurance-and-financial-advisors": "NAIFA",
  "international-union-of-operating-engineers-local-965-pef": "IUOE Local 965",
  "united-brotherhood-of-carpenters-and-joiners-of-america": "UBC",
  "american-society-of-pension-professionals-and-actuaries": "ASPPA",
  "national-association-of-real-estate-investment-trusts": "Nareit",
  "american-college-of-surgeons-professional-association": "ACS",
  "international-union-of-operating-engineers-local-18": "IUOE Local 18",
  "american-college-of-ob-gyns": "ACOG",
  "local-881-united-food-and-commercial-workers-union": "UFCW Local 881",
  "international-union-of-painters-and-allied-trades": "IUPAT",
  "seal-supporting-electing-american-leaders-c00570226": "SEAL PAC",
  "professional-engineers-in-california-government": "PECG",
  "international-brotherhood-of-electrical-workers": "IBEW",
  "laborers-international-union-of-north-america": "LIUNA",
  "laborers-international-union-midwest-region": "LIUNA Midwest",
  "national-air-traffic-controllers-association": "NATCA",
  "national-electrical-contractors-association": "NECA",
  "international-association-of-fire-fighters": "IAFF",
  "american-association-of-nurse-anesthetists": "AANA",
  "engineers-education-international-union-of-operating-engineers": "IUOE",
  "international-brotherhood-of-boilermakers-iron-ship-builders-blacksmith-forgers-and-helpe": "Boilermakers",
  "american-council-of-engineering": "ACEC",
  "air-line-pilots-association": "ALPA",
  "international-longshoremens-association": "ILA",
  "american-israel-public-affairs": "AIPAC",
  "united-states-sugar-stock-ownership-plan": "U.S. Sugar",
  "american-college-of-emergency-physicians": "ACEP",
  "ascap-legislative-for-arts-c00228296": "ASCAP",
  "national-automobile-dealers-association": "NADA",
  "council-of-insurance-agents-and-brokers": "CIAB",
  "american-academy-of-pediatric-dentistry": "AAPD",
  "american-clinical-laboratory-associaton": "ACLA",
  "lhc": "LHC Group",
  "asian-american-hotel-owners-association": "AAHOA",
  "commercial-real-estate-finance-council": "CREFC",
  "american-college-of-physician-services": "ACP",
  "ua-union-plumbers-and-pipefitters-vote": "UA",
  "national-cattlemens-beef-association": "NCBA",
  "national-beer-wholesalers-association": "NBWA",
  "american-society-of-anesthesiologists": "ASA",
  "american-academy-of-family-physicians": "AAFP",
  "national-association-of-broadcasters": "NAB",
  "national-multifamily-housing-council": "NMHC",
  "national-union-of-healthcare-workers": "NUHW",
  "plumbers-and-pipefitters-local-no-9": "UA Local 9",
  "transport-workers-union-of-america": "TWU",
  "communications-workers-of-america": "CWA",
  "american-association-for-justice": "AAJ",
  "national-association-of-realtors": "NAR",
  "american-federation-of-teachers-afl-cio-on-education": "AFT",
  "american-optometric-association": "AOA",
  "american-trucking-associations": "ATA",
  "national-education-association": "NEA",
  "space-exploration-technologies": "SpaceX",
  "american-hospital-association": "AHA",
  "moveon-org-c00341396": "MoveOn",
  "capital": "Capital Group",
  "fifth-third-bancorp": "Fifth Third",
  "southern-glazers-wine-and-spirits": "Southern Glazer's",
  "thrivent-financial-for-lutherans": "Thrivent",
  "discover-financial-services": "Discover",
};

/** A contributor's name as a label chip: the abbreviation when the name has
 *  one ("Service Employees International Union (SEIU)" → "SEIU"), otherwise
 *  the name without corporate suffixes ("Lockheed Martin Corp" → "Lockheed Martin"). */
export function labelName(name: string, id?: string) {
  if (id && SHORT_NAMES[id]) return SHORT_NAMES[id]!;
  const base = name
    .replace(/\s*\((Formerly|Fka|F K A|Aka|A\.K\.A\.|Previously|on Behalf of|Collectively|a [^)]* Subsidiary)[^)]*\)/gi, "")
    .trim();
  const abbreviation = base.match(/\(['"]?([A-Z][A-Z0-9&]{1,9})['"]?\)/);
  if (abbreviation) return abbreviation[1]!;
  const trailing = base.match(/^(.{25,}?)\s+([A-Z][A-Z&]{2,9})$/);
  if (trailing && !/^(LLC|LLP|PLLC|PLC|USA|PAC|INC)$/.test(trailing[2]!)) return trailing[2]!;
  let short = base;
  for (let prev = ""; prev !== short; ) {
    prev = short;
    short = short
      .replace(/,?\s+(Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?|Company|LLC|L\.L\.C\.|LLP|PLLC|Ltd\.?|PLC|N\.A\.)$/i, "")
      .replace(/,?\s+(and|&) (Its )?(Affiliates|Subsidiaries)$/i, "")
      .replace(/\s+&$/, "")
      .trim();
  }
  return short || name;
}

export interface MemberLabel {
  kind: "sector" | "contributor";
  value: string;
  /** Short enough for a label chip: "SEIU", "Lockheed Martin". */
  name: string;
  /** The organization's full name, for descriptions. */
  fullName: string;
  /** The sector name, or the contributor's organization id. */
  id: string;
}

/** The labels the labeler puts on a member's accounts: their top 3 sectors
 *  and top 3 contributors, counting an organization's PAC, its employees and donations earmarked through its PAC. */
export function memberLabels(
  m: { combinedSectors: { id: string }[]; contributors: { id: string; name: string }[] },
  orgById: Map<string, { sector?: string }>
): MemberLabel[] {
  const sectors = m.combinedSectors
    .filter((s) => !SKIP_SECTORS.has(s.id))
    .slice(0, PER_KIND)
    .map((s) => ({ kind: "sector" as const, value: labelValue(s.id), name: shortSector(s.id), fullName: s.id, id: s.id }));
  const contributors = m.contributors
    .filter((c) => orgById.get(c.id)?.sector !== "Party & Candidate Committees")
    .slice(0, PER_KIND)
    // The value comes from the full name so it never changes when the display name does.
    .map((c) => ({ kind: "contributor" as const, value: labelValue(c.name), name: labelName(c.name, c.id), fullName: c.name, id: c.id }));
  return [...sectors, ...contributors].filter((l) => l.value);
}
