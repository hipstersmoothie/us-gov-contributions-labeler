# Legislation and votes: exploration

Can contributions.fyi add bills and votes, and show them next to the money
without implying the money bought the votes? Short answer: **the data is good;
the UX works only in a narrow, carefully framed version.** Details, numbers and
screenshots below. Everything here is on the `sesh/laws-and-votes-exploration`
branch; nothing was written to Bluesky, the PDS or the labeler.

## What's built

The "ship first" scope from section 3, with no PAC money next to votes:

- `pnpm ingest --steps=legislation` (also part of a full `pnpm ingest`) fetches
  bill status, roll calls and LD-2 reports into `.cache/legis/`, and writes
  `data/legislation.json` (6.3 MB). About 76 s from a warm cache; the first run
  is about 70 minutes, almost all lobbying reports, capped by
  `--legislation-minutes` (default 90) and resumed on the next run. The two
  latest quarters of reports are refetched weekly for late filings and
  amendments. Code: `src/ingest/legislation.ts`, `src/lib/bill-refs.ts`.
- **`/bills/`**: every bill and joint or concurrent resolution with a recorded
  passage vote (350), filterable by name or number, policy area and vote
  pattern.
- **`/bills/[id]/`**: sponsor, status, each passage vote by party (with every
  current member's vote behind a disclosure), and who reported lobbying on it:
  industries, quarters, any stated position, and the line from the report.
  No dollar figures, since reports don't give any per bill.
- **Member pages**: "How [member] votes": how often they voted with their
  party, every vote where they sided with a quarter of their party or less,
  and recent votes.
- **Organization pages**: "Bills it lobbied on".
- Bills in site search, a Bills nav item, and an About section
  (`/about/#bills`) on how bills are matched and what the reports can't say.
- **Readable names** for resolutions with no short title
  (`src/lib/bill-names.ts`): "Disapproving the EPA rule on “…”", "Removing
  U.S. forces from hostilities with Iran", "Budget resolution for fiscal year
  2026". The official title stays on the bill's page.
- **Independents** are shown as independents but counted with the party they
  caucus with on the day of each vote (congress-legislators' `caucus` and
  `party_affiliations`): Sanders and King with Democrats, Kevin Kiley with
  Republicans since March 2026, as a Republican before.
- **Page weight**: long lists (how each member voted, every lobbying
  organization, a member's older votes) are fragment pages under
  `/fragments/`, fetched when the reader opens them. Bill pages are about
  60 KB (H.R. 1: 692 → 88 KB); the votes section adds about 11 KB to a member
  page (was up to 290 KB).
- **Link previews**: a `bill` card (status, latest passage vote by party,
  who named it in the most lobbying reports) and a `page/bills` card.

The prototype's money-versus-vote charts (screenshots 03 and 05–08 below, and
the money columns in 06) are not in the build.

## 1. Data

All numbers are for the 119th Congress (January 2025 to November 12, 2026).

### Votes

| Source | Verdict | Notes |
| --- | --- | --- |
| House Clerk roll call XML (clerk.house.gov/evs) | **Use.** | One file per roll call, keyed by **bioguide id**, with the party each member voted under. 685 roll calls, 92 MB raw for both chambers, about 60 s to fetch with no key. Missing rolls come back as HTTP 200 with an error document, so check the body. |
| Senate LIS roll call XML (senate.gov) | **Use.** | Same shape, keyed by LIS id (`S428`); `congress-legislators` maps LIS to bioguide, but senators who left mid-Congress are only in the *historical* file. Needs a browser-like User-Agent. 921 roll calls. |
| Voteview CSVs | **Cross-check only.** | Current to within days and has bioguide ids, NOMINATE scores and bill numbers. But it's an academic dataset, not government data, and Senate roll numbers run on across sessions. Our parsed Clerk/LIS tallies match Voteview on 682 of 683 House and 918 of 921 Senate roll calls. |
| congress.gov API vote endpoints | **Skip.** | `house-vote` works with the api.data.gov key and has bioguide ids, but there is no Senate endpoint (404), and it's one request per roll call for what the Clerk serves as static files. |

Every current member appears in the vote data. One subtlety worth building in:
**use the party recorded on the roll call, not the member's party today.** Kevin
Kiley is an Independent on the site now but voted on the GENIUS Act as a
Republican; using today's party put a phantom "Independents 1–0" row in the House
tally.

### Bills

| Source | Verdict | Notes |
| --- | --- | --- |
| GovInfo BILLSTATUS bulk XML | **Use.** | One zip per bill type, refreshed daily, 55 MB zipped (333 MB unzipped) for all 19,962 bills and resolutions. Parses in about 10 s. Has sponsor/cosponsor **bioguide ids**, committee codes (100% join to our committee ids), CRS policy area and subjects, actions with links to every recorded vote, and laws. |
| congress.gov API | **Optional, for summaries.** | The FEC key works here, and this API allows **20,000 requests an hour**, not FEC's 1,000. Same content as BILLSTATUS; useful later for CRS summaries or text, not needed for this. |
| unitedstates/congress | **Skip.** | A Python scraper over the same GovInfo and Clerk sources, last commit October 2025. The GovTrack bulk mirror returns 403. Nothing it gives us that a 100-line TypeScript parser doesn't. |

Gotcha: pick a bill's name by title type. The default "title" of H.R. 1 is "An
act to provide for reconciliation…", and H.R. 7567 (the 2026 farm bill) carries
"CFTC Whistleblower Office Account Act" as a short title for a *portion*. Prefer
the popular title, then the enacted short title, then the display title.

### Bridges between money and bills

**LD-2 bill numbers (the interesting one).** Lobbying reports' "specific issues"
are free text, and filers write bill numbers in a dozen ways ("H.R. 3633",
"HR3633", "H. R. 3633", "S 1582", "H.J.Res. 25"). A strict parser
(`src/lib/bill-refs.ts`) that only accepts federal prefixes:

| | 119th Congress, Q1 2025 – Q3 2026 |
| --- | --- |
| LD-2 filings / latest quarterly reports | 192,477 / 173,654 |
| Issue entries citing at least one federal bill | **23.8%** (17% in Q1 2025, ~25% after) |
| Distinct 119th bills cited | 11,311 of 19,962 |
| Voted bills and joint resolutions cited by at least one report | **362 of 393** |
| Numbers that don't exist in the 119th | 0.1% |
| Citations to a bill *not yet introduced* by the end of the report's quarter (so: a previous Congress's bill with the same number) | 5.1% overall, **33% in Q1 2025**; dropped |
| Where the filer wrote the bill's name after the number, does it match? | **91.8%** after that guard (87.6% before; 64% → 89% in Q1 2025) |

