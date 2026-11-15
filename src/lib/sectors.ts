// A small, fixed sector taxonomy, roughly the shape of OpenSecrets' sectors,
// and the tables that map each source's classification onto it.

export const SECTORS = [
  "Agribusiness",
  "Communications & Technology",
  "Construction",
  "Defense",
  "Education",
  "Energy & Natural Resources",
  "Finance, Insurance & Real Estate",
  "Health",
  "Ideological & Single-Issue",
  "Labor",
  "Lawyers & Lobbyists",
  "Misc Business",
  "Party & Candidate Committees",
  "Transportation",
  "Unknown",
] as const;

export type Sector = (typeof SECTORS)[number];

/** SEC Standard Industrial Classification code -> sector. */
export function sectorForSic(sic: number): Sector {
  const between = (lo: number, hi: number) => sic >= lo && sic <= hi;

  if (between(100, 999)) return "Agribusiness";
  if (between(1000, 1499)) return "Energy & Natural Resources";
  if (between(1500, 1799)) return "Construction";
  if (between(2000, 2199)) return "Agribusiness";
  if (between(2400, 2499)) return "Energy & Natural Resources";
  if (between(2830, 2836)) return "Health";
  if (between(2900, 2999)) return "Energy & Natural Resources";
  if (between(3570, 3579) || between(3600, 3699)) return "Communications & Technology";
  if (between(3711, 3716)) return "Transportation";
  if (between(3720, 3732) || between(3760, 3769) || sic === 3812) return "Defense";
  if (between(3840, 3851)) return "Health";
  if (between(4000, 4799)) return "Transportation";
  if (between(4800, 4899)) return "Communications & Technology";
  if (between(4900, 4999)) return "Energy & Natural Resources";
  if (sic === 5122 || sic === 5912) return "Health";
  if (between(6000, 6799)) return "Finance, Insurance & Real Estate";
  if (between(7370, 7379) || between(7800, 7999)) return "Communications & Technology";
  if (between(8000, 8099)) return "Health";
  if (between(8100, 8199)) return "Lawyers & Lobbyists";
  if (between(8200, 8299)) return "Education";
  if (between(9100, 9999)) return "Unknown";
  return "Misc Business";
}

/**
 * Lobbying disclosure issue codes that point at a sector. Generic codes
 * everyone files under (TAX, BUD, GOV, TRD, ...) are deliberately left out.
 */
const ISSUE_SECTORS: Record<string, Sector> = {
  AGR: "Agribusiness", ANI: "Agribusiness", BEV: "Agribusiness",
  FOO: "Agribusiness", TOB: "Agribusiness", CDT: "Agribusiness",

  COM: "Communications & Technology", CPI: "Communications & Technology",
  TEC: "Communications & Technology", MIA: "Communications & Technology",
  ART: "Communications & Technology", SCI: "Communications & Technology",
  CPT: "Communications & Technology", ADV: "Communications & Technology",

  DEF: "Defense", AER: "Defense", INT: "Defense", HOM: "Defense",

  EDU: "Education",

  ENG: "Energy & Natural Resources", FUE: "Energy & Natural Resources",
  UTI: "Energy & Natural Resources", NAT: "Energy & Natural Resources",
  WAS: "Energy & Natural Resources", CAW: "Energy & Natural Resources",
  ENV: "Energy & Natural Resources",

  BAN: "Finance, Insurance & Real Estate", BNK: "Finance, Insurance & Real Estate",
  FIN: "Finance, Insurance & Real Estate", INS: "Finance, Insurance & Real Estate",
  HOU: "Finance, Insurance & Real Estate", RES: "Finance, Insurance & Real Estate",
  RET: "Finance, Insurance & Real Estate", ACC: "Finance, Insurance & Real Estate",
  MON: "Finance, Insurance & Real Estate",

  HCR: "Health", MED: "Health", MMM: "Health", PHA: "Health", ALC: "Health",

  CIV: "Ideological & Single-Issue", FAM: "Ideological & Single-Issue",
  FIR: "Ideological & Single-Issue", REL: "Ideological & Single-Issue",
  FOR: "Ideological & Single-Issue", CON: "Ideological & Single-Issue",

  TOR: "Lawyers & Lobbyists",

  AVI: "Transportation", AUT: "Transportation", RRR: "Transportation",
  TRU: "Transportation", MAR: "Transportation", ROD: "Transportation",
  TRA: "Transportation", TOU: "Transportation",

  MAN: "Misc Business", CHM: "Misc Business", APP: "Misc Business",
  GAM: "Misc Business", SMB: "Misc Business", CSP: "Misc Business",
};

