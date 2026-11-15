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
  return name
    .toLowerCase()
    .replace(/\b[a-z][a-z']*/g, (w, i) =>
      i > 0 && SMALL.has(w) ? w : w[0]!.toUpperCase() + w.slice(1)
    )
    .replace(/\b(Pac|Llc|Llp|Usa|Afl|Cio)\b/g, (w) => w.toUpperCase());
}

export function slugify(name: string) {
  return normalizeOrg(name).toLowerCase().replace(/\s+/g, "-") || "unknown";
}
