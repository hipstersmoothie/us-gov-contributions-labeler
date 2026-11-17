// Structured data (schema.org JSON-LD) for search engines, and the plain-text
// helpers page titles and descriptions share. Google's documented fields:
// https://developers.google.com/search/docs/appearance/structured-data/search-gallery
import { STATES } from "../../../src/lib/list-specs.ts";
import { fecCandidateUrl, generatedAt, partyLetter, photoUrl, type Member } from "./data";

export const SITE_NAME = "contributions.fyi";
const SITE = new URL(import.meta.env.SITE ?? "https://contributions.fyi");

/** An absolute URL on this site. */
export const abs = (path: string) => new URL(path, SITE).href;

type Thing = Record<string, unknown>;

/** The site itself, with its search; for the home page. */
export function website(): Thing[] {
  return [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "@id": abs("/#website"),
      name: SITE_NAME,
      alternateName: "Who funds your member of Congress?",
      url: abs("/"),
      inLanguage: "en-US",
      publisher: { "@id": abs("/#publisher") },
      potentialAction: {
        "@type": "SearchAction",
        target: { "@type": "EntryPoint", urlTemplate: `${abs("/search/")}?q={search_term_string}` },
        "query-input": "required name=search_term_string",
      },
    },
    {
      "@context": "https://schema.org",
      "@type": "Organization",
      "@id": abs("/#publisher"),
      name: SITE_NAME,
      url: abs("/"),
      logo: abs("/apple-touch-icon.png"),
      sameAs: ["https://bsky.app/profile/contributions.fyi"],
    },
  ];
}

/** Home › … › this page. Each crumb is [name, path]; the last is the page itself. */
export function breadcrumbs(trail: [string, string][]): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [["Home", "/"] as [string, string], ...trail].map(([name, path], i) => ({
      "@type": "ListItem",
      position: i + 1,
      name,
      item: abs(path),
    })),
  };
}

/** "D-AZ", the label members carry in titles. */
export const partyState = (m: Member) => `${partyLetter(m.party)}-${m.state}`;

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

/** "U.S. Representative for Arizona's 4th district" / "U.S. Senator from Arizona". */
export function office(m: Member) {
  const state = STATES[m.state] ?? m.state;
  if (m.chamber === "senate") return `U.S. Senator from ${state}`;
  if (!m.district) return `U.S. Representative for ${state} (at large)`;
  return `U.S. Representative for ${state}'s ${ordinal(m.district)} district`;
}

const PARTY_NAME: Record<string, string> = { Democrat: "Democratic Party", Republican: "Republican Party" };

/** A member's profile page: the Person, linked to their other profiles on the web. */
export function memberProfile(m: Member, path: string, former = false): Thing {
  const photo = photoUrl(m.bioguide);
  const sameAs = [
    m.url,
    `https://bioguide.congress.gov/search/bio/${m.bioguide}`,
    ...m.fecIds.map(fecCandidateUrl),
    ...m.accounts.map((a) => `https://bsky.app/profile/${a.handle}`),
  ].filter(Boolean);
  return {
    "@context": "https://schema.org",
    "@type": "ProfilePage",
    url: abs(path),
    dateModified: generatedAt.toISOString(),
    mainEntity: {
      "@type": "Person",
      "@id": abs(`${path}#person`),
      name: m.name,
      jobTitle: former ? `Former ${office(m)}` : office(m),
      ...(PARTY_NAME[m.party] && { affiliation: { "@type": "PoliticalParty", name: PARTY_NAME[m.party] } }),
      ...(!former && { memberOf: { "@type": "GovernmentOrganization", name: m.chamber === "senate" ? "United States Senate" : "United States House of Representatives" } }),
      identifier: { "@type": "PropertyValue", propertyID: "bioguide", value: m.bioguide },
      ...(photo && { image: abs(photo) }),
      sameAs,
    },
  };
}

/** An organization or PAC, with the FEC (and SEC) pages that describe it. */
export function organization(o: {
  path: string;
  name: string;
  description: string;
  sameAs?: (string | undefined)[];
  parent?: { name: string; path: string };
}): Thing {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    "@id": abs(`${o.path}#organization`),
    name: o.name,
    url: abs(o.path),
    description: o.description,
    ...(o.parent && { parentOrganization: { "@type": "Organization", "@id": abs(`${o.parent.path}#organization`), name: o.parent.name, url: abs(o.parent.path) } }),
    sameAs: (o.sameAs ?? []).filter(Boolean),
  };
}

/** Collapse whitespace and cut a description at a word near `max` characters. */
export function clip(text: string, max = 300) {
  const t = text.replace(/⁠/g, "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, t.lastIndexOf(" ", max - 1)).replace(/[,;:]$/, "")}…`;
}

/** "A, B and C". */
export function listOf(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}
