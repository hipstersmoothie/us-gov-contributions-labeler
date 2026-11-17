// A post for each certified winner who isn't already in that chamber: who
// certified it, and who paid for the campaign.
//
// Results come from races-<year>.json, where the races step has checked each
// entry in race-results-<year>.json against its official source. Winners are
// never inferred from anything else (design/races/README.md).
import { RACE_YEAR, type Data, type Race, type RaceCandidate } from "../data.js";
import { day, fit, ownMoney, partyOf, personName, possessive, seatLabel, topContributors, topSectors, usd } from "../format.js";
import type { Draft } from "./types.js";

// What the race and candidate pages say once the site has the result.
const CERTIFIED_ON_PAGE = "won, as certified";

const winnersOf = (r: Race) =>
  r.result.status === "certified" || r.result.status === "sworn-in"
    ? (r.result.winners ?? []).map((id) => r.candidates.find((c) => c.id === id)).filter((c): c is RaceCandidate => !!c)
    : [];

/** "representative", "senator", "delegate". */
function electTitle(r: Race) {
  if (r.office === "S") return "senator";
  if (r.state === "PR") return "resident commissioner";
  return seatLabel(r) === "Delegate" ? "delegate" : "representative";
}

const surname = (name: string) => name.replace(/,? (Jr\.|Sr\.|II|III|IV)$/, "").split(" ").at(-1)!;

function post(c: RaceCandidate, r: Race, switching: boolean, data: Data): Draft | undefined {
  const money = c.money;
  if (!money?.receipts) return undefined; // nothing to say about who funded them
  const name = personName(c, data);
  const role = `${electTitle(r)}-elect`;
  const where = r.office === "H" && r.district ? `${role} for ${possessive(r.state)} ${seatLabel(r)}` : `${possessive(r.state)} ${role}`;
  const from = switching ? `, moving over from the ${r.office === "S" ? "House" : "Senate"}` : "";
  // Who certified it is on the link card ("won, as certified by ...").
  const certified = r.result.status === "certified" && r.result.date ? ` Certified ${day(r.result.date)}.` : "";

  const own = ownMoney(c);
  const ownNote = own >= 50_000 && own >= money.receipts * 0.2 ? `, including ${usd(own)} of the candidate's own money` : "";
  const through = money.through ? ` through ${day(money.through)}` : "";
  const { support, oppose } = c.outside;
  const who = surname(name);
  const outside =
    support && oppose
      ? `Outside groups spent ${usd(support)} supporting ${who} and ${usd(oppose)} opposing.`
      : support
        ? `Outside groups spent ${usd(support)} supporting ${who}.`
        : oppose
          ? `Outside groups spent ${usd(oppose)} opposing ${who}.`
          : "";
  const contributors = topContributors(c, data);
  const sectors = topSectors(c);

  const text = fit([
    { text: `Meet ${name} (${partyOf(c, data)}), ${where}${from}.${certified}` },
    { text: `\nThe campaign raised ${usd(money.receipts)}${through}${ownNote}.` },
    ...(contributors.length ? [{ text: `Top contributors: ${contributors.join(", ")}.`, optional: true }] : []),
    ...(outside ? [{ text: outside, optional: true }] : []),
    ...(sectors.length ? [{ text: `Top industries: ${sectors.join(", ")}.`, optional: true }] : []),
  ]);
  return {
    key: `member-elect:${RACE_YEAR}:${c.id}`,
    series: "member-elect",
    text,
    // A member's candidate page redirects to their member page, which is about their current seat.
    link: switching ? `/races/${RACE_YEAR}/${r.slug}/` : `/candidates/${c.id.toLowerCase()}/`,
    expect: CERTIFIED_ON_PAGE,
    priority: 1,
  };
}

export function memberElect(data: Data): { drafts: Draft[]; skipped: string[] } {
  const drafts: Draft[] = [];
  const skipped: string[] = [];
  for (const r of data.races.races) {
    for (const c of winnersOf(r)) {
      const m = c.bioguide ? data.memberById.get(c.bioguide) : undefined;
      const switching = !!m && (m.chamber === "senate") !== (r.office === "S");
      if (m && !switching) continue; // returning to the same chamber
      const d = post(c, r, switching, data);
      if (d) drafts.push(d);
      else skipped.push(`member-elect ${c.id} (${r.id}): no campaign money on file`);
    }
  }
  return { drafts, skipped };
}
