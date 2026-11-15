// Readable names for bills and resolutions that have no short title, from
// their official titles. "Providing for congressional disapproval under chapter
// 8 of title 5, United States Code, of the rule submitted by the Environmental
// Protection Agency relating to "Waste Emissions Charge for Petroleum and
// Natural Gas Systems: Procedures for..."" becomes "Disapproving the EPA rule
// on "Waste Emissions Charge for Petroleum and Natural Gas Systems"". The
// official title stays on the bill's page.

const AGENCIES: [RegExp, string][] = [
  [/^(the )?Environmental Protection Agency$/i, "EPA"],
  [/^(the )?Bureau of Consumer Financial Protection$/i, "CFPB"],
  [/^(the )?Consumer Financial Protection Bureau$/i, "CFPB"],
  [/^(the )?Internal Revenue Service$/i, "IRS"],
  [/^(the )?Federal Communications Commission$/i, "FCC"],
  [/^(the )?Bureau of Land Management$/i, "Bureau of Land Management"],
  [/^(the )?National Highway Traffic Safety Administration$/i, "NHTSA"],
  [/^(the )?Office of the Comptroller of the Currency.*$/i, "Comptroller of the Currency"],
  [/^(the )?Office of Energy Efficiency and Renewable Energy, Department of Energy$/i, "Energy Department"],
  [/^(the )?Department of Energy$/i, "Energy Department"],
  [/^(the )?Office of the Secretary of the Department of Health and Human Services$/i, "HHS"],
  [/^(the )?Department of Health and Human Services$/i, "HHS"],
  [/^(the )?United States Fish and Wildlife Service$/i, "Fish and Wildlife Service"],
];

const agency = (name: string) => AGENCIES.find(([re]) => re.test(name.trim()))?.[1] ?? name.trim().replace(/^the /i, "");

/** Cut at a word boundary, never mid-word. */
export function clip(text: string, max: number) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const at = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("-"));
  return cut.slice(0, at > max * 0.5 ? at : max).replace(/[\s,;:.–-]+$/, "") + "…";
}

/** The part of a rule's name before its subtitle: "Energy Conservation Program: Energy Conservation Standards…". */
function topic(raw: string) {
  const t = raw.replace(/^the /i, "").trim();
  const first = t.split(/;\s/)[0]!;
  return clip(first, 90);
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function displayName(name: string): string {
  let n = name
    .replace(/^(A|An original) (joint|concurrent) resolution\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  n = capitalize(n);

  // Congressional Review Act disapprovals.
  const cra = n.match(
    /^(?:Providing (?:for )?congressional disapproval(?: under chapter 8 of title 5, United States Code,)? of|Disapproving) the rule (?:submitted|issued) by (.+?) relating to (?:the )?(?:["“](.+?)["”]|(.+))$/i
  );
  if (cra) {
    const what = cra[2] ? `“${topic(cra[2])}”` : topic(cra[3]!.replace(/^the /i, ""));
    return `Disapproving the ${agency(cra[1]!)} rule on ${what}`;
  }
  const dc = n.match(/^Disapproving the action of the District of Columbia Council in approving the (.+)$/i);
  if (dc) return `Disapproving the D.C. Council's ${clip(dc[1]!, 100)}`;

  // War Powers Resolution.
  const war = n.match(
    /^(?:Directing the President,? pursuant to section 5\(c\) of the War Powers Resolution,? to remove|To direct the removal of) (?:the )?United States Armed Forces from (?:unauthorized )?(?:hostilities )?(?:with(?:in)?|against|in)?\s*(?:or against )?(.+?)(?: that have not been authorized by Congress)?$/i
  );
  if (war) return `Removing U.S. forces from hostilities with ${clip(war[1]!.replace(/^the Islamic Republic of Iran$/i, "Iran"), 60)}`;

  // Budget resolutions.
  const budget = n.match(/(?:setting forth|Establishing) the congressional budget for the United States Government for fiscal year (\d{4})/i);
  if (budget) return `Budget resolution for fiscal year ${budget[1]}`;

  const emergency = n.match(/^Terminating the national emergency declared (.+)$/i);
  if (emergency) return `Ending the national emergency declared ${clip(emergency[1]!, 70)}`;

  const amendment = n.match(/^Proposing an amendment to the Constitution of the United States (?:to require |requiring )(.+)$/i);
  if (amendment) return `Constitutional amendment requiring ${clip(amendment[1]!, 90)}`;

  // Only descriptive titles get shortened; a short title ("…Appropriations
  // Act, 2026") is the bill's name, however long.
  if (/^(To |A bill |Making |Providing |Directing |Disapproving |Proposing )/i.test(n)) {
    return clip(n.replace(/^A bill /i, "").replace(/,? and for other purposes$/i, ""), 100).replace(/^to /, "To ");
  }
  return n;
}