/**
 * The most-lobbied issue that says something about industry, preferring one
 * that agrees with the sector we settled on.
 */
export function industryIssue(issues: { code: string; name: string }[], sector?: Sector) {
  return (
    issues.find((i) => ISSUE_SECTORS[i.code] === sector) ??
    issues.find((i) => ISSUE_SECTORS[i.code])
  )?.name;
}

/** Pick the sector most of an organization's lobbying issues point to. */
export function sectorForIssues(issues: { code: string; count: number }[]) {
  const weights = new Map<Sector, number>();
  for (const { code, count } of issues) {
    const sector = ISSUE_SECTORS[code];
    if (sector) weights.set(sector, (weights.get(sector) ?? 0) + count);
  }
  const best = [...weights].sort((a, b) => b[1] - a[1])[0];
  return best?.[0];
}

/** Last resort for associations with no SEC or lobbying record. */
const NAME_RULES: [RegExp, Sector][] = [
  [/\b(postal|letter carriers|federal employees|federal managers|treasury employees|police|fire ?fighters|sheriffs)/i, "Labor"],
  [/\b(realtor|real estate|home ?builder|mortgage|bank|banker|credit union|insur|financ|invest|securities|capital|accountant|cpa)/i, "Finance, Insurance & Real Estate"],
  [/\b(physician|medical|medicine|hospital|health|nurs|dental|dentist|pharm|surgeon|clinic|anesthesi|radiolog|optometr|chiropract|patholog|cardiolog|dermatolog|orthop|osteopath|otolaryng|surg|laborator|psychiatr|psycholog|urolog|oncolog|ophthalm|podiatr)/i, "Health"],
  [/\b(oil|gas|petroleum|energy|electric|coal|propane|pipeline|nuclear|mining|solar|wind|utilit|forest|timber|water users)/i, "Energy & Natural Resources"],
  [/\b(farm|agri|cattle|beef|pork|dairy|sugar|cotton|soybean|corn|wheat|rice|grain|poultry|citrus|grower|peanut|fisher|seafood|food|beverage|beer|wine|spirits|restaurant|grocer)/i, "Agribusiness"],
  [/\b(defense|aerospace|aircraft|missile)/i, "Defense"],
  [/\b(telecom|broadband|cable|wireless|broadcast|software|technology|internet|semiconductor|computer)/i, "Communications & Technology"],
  [/\b(construct|contractor|builder|engineer|architect|concrete|cement|plumb|roofing|electrical contractors)/i, "Construction"],
  [/\b(truck|rail|airline|aviation|pilot|transport|shipping|maritime|automobile|auto dealer|car dealer)/i, "Transportation"],
  [/\b(attorney|lawyer|law firm|trial|justice)/i, "Lawyers & Lobbyists"],
  [/\b(school|teacher|universit|college|education)/i, "Education"],
  [/\b(chamber of commerce|business roundtable|manufacturers|retail|wholesale|franchise|accountants|staffing|hotel|lodging|travel|tourism)/i, "Misc Business"],
];

export function sectorForName(name: string) {
  return NAME_RULES.find(([re]) => re.test(name))?.[1];
}
