# House and Senate races

`/races/<year>/` lists every House and Senate race of a federal general
election; `/races/<year>/<slug>/` (`az-04`, `ak-at-large`, `az-senate`) puts
the candidates side by side; `/candidates/<fec id>/` is a smaller member page
for candidates who aren't members (about their latest race, linking earlier
ones). Member pages link their latest race. `/races/` goes to the latest year.

Nothing in the code is tied to one election. Each election is three files:

| File | What | Who writes it |
| --- | --- | --- |
| `data/elections-<year>.json` | dates, House seats per state, redistricting, primary systems, runoffs, Senate specials, each state's certification date and results page | a person, once a cycle (below) |
| `data/races-<year>.json` | the races, candidates, money, outside spending, results | `pnpm ingest --steps=races` |
| `data/race-results-<year>.json` | certified results, each with its official source | `pnpm race-results add` / `import` |

## Data

`pnpm ingest --steps=races` (`src/ingest/races.ts`) builds every year that has
an `elections-<year>.json`, until a year after that Congress is sworn in
(`--race-years=2026,2028` to choose). It's in the weekly refresh. It needs the
fec step's cache: outside spending by candidate comes from there
(`byCandidate`, including 24/48-hour notices and Form 5), and the year has to
be one of the cycles ingested (the last three).

| What | From |
| --- | --- |
| Candidates, party, incumbent/challenger/open | `cn<yy>` |
| Campaign committees | `ccl<yy>` (principal and authorized) |
| Totals: receipts, individual, PAC, party, own money, cash | `weball<yy>`; itemized/small from `committee_summary_<year>.csv` |
| PAC contributions by committee | `pas2<yy>` (24K, 24Z) |
| Itemized individual donations, by industry and employer | `indiv<yy>`, same rules and classifier as members |
| Outside spending for and against each candidate | the fec step (pas2, notices, Form 5) |
| On the November ballot | the FEC's ballot list when published, else pre- and post-general reports (below) |
| Votes and winners | state certifications, the FEC's official results, congress-legislators (below) |

Money is the election's two-year cycle only, incumbents too.

### Who was on the November ballot

Best source first:

1. **The FEC's list of general-election candidates**
   (`<year>congressgecands.xlsx`, compiled from state election offices, with
   FEC ids), found on the FEC's election results page and parsed by
   `src/ingest/election-results.ts`. Once it's published it decides every race
   it covers. It wasn't out yet for 2026 as of Nov. 16.
2. **Campaigns' filings.** A campaign files a pre-general (12G, through 20 days
   before the election) or post-general (30G) report for a general it's on the
   ballot for (FEC API `reports/house-senate`, ~14 calls, cached a week). Some
   file one after losing a primary or retiring (Cornyn, Golden and Schakowsky
   did in 2026), so where a party has two such candidates (outside top-two and
   top-four states and Louisiana's House races): $10,000+ of general-election
   outside spending decides; else general-election-designated money given
   after the primaries (`lateGeneralFrom`; a primary loser must refund it), if
   one has 5× the other's; else all are kept and marked `uncertain`, and their
   pages say FEC filings don't settle it.
3. Where nobody filed one, everyone who raised money, and the race says the
   nominees aren't known.

Two candidate ids sharing a campaign committee are one person and are merged.
**Known limit:** a state with a regular and a special Senate election in the
same year (Nebraska in 2024) gets one race page with both fields: FEC
candidate records don't say which seat a candidate ran for. There's no such
state in 2026; if one comes up, split it by the ballot list's
"S-Unexpired Term" lines.
One-seat states are at large whatever district was filed; races for seats
that don't exist (`houseSeats`) are stray filings and are dropped.

### Results

Never inferred from money, filings or early returns. A race shows a winner
only from:

1. **A state certification** in `data/race-results-<year>.json`, entered with
   `pnpm race-results` (below).
2. **The FEC's official results** (`federalelections<year>.xlsx`, about a year
   after the election): votes, shares and the winner for every candidate,
   picked up automatically. Votes appear on race and candidate pages.
3. **Being sworn in**: a candidate in the race holding the seat in a term that
   starts on or after `newCongress`, per congress-legislators.

If two of these disagree (or a final result isn't one of the two a state sent
to a runoff), the race stays pending, the run logs `official sources
disagree`, and `race-results status` shows `CONFLICT`. Before Election Day
races are `upcoming`.

### Entering certified results

```sh
pnpm race-results status            # pending races by state; states past their certification date first,
                                    # each with its official results page and the candidates' FEC ids
pnpm race-results add 2026 WY-AL H6WY00217 \
  --source "the Wyoming State Canvassing Board" \
  --url https://sos.wyo.gov/.../2026_General_State_Canvassing_Board_Minutes.pdf \
  --evidence https://sos.wyo.gov/.../2026_General_Statewide_Candidates_Summary.pdf \
  --date 2026-11-10                 # add --runoff with two ids for a race headed to a runoff
pnpm race-results check             # re-fetch every source; the weekly refresh runs this too
pnpm race-results import 2026 notes.json   # a batch, e.g. from a research pass; same checks
pnpm ingest --steps=races           # apply (or wait for the weekly run)
```

