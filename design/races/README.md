# 2026 races and challengers

`/races/2026/` lists every House and Senate race on the Nov. 3, 2026 ballot;
`/races/2026/<slug>/` (`az-04`, `ak-at-large`, `az-senate`) puts the
candidates side by side; `/candidates/<fec id>/` is a smaller member page for
candidates who aren't members. Member pages link to their 2026 race.

## Data

`pnpm ingest --steps=races` (`src/ingest/races.ts`) writes `data/races.json`.
It's part of the weekly refresh (`STEPS` in `src/scripts/refresh/refresh.sh`)
and needs the fec step's cache, since outside spending by candidate comes from
there (`byCandidate` in `.cache/fec/data.json`, including 24/48-hour notices
and Form 5).

| What | From |
| --- | --- |
| Candidates, party, incumbent/challenger/open | `cn26` |
| Campaign committees | `ccl26` (principal and authorized) |
| Totals: receipts, individual, PAC, party, own money, cash | `weball26`; itemized/small from `committee_summary_2026.csv` |
| PAC contributions by committee | `pas226` (24K, 24Z) |
| Itemized individual donations, by industry and employer | `indiv26`, same rules and classifier as members |
| Outside spending for and against each candidate | the fec step (pas2, notices, Form 5) |
| On the November ballot | pre- and post-general reports (FEC API, `reports/house-senate`, 12G and 30G, cached a week; ~14 calls) |
| Who won | `data/race-results.json` (by hand) or congress-legislators after Jan. 3 |
| New district lines | `REDRAWN` in `races.ts`, from NCSL's tracker |

Money is the 2025–2026 cycle only, for incumbents too.

### Who was on the November ballot

FEC files don't record primary winners; `CAND_STATUS` (statutory candidate or
not) and `CAND_ICI` (incumbent/challenger/open) don't either, and `weball`'s
election-result columns stay empty until the FEC publishes official results,
months later. So a candidate counts as on the ballot when their campaign filed
a pre-general (12G, through Oct. 14) or post-general (30G) report.

That's a superset: some campaigns file a 12G after losing a primary or
retiring (Cornyn, Golden, Schakowsky did). Where a party has two such
candidates (outside CA, WA, AK and Louisiana's House races), the ones kept are
those with general-election-designated contributions dated after Sept. 15
(itemized individual or PAC; a primary loser has to refund general money) or
$10,000+ of general-election outside spending naming them. If none has
either, all are kept and marked `uncertain`, and their pages say FEC filings
don't settle it. Two candidate ids sharing one campaign committee are one
person and are merged.

Louisiana's House races were an open primary on Nov. 3 with Dec. 12 runoffs;
the pages say so.

### Results

Never inferred. A race shows "Results pending certification" until either:

1. **A certified result** is entered in `data/race-results.json`, with the
   certifying office and a link to the certification or official canvass:

   ```json
   "AZ-06": { "status": "certified", "winners": ["H6AZ06099"], "source": "the Arizona Secretary of State", "sourceUrl": "https://azsos.gov/...", "date": "2026-11-24" }
   ```

   For a race headed to a runoff, `"status": "runoff"` with the two candidates.
2. **The winner is sworn in**: once congress-legislators lists a candidate in
   the race in a term starting on or after 2027-01-03 for that seat, the
   ingest marks them `sworn-in` with no hand entry.

### Members who leave

`data/members.json` stays current members only: the labeler, Bluesky lists,
feeds and open data read it. When a member drops out of congress-legislators,
the ingest moves their last record to `data/former-members.json` (with the
date their term ended, from legislators-historical). The site builds member
pages for both; former members' pages say "Former member · … until <date>"
and leave out chamber rankings. Their 2026 candidacies keep linking to them.

## January 3, 2027: what has to happen

The switch is a data refresh, not a code change. In order:

- [ ] **Before Jan. 3:** enter certified results in `data/race-results.json`
      as states certify (most by early December; Louisiana's runoffs Dec. 12,
      Georgia's Dec. 1). Optional: everything is picked up on Jan. 3 anyway.
- [ ] **On or after Jan. 3, once congress-legislators is updated** (usually
      within a day or two of the swearing-in), run the weekly refresh, or by
      hand: `pnpm ingest --steps=accounts` then
      `pnpm ingest --steps=assignments,fec,bundling,committees,lobbying,individuals,donors,legislation,races`.
      That run:
  - drops departing members from `members.json` into `former-members.json`;
  - adds the new members (their 2026 money becomes their member page);
  - marks each race's winner `sworn-in` where congress-legislators shows them
    in the seat, and turns `/candidates/<id>/` for each new member into a
    redirect to `/members/<bioguide>/`;
  - keeps each race's incumbents as they were on Election Day (carried over
    from the previous `races.json`).
- [ ] **check-data** allows the turnover when everyone who left is in
      `former-members.json` and everyone who arrived was a 2026 candidate,
      dated on or after Jan. 3. If a new member isn't matched to their FEC
      candidate id (congress-legislators sometimes adds FEC ids late), it
      stops: add the id to congress-legislators upstream or wait a day, or
      check the list it prints and push by hand.
- [ ] **Labels:** `sync-labels` will want to label new members and remove
      departing members' labels, more than `--max-accounts=40`, so it holds
      the plan (exit 3). Review `.cache/label-plan.json` and apply by hand.
      Bluesky account matching for new members runs in the accounts step;
      check `data/review.json`.
- [ ] **Bills and votes:** `congressFor()` in `src/ingest/legislation.ts` moves to
      the 120th Congress; the first refresh after Jan. 3 starts it empty.
      Former members' vote tables come from the 119th Congress data until then.
- [ ] **Photos:** `pnpm photos` for new members' portraits.
- [ ] **Races still open on Jan. 3** (recounts, contested results): stay
      pending until certified; nothing to do.
- [ ] **Copy:** the races index and the about page say results are pending;
      once most races have results, update the index's note
      (`site/src/pages/races/2026/index.astro`).

What doesn't change: race and candidate URLs, `races.json`'s shape, and
labels' rules (members only).