The remaining ~8% mismatches are typos and reused low numbers. A second guard
(drop a citation when the name written beside it contradicts the bill's titles)
would catch most of them where a name is given; about half of citations have no
name, so expect roughly 92–95% precision overall. Reliable enough to list
"organizations that reported lobbying on this bill", as long as it's worded that
way and every row links to the quote from the report.

- **Only filings say who lobbied on what, never for which side.** Stance in
  the same clause as a bill number: support 6.9%, oppose 1.4%, both 0.5%, **neither 91%**. Treat every lobbying
  organization as "on every side".
- **Dollars aren't per bill.** A report's income/expenses cover every issue
  that quarter. "Spent $X lobbying on H.R. 3633" is not knowable; "$X across
  reports that mention H.R. 3633" is, and must be labeled that way.
- **Must-pass bills swamp the signal.** The NDAA, appropriations and the
  reconciliation act are each cited by 500–800 organizations. For H.R. 1, the
  organizations that lobbied on it account for 35–75% of members' PAC money on
  *both* sides. Any bill with 300+ lobbying clients is excluded from money
  comparisons.
- Matching clients to our organizations reuses the ingest's LDA client names:
  26–63% of a bill's lobbying clients match an organization on the site (37% for the GENIUS Act, 28% for H.R. 1); 1,185 of the site's 2,021 lobbying organizations cite at least one 119th bill. Unmatched clients mostly have no PAC, so they'd add no PAC money
  anyway.
- The `filing_specific_lobbying_issues` API filter is a literal substring
  match ("H.R. 3633" 428 filings, "H.R.3633" 151, "HR 3633" 90), so per-bill
  queries must search the bare number and re-parse. Bulk is simpler.

**Policy areas → sectors.** Possible but coarse: CRS has 32 policy areas;
about ten map cleanly to one sector (Health, Energy, Agriculture and Food →
Agribusiness, Armed Forces → Defense, Finance → Finance/Insurance/Real Estate,
Labor, Education, Transportation), while Taxation, Government Operations, Commerce
and Economics map to everything. The lobbying clients' own sectors are better
evidence of "who has a stake" than the bill's policy area, so the prototype
uses those.

**Committee jurisdiction.** Clean: BILLSTATUS committee codes (`hsba00`) join
100% (24,669 of 24,669) to the committee ids the site already has for
assignments. Good for "this went through a committee the member sits on",
which is low-risk context.

### Votes, classified

Of 400 final-passage votes on bills (House and Senate), about **44% are party-line** (90%+ of each party on opposite sides),
**28% near-unanimous**, and only **28% split** within a party: the only votes
where an individual member's choice says anything their party label doesn't.
Procedural votes (rules, previous question, motions to recommit, cloture) are
89% party-line in the House and 78% in the Senate, and should never be shown
next to money.

## 2. UX

Three directions, built as rough pages on the branch (screenshots in this
folder):

1. **A bill page** (`/bills/[id]/`): what the bill is, every passage vote as
   party bars with a plain label (Party line / Split / Near-unanimous), who
   lobbied on it by sector with the stance column honestly mostly blank, and a
   within-party swarm of PAC money from those organizations, shown **only**
   for split votes on bills that aren't too broad.
2. **On a member page**: "Votes on lobbied bills": their vote, their party's
   tally, a "Broke with party" tag only when they sided with 25% or less of
   their party, and the *share* of their PAC money from the bill's lobbying
   organizations next to the typical member's share.
3. **On an organization page**: "Bills it lobbied on" (from its own reports),
   and for split votes, how the members it funded voted against **every member
   of the same party**, plus how many of them had cosponsored the bill.

| | |
| --- | --- |
| `01-bills-index-light.png` | The prototype index: 11 bills, with each final vote's pattern. |
| `02-bill-hr1346-{light,dark}.png` | The full bill page for the E15 bill, where both parties split. |
| `03-bill-s1582-money-dark.png` | The within-party swarm for the GENIUS Act, House and Senate. |
| `04-bill-hr4776-party-line-light.png` | What the money section says for a party-line vote instead of a chart. |
| `05-bill-hr1-too-broad-dark.png` | What it says for a bill 2,684 organizations lobbied on. |
| `06-member-votes-cuellar-light.png` | The member-page votes table. |
| `07-org-bills-coinbase-dark.png` | Coinbase's bills, and how the members it funded voted. |
| `08-org-bills-growth-energy-light.png` | Growth Energy's bills and the E15 vote, with the cosponsor column. |

### What keeps it fair

- **Compare within a party, always.** An industry's PAC money leans to one
  party, so across parties the comparison mostly re-measures party.
- **Don't compare on party-line or near-unanimous votes.** The page says why
  instead of drawing a chart.
- **Don't compare on broad bills** (300+ lobbying clients).
- **Shares, not dollars** on member pages: members who raise more from PACs
  get more from every industry.
- **Say what the data can't**: lobbying reports don't give positions, the
  dollars aren't per bill, and giving covers years before and after the vote.

### Where the risk of misleading is high

Across all 217 within-party comparisons on split passage votes (bills cited by
fewer than 300 organizations, 5+ members on each side), median PAC money from
the bill's lobbying organizations differs **2x or more between a party's yes and
no voters 31% of the time** (24% as a share of each member's PAC money). In 43%
of those big dollar gaps, the two groups' *total* PAC money from everyone
differs by 1.5x+ too: the gap is about how much PAC money they take, not which
industry. So a naive page would show a striking money-vote gap on roughly a
quarter to a third of split votes, and many of those would mean nothing.

- **Selection, starkest case.** On the E15 bill (H.R. 1346), 91% of the
  Democrats Growth Energy funded voted yes, against 46% of all Democrats; 98%
  of its Republicans against 58%. That reads as "money bought votes". But 47
  of those 89 members had **cosponsored** the bill: they were on record as its
  allies before the vote. The ethanol industry funds corn-state members, who
  support ethanol because of their districts. The cosponsor column is the most
  useful counterweight we have; a prior-Congress vote on the same issue would
  be stronger.
- **Opposite sides added together.** On the same bill, Chevron, the American
  Petroleum Institute and AFPM (against E15) lobbied alongside Growth Energy and
  the Renewable Fuels Association (for it). Only 6 of 46 said which side they
  were on, and our sectors put ethanol producers and refiners both under
  Energy, so the sectors can't separate them either.

- **Crossover members.** The Democrats who vote with Republicans on permitting,
  farm or defense bills tend to hold competitive seats and take more business
  PAC money from everyone. On the SPEED Act, the 11 Democrats who voted yes got
  a median 17.7% of their PAC money from organizations that lobbied on it,
  against 11.0% for Democrats who voted no. That looks like a story and isn't
  evidence of one. This is the single biggest risk.
- **Selection.** On the CLARITY Act, 74% of the House Democrats Coinbase funded
  voted yes, against 37% of all House Democrats. It's just as consistent with
  Coinbase funding crypto-friendly Democrats as with money moving votes; the
  data can't tell them apart.
- **Small groups.** Five dissenters make a noisy median.
- **Labels.** "Broke with party" on a 102–110 split would be wrong; so would
  "spent $1.5M lobbying on the GENIUS Act".

## 3. Recommended scope

**Recommended: a narrow version, in two steps.**

*Ship first: low risk, high value*

- **Bill pages** for every bill with a recorded passage vote that lobbying
  reports cite (about 360 in the 119th): what it is, sponsor and committees,
  each passage vote by party with the Party line / Split / Near-unanimous
  label, and **who reported lobbying on it**, by sector, with quarters, any
  stated position, and the quoted line from the report. No money-versus-vote
  chart.
- **"Bills it lobbied on" on organization pages.** This ties the site's money
  to what the money's sponsors were working on, without saying anything about
  votes.
- **Votes on member pages, without the money columns**: how they voted on
  those bills, how their party voted, and "broke with party" only at 25% or
  less. Members' pages are where an implied "paid for" claim is most personal,
  and the Bluesky labels shouldn't carry anything vote-related at all.

*Later, only with better baselines*

- The within-party comparison on bill pages, and "how the members it funded
  voted" on organization pages, once we have:
  1. **Contribution dates**, so giving can be split into before and after the
     vote. FEC `pas2` rows carry the transaction date (column 13), and the
     ingest already streams them.
  2. **Prior positions**: cosponsorship (already in BILLSTATUS) and votes on
     the previous Congress's version of the same bill (Clerk/LIS XML go back
     decades).
  3. **The name-contradiction guard** for LD-2 citations.

  Even then: never across parties, never on party-line, near-unanimous or
  300+-client bills, shares rather than dollars, and no rankings ("members
  most funded by the bill's lobbyists").

**Not worth it:** procedural votes, Voteview's ideology scores (academic
modeling, not government data), the congress.gov vote API, and mapping CRS
policy areas onto sectors (the lobbying clients' own sectors are better
evidence).

## 4. Ingest cost

Measured on this machine for the whole 119th Congress so far:

| Step | Cold run | Incremental | Raw cache | Output |
| --- | --- | --- | --- | --- |
| BILLSTATUS bulk (8 zips) | 60 s download, 10–20 s parse | Same (zips are refreshed daily) | 55 MB zipped, 333 MB unzipped | 14 MB all bills; far less for voted bills only |
| House + Senate roll calls | ~60 s (1,606 files, no key) | Seconds (only new rolls) | 92 MB | 11 MB all roll calls with parties; ~3 MB for passage votes only |
| LD-2 reports (lda.gov API) | **64 min** (7,650 pages of 25, ~120 pages/min with the key; occasional throttling, retried) | ~10 min per quarter; re-fetch the last two quarters for amendments | 135 MB trimmed | — |
| Join and build | 4.5 min in the prototype (re-parses every report per bill); ~30 s if parsed once | — | — | 3.4 MB for 11 bills plus every organization's bill list; **est. 8–12 MB** for all ~360 voted bills |

Total first run: about 70 minutes, almost all LD-2, which fits the existing
background ingest pattern (budgeted minutes per run, caching between runs).
api.data.gov limits aren't a factor: BILLSTATUS and roll calls are static
files, and the congress.gov API allows 20,000 requests an hour if we use it.