An entry is refused unless the winners are candidates in that race, `--url`
is an https link on an official site (`.gov`, `.us`, a territory's `.gov.xx`,
or a state's results vendor such as `enr-scvotes.org` / Clarity), it has the
certifying office and date, and **each winner's name appears in the source
or the `--evidence` link** (the state's official results, when the
certification is board minutes, a press release or a scan). The name check
proves the right race and people, not who won: read the winner off the
official count before adding it. Scanned certificates with no text (South
Dakota 2026) can't pass; wait for the state's results site to say official,
or use its official results file as evidence.

What counts as certified: the state's certification document, its canvass
board's minutes, or its results marked official/certified after the canvass.
Not unofficial election-night results, news reports or AP.

**2026 so far** (Nov. 16): DE, SC (not SC-02, in a recount), WY, VT, VI and MP
are entered and checked. SD (scan) and OK (results app blocks scripts) have
certified but aren't entered. Every other state certifies between Nov. 17
and Dec. 15 (`certification` in `elections-2026.json`).

### Members who leave

`data/members.json` stays current members only: the labeler, Bluesky lists,
feeds and open data's member records read it. When a member drops out of
congress-legislators, the ingest moves their last record to
`data/former-members.json` (with the date their term ended, from
legislators-historical). The site builds member pages for both; former
members' pages say "Former member · … until <date>" and leave out chamber
rankings. Their candidacies keep linking to them, and each race keeps its
Election Day incumbents (carried over from the previous `races-<year>.json`
once the new Congress starts).

## Each cycle

For the 2028 election (and every one after), nothing in the code changes. The
pipeline was run against 2024 (a throwaway `elections-2024.json`) to check
this: the FEC's 2024 ballot list decided all 474 races, and 456 got their
winner from congress-legislators with no conflicts; the other 18 were seats
whose 2024 winner has since left (they wait for the FEC's official results).

- [ ] **Early in the election year:** copy `data/elections-2026.json` to
      `data/elections-2028.json` and update: `year`, `electionDay` (first
      Tuesday after the first Monday in November), `newCongress` (Jan. 3 of the
      next year), `lateGeneralFrom` (the day after the last regular primary,
      from the states' calendars or the FEC's primary dates),
      `redistricting` (NCSL's redistricting tracker; empty if nothing
      changed), `systems` (top-two, top-four, Louisiana), `runoffs`,
      `senateSpecials` (vacancies filled that year), and `houseSeats` (only
      after a census reapportionment: 2032). Leave `certification` deadlines
      for after the election, or update the dates from the states'
      calendars.
- [ ] The weekly refresh then builds `races-2028.json` all year: before
      the primaries every race lists the candidates who raised money, and
      pages say the election is upcoming. `/races/` and the nav switch to 2028
      on the first build with the file.
- [ ] **October:** pre-general reports arrive; nominees come from them.
      The FEC's ballot list replaces them once it's published.
- [ ] **After Election Day:** `pnpm race-results status` each week; enter
      certifications as states finish (most by early December; runoffs in
      Georgia and Louisiana in December).
- [ ] **Jan. 3:** see below.
- [ ] **About a year later:** the FEC's official results fill in votes and
      confirm every winner; after that the year is no longer rebuilt.

## Jan. 3, 2027 (and every new Congress)

The switch is a data refresh, not a code change:

- [ ] On or after Jan. 3, once congress-legislators is updated (usually a day
      or two after the swearing-in), let the weekly refresh run, or by hand:
      `pnpm ingest --steps=accounts` then
      `pnpm ingest --steps=assignments,fec,bundling,committees,lobbying,individuals,donors,legislation,races`.
      That run:
  - drops departing members from `members.json` into `former-members.json`;
  - adds the new members (their campaign money becomes their member page);
  - marks each race's winner `sworn-in` where congress-legislators shows them
    in the seat (and checks it against any certification), and turns each new
    member's `/candidates/<id>/` into a redirect to `/members/<bioguide>/`;
  - keeps each race's Election Day incumbents.
- [ ] **check-data** allows the turnover, in the month after `newCongress`,
      when everyone who left is in `former-members.json` and everyone who
      arrived was a candidate in a race. If a new member isn't matched to their
      FEC candidate id (congress-legislators sometimes adds FEC ids late), it
      stops: wait a day, or check the list it prints and push by hand.
- [ ] **Labels:** `sync-labels` will want to label new members and drop
      departing members' labels, more than `--max-accounts=40`, so it holds
      the plan (exit 3). Review `.cache/label-plan.json` and apply by hand.
      Check `data/review.json` for new members' Bluesky accounts.
- [ ] **Bills and votes:** `congressFor()` in `src/ingest/legislation.ts`
      moves to the new Congress; the first refresh after Jan. 3 starts it
      empty.
- [ ] **Photos:** `pnpm photos` for new members' portraits.
- [ ] **District maps:** the member finder and state pages map ZIPs and
      addresses to the 119th Congress's districts until `CONGRESS` in
      `src/lib/districts.ts` moves to 120; see "Districts and the next
      Congress" in the README. The build warns when a member's district isn't
      on the map.
- [ ] Races still undecided on Jan. 3 (recounts, contests) stay pending until
      certified.

What doesn't change: URLs, the files' shapes, and labels' rules (members
only).
