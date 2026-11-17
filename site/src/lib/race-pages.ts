// Structured data and list sizes for the race and candidate pages.
import { abs } from "./seo";
import { generatedAt } from "./data";
import { candidateHref, personName, partyName, raceName, raceYear, stateName, type Race, type RaceCandidate } from "./races";

/** Spenders listed on a race page before the rest load on request. */
export const RACE_SPENDERS_SHOWN = 10;

const fecUrl = (id: string) => `https://www.fec.gov/data/candidate/${id}/`;
const PARTY_NAME: Record<string, string> = { Democrat: "Democratic Party", Republican: "Republican Party", Libertarian: "Libertarian Party", Green: "Green Party" };

/** "Candidate for U.S. House, Arizona's 4th District (2026)". */
export const candidacy = (r: Race) =>
  `Candidate for ${r.office === "S" ? `U.S. Senate in ${stateName(r.state)}` : `the U.S. House, ${raceName(r)}`} (${raceYear})`;

function person(c: RaceCandidate, r: Race) {
  const href = candidateHref(c);
  const party = PARTY_NAME[partyName(c)];
  return {
    "@type": "Person",
    ...(href.startsWith("/") && { "@id": abs(`${href}#person`), url: abs(href) }),
    name: personName(c),
    description: candidacy(r),
    ...(party && { affiliation: { "@type": "PoliticalParty", name: party } }),
    sameAs: [fecUrl(c.id)],
  };
}

/** A race page: a web page about the election and the people who ran. */
export function raceJsonLd(r: Race, path: string) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    url: abs(path),
    name: `${raceName(r)}, ${raceYear} election`,
    dateModified: generatedAt.toISOString(),
    about: r.candidates.map((c) => person(c, r)),
    isBasedOn: `https://www.fec.gov/data/elections/${r.office === "S" ? `senate/${r.state}` : `house/${r.state}/${String(r.district ?? 0).padStart(2, "0")}`}/${raceYear}/`,
  };
}

/** A candidate's page: the Person, linked to their FEC record. */
export function candidateJsonLd(c: RaceCandidate, r: Race, path: string) {
  return {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    url: abs(path),
    dateModified: generatedAt.toISOString(),
    mainEntity: person(c, r),
  };
}
