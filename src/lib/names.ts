// Organization name normalization for matching across FEC, LDA and SEC, which
// all spell the same company differently ("AFLAC INC", "Aflac Incorporated").

const NOISE = new RegExp(
  "\\b(" +
    [
      "SEPARATE SEGREGATED FUND", "SSF",
      "POLITICAL ACTION COMMITTEE", "POLITICAL ACTION COMM", "POLITICAL ACTION",
      "POLITICAL FUND", "POLITICAL", "PAC", "FEDERAL", "GOOD GOVERNMENT FUND", "GOOD GOVERNMENT COMMITTEE",
      "EMPLOYEES?", "COMMITTEE", "FUND", "INCORPORATED", "INC", "CORPORATION",
      "CORP", "COMPANY", "COMPANIES", "CO", "LLC", "LLP", "LP", "LTD", "PLC",
      "PC", "PA", "NA", "HOLDINGS?", "GROUP", "THE", "AND AFFILIATES",
    ].join("|") +
    ")\\b",
  "g"
);

export function normalizeOrg(name: string) {
  return name
    .toUpperCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\/[A-Z]{2,3}\/?$/, "") // SEC state suffixes: "WELLS FARGO & COMPANY/MN"
    .replace(/['’]/g, "") // LOWE'S -> LOWES
    .replace(/&/g, " AND ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+A\.?\s?K\.?\s?A\.?\s.*$/, "") // "ZOETIS AKA ZOETIS" -> "ZOETIS"
    .replace(/\bASSN\b/g, "ASSOCIATION")
    .replace(/\bNATL\b/g, "NATIONAL")
    .replace(/\bAMER\b/g, "AMERICAN")
    .replace(/[^A-Z0-9 ]/g, " ")
    .replace(/\b([A-Z]) (?=[A-Z]\b)/g, "$1") // U S A -> USA
    .replace(NOISE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(AND|OF) | (AND|OF)$/g, "");
}

/** Does this "organization" name actually describe another PAC? */
export function looksLikePac(name: string) {
  return /\b(PAC|POLITICAL ACTION|ACTION FUND|VICTORY|DEMOCRATS?|REPUBLICANS?|FOR CONGRESS|FOR SENATE)\b/i.test(name);
}

/** How alike two names are after normalizing, 0..1. */
export function nameSimilarity(a: string, b: string) {
  const ta = new Set(normalizeOrg(a).split(" ").filter(Boolean));
  const tb = new Set(normalizeOrg(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  const shared = [...ta].filter((t) => tb.has(t)).length;
  return shared / new Set([...ta, ...tb]).size;
}

export function sameOrg(a: string, b: string) {
  const na = normalizeOrg(a);
  const nb = normalizeOrg(b);
  return !!na && (na === nb || nameSimilarity(a, b) >= 0.8);
}

/** Readable display name from an ALL CAPS filing name. */
export function titleCase(name: string) {
  const SMALL = new Set(["of", "and", "for", "the", "in", "on", "at", "to", "a", "an"]);
  return fixCase(
    name
      .toLowerCase()
      .replace(/\b[a-z][a-z']*/g, (w, i) => (i > 0 && SMALL.has(w) ? w : w[0]!.toUpperCase() + w.slice(1)))
  );
}

// Acronyms that title-casing can't spot because they have vowels.
const ACRONYMS = new Set(
  ("Pac Llc Llp Pllc Usa Afl Aft Cio Ubs Ups Seiu Uaw Ua Ncta Ctia Cme Cipa Basf Bae Ge Dla Saic Sabic Nreca Tma Aota " +
    "Usaa Aarp Afscme Afge Ibew Iuoe Aig Aep Aes Hca Ibm Ey Bp Ieee Nea Aipac Ici Nahb Nrca Ahip Apta Aapa Nfib " +
    "Nrf Api Afpm Ipaa Eei Nmha Hdma Apapo Mci").split(" ")
);
// Short words without vowels that aren't acronyms.
const NOT_ACRONYMS = new Set(
  ("Mr Mrs Ms Dr St Jr Sr Ltd Hwy Mt Ft Lt Bldg Mgmt Mggmt Mgt Mfg Mgr Ctr Cntr Cnty Fdtn Fndn Fndtn Glbl Grp Plbg " +
    "Brthd Brhd Svc Svcs Mkt Mktg Pkwy Blvd Twp Dpt").split(" ")
);
// Company names written in camel case.
const BRANDS: Record<string, string> = {
  Jpmorgan: "JPMorgan", Netjets: "NetJets", Unitedhealth: "UnitedHealth", Unitedhealthcare: "UnitedHealthcare", Blackrock: "BlackRock",
  Nextera: "NextEra", Davita: "DaVita", Abbvie: "AbbVie", Fedex: "FedEx", Paypal: "PayPal", Ebay: "eBay",
  Iheartmedia: "iHeartMedia", Linkedin: "LinkedIn", Youtube: "YouTube", Doordash: "DoorDash",
  Arcelormittal: "ArcelorMittal", Exxonmobil: "ExxonMobil", Glaxosmithkline: "GlaxoSmithKline",
  Pricewaterhousecoopers: "PricewaterhouseCoopers", Amerisourcebergen: "AmerisourceBergen", Medstar: "MedStar",
};

/** Does `word` abbreviate the words before it? "Seiu" after "Service
 *  Employees International Union" does; "Lisa" after "Friends of" doesn't. */
function isAbbreviation(word: string, before: string) {
  const w = word.toLowerCase();
  if (/^(us|aka|fka|dba)$/.test(w)) return false;
  if (w.endsWith("pac")) return true;
  const initials = (before.match(/[A-Za-z]+/g) ?? []).map((t) => t[0]!.toLowerCase());
  let i = 0;
  let matched = 0;
  for (const c of w) {
    const at = initials.indexOf(c, i);
    if (at >= 0) {
      matched++;
      i = at + 1;
    }
  }
  return initials.includes(w[0]!) && matched >= Math.ceil(w.length * 0.6);
}

/** Fix acronyms and brand spellings in a title-cased name: "Cms Energy" →
 *  "CMS Energy", "(Njasap)" → "(NJASAP)", "At&t" → "AT&T". Safe to re-run. */
export function fixCase(name: string) {
  return (
    name
      // A one-word abbreviation in parentheses: "Service Employees International Union (Seiu)".
      .replace(/\(('?)([A-Za-z]{2,7})('?)\)/g, (m, a: string, w: string, b: string, at: number) =>
        isAbbreviation(w, name.slice(0, at)) ? `(${a}${w.toUpperCase()}${b})` : m
      )
      // Initials joined by &: At&t, Pg&e, Bb&t.
      .replace(/\b[A-Za-z]{1,2}&[A-Za-z]{1,2}\b/g, (w) => w.toUpperCase())
      // Short words with no vowels (counting y) are acronyms: Cms, Kpmg, Csx, Td.
      .replace(/\b[B-DF-HJ-NP-TV-XZ][b-df-hj-np-tv-xz]{1,4}\b/g, (w) => (NOT_ACRONYMS.has(w) ? w : w.toUpperCase()))
      .replace(/\b[A-Z][a-z]{1,5}\b/g, (w) => (ACRONYMS.has(w) ? w.toUpperCase() : w))
      // "Us" is the country, except as a pronoun: "Power of Us PAC", but "for US Senate".
      .replace(/\b(of|for|with|giving|join|help|elect|lead)?(\s*)\bUs\b(?!\s+(Senate|Congress|House))/gi, (m, before, sp) =>
        before ? m : `${sp}US`
      )
      .replace(/\bUs\b(?=\s+(Senate|Congress|House))/g, "US")
      .replace(/\bMc([a-z])(?=[a-z]{2})/g, (m, c: string, at: number) =>
        /^Mc(are|apitol)\b/.test(name.slice(at)) ? m : `Mc${c.toUpperCase()}`
      )
      .replace(/\b[A-Z][a-z]+\b/g, (w) => BRANDS[w] ?? w)
      .replace(/\.Com\b/g, ".com")
  );
}

export function slugify(name: string) {
  return normalizeOrg(name).toLowerCase().replace(/\s+/g, "-") || "unknown";
}

/** FEC candidate names, "OZ, MEHMET DR" -> "Mehmet Oz", "JOHNSON, RONALD EDWARD MR II" -> "Ronald Edward Johnson II". */
export function candidateName(raw: string) {
  const [last = "", rest = ""] = raw.split(",").map((s) => s.trim());
  const tokens = rest.split(/\s+/).filter(Boolean);
  const isSuffix = (t: string) => /^(JR|SR|II|III|IV)\.?$/i.test(t);
  const isTitle = (t: string) => /^(MR|MRS|MS|DR|SEN|REP|HON|GOV|REV)\.?$/i.test(t);
  const titleCase = (w: string) =>
    w.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, p: string, c: string) => p + c.toUpperCase()).replace(/\bMc([a-z])/g, (_, c: string) => "Mc" + c.toUpperCase());
  // A nickname in quotes is the name they go by: "VINDMAN, YEVGENY 'EUGENE'" -> "Eugene Vindman".
  const nickname = tokens.find((t) => /^["'(].+["')]$/.test(t));
  const given = nickname ? [nickname.slice(1, -1)] : tokens.filter((t) => !isSuffix(t) && !isTitle(t));
  const first = given.map(titleCase);
  const suffix = tokens.filter(isSuffix).map((t) => (/^(jr|sr)/i.test(t) ? titleCase(t.replace(/\.?$/, ".")) : t.toUpperCase()));
  return [...first, titleCase(last), ...suffix].join(" ").replace(/\s+/g, " ").trim() || raw;
}

/** FEC party codes as a tag letter, where one applies. */
export const partyCode = (code?: string) => ({ DEM: "D", REP: "R", IND: "I", NPA: "I", UN: "I" } as Record<string, string>)[code ?? ""];
