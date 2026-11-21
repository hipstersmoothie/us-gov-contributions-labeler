# LD-203 lobbyist contribution reports: is it worth adding to contributions.fyi?

Source: the semiannual LD-203 reports every lobbying registrant and every listed lobbyist files under 2 U.S.C. § 1604(d), read from the lda.gov REST API (`/api/v1/contributions/`) on November 21, 2026.
Scope: filing years 2023–2026 (2026 is the mid-year report only; the year-end report is due January 30, 2027). Scripts: `src/scripts/ld203/` (`fetch.ts`, `analyze.ts`, `common.ts`). Cache: `.cache/ld203/`.

## Short answer
**Yes, build a small piece: the non-FECA items.** An LD-203 lists two kinds of things. The FECA contributions (PAC and lobbyist checks of $200 or more to candidates, leadership PACs and parties) are already in the FEC data the site ingests, and are about 95% of the rows. The rest, honorary and meeting expenses, presidential library and inaugural committee gifts, is **not** anywhere else: 4,181 items and **$267M** over 2023–2026, filed by about 400 companies, trade groups and unions, 90% of them already on the site or a name-alias away. Honorary and meeting items come to $127M; 38% of it names a current member of Congress as the honoree (478 of 539 members named at least once; in 2025–26 filings, 445 members, $23.5M), and what it pays for is caucus foundations' galas, awards dinners and members' pet charities, not campaigns (PAC and party payees are 2.7%). Inaugural ($65M, 2024–25) and presidential library gifts ($74M, of which SoftBank's $50M to the Trump library in 2026) are clean, large and name no member, so they fit organization pages directly. **Recommendation:** an "Honorary expenses" block on organization pages (plus inaugural and library gifts), an "Events and causes honoring this member" section on member pages for the name-matched items, and a short index page. Don't touch the FECA rows.

## 1. Where the data is (and isn't)

- **lda.gov API.** `GET /api/v1/contributions/` returns whole filings: filer (registrant, and the lobbyist for individual filings), `filing_type` (MM mid-year, YY year-end, MA/YA amendments), `dt_posted`, `comments`, `pacs[]`, `no_contributions`, and `contribution_items[]` with `contribution_type` (`feca`, `he`, `me`, `ple`, `pic`), `contributor_name`, `payee_name`, `honoree_name`, `amount`, `date`. Filters: `filing_year`, `filing_period`, `filing_type`, `filing_dt_posted_after/before`, `registrant_id/name`, `lobbyist_id/name`, `lobbyist_exclude`, `contribution_type`, `contribution_date_*`, `contribution_amount_*`, `contribution_contributor/payee/honoree`. Spec: `https://lda.gov/api/openapi/v1/?format=openapi-json` (the `/api/v1/constants/contribution/itemtypes/` endpoint lists the item types).
- **`page_size` is capped at 25.** The docs say so and the server enforces it; asking for 100 (as `src/ingest/lobbying.ts` does) returns 25. Anonymous callers get 15 requests/minute, keyed ones 120/minute (the 250 ms interval in `lobbying.ts` is faster than the limit; 500 ms is the real floor).
- **The `contribution_type` filter is what makes this cheap.** It returns the filings that have at least one item of that type, so the non-FECA material is a few hundred filings a year instead of ~40,000:

| Year | All LD-203 filings | …by organizations | …with FECA items | …with honorary | …meeting | …library | …inaugural | Amendments (MA + YA) |
|---|---|---|---|---|---|---|---|---|
| 2023 | 38,908 | 11,697 | 10,965 (28%) | 315 | 55 | 22 | 0 | 2,974 (7.6%) |
| 2024 | 38,886 | 11,639 | 11,923 (31%) | 322 | 62 | 21 | 60 | 2,740 (7.0%) |
| 2025 | 40,509 | 12,178 | 11,244 (28%) | 307 | 57 | 27 | 51 | 2,843 (7.0%) |
| 2026 (mid-year) | 20,048 | 5,874 | 6,098 (30%) | 136 | 22 | 19 | 0 | 1,109 |

  About 70% of filings are "no contributions" forms. A full year is 40,509 / 25 = 1,621 requests: 1.9 hours anonymous, about 14 minutes with a key. The non-FECA pull for all four years, including the counts above, was **96 requests** (6.6 minutes anonymous). No `LDA_API_KEY` is set in the main checkout's `.env`; the ingest code reads one if present.
- **No bulk file.** The Senate's downloadable LD-203 zips (`soprweb.senate.gov/downloads/{year}_{q}_LD203.zip`, linked from `senate.gov/legislative/Public_Disclosure/contributions_download.htm`) stop at 2022 Q1 and the host no longer resolves; the page itself says the API replaced them. The House Clerk's `disclosurespreview.house.gov` is a search UI with a "data-requests@clerk.house.gov" address and no download. So the API is the only source, and the filtered pull is the way to use it.

## 2. Shape

Items by type, 2023–2026 mid-year, after dropping superseded originals (71 of 1,364 filings; see § 5):

| Type | Items | $ | Registrants | What it is |
|---|---|---|---|---|
| Honorary expenses (`he`) | 3,430 | $121.3M | ~210/yr | paying for an event that honors or recognizes a covered official |
| Meeting expenses (`me`) | 521 | $5.8M | ~40/yr | paying for a meeting or event hosted by a covered official |
| Presidential library (`ple`) | 113 | $74.4M | 43 | gifts to presidential library foundations |
| Inaugural committee (`pic`) | 117 | $65.2M | 106 | gifts to the 2025 inaugural committee (filed 2024 year-end and 2025 mid-year) |
| **Total non-FECA** | **4,181** | **$266.8M** | 399 (he+me) | |

By year: honorary $29.9M (2023), $31.5M (2024), $37.8M (2025), $22.1M (first half of 2026); meeting $1.0M, $2.5M, $1.5M, $0.8M; library $5.8M, $6.4M, $9.1M, $53.2M; inaugural $34.4M (2024), $30.8M (2025).

- 89% of honorary/meeting filings are by organizations (1,043 vs 125 by individual lobbyists); 91% of items name `SELF` as the contributor, the rest a PAC.
- The money is concentrated: the top 25 filers hold about half of honorary/meeting dollars. Chevron $8.1M, Amazon $5.8M, AARP $5.6M, State Farm $5.6M, Meta $4.7M, Comcast $3.1M, United Airlines $3.1M, RTX $3.0M, Morgan Stanley $2.8M, Toyota $2.7M, Philip Morris International $2.6M, Vantive $2.5M, PepsiCo $2.2M, University of Louisville $2.2M, Google $2.1M, Reynolds (RAI) $1.9M, Amgen $1.9M, Southwest $1.9M, GM $1.9M, AT&T $1.8M, FedEx $1.7M, Johns Hopkins $1.7M, ExxonMobil $1.6M, Visa $1.5M, Deloitte $1.5M.
- Items per filing: median 8, max 116 (AARP and ExxonMobil file dozens of $1k–$5k sponsorships a period).

**Where honorary and meeting money goes** (payee, by keyword class):

| Payee class | Items | $ | Share |
|---|---|---|---|
| Caucus foundations and congressional institutes (CBCF, CHCI, APAICS, CHLI, Congressional Award Foundation, Congressional Sports for Charity, Congressional Institute) | 1,042 | $49.3M | 38.8% |
| Other nonprofits, charities, universities, awards dinners | 1,129 | $38.8M | 30.5% |
| Unclassified ("Various vendors", Smithsonian, UnidosUS, Senate Working Group, hotels named in prose) | 950 | $17.0M | 13.4% |
| Vendors and venues (including Freedom 250 LLC, the White House ballroom entity, $9.1M) | 348 | $11.7M | 9.2% |
| Inaugural committee or presidential library, filed as honorary by mistake | 15 | $6.8M | 5.3% |
| PAC, campaign or party committee (already in FEC data) | 466 | $3.5M | 2.7% |

Top payees: Congressional Black Caucus Foundation $17.2M (248 items), Congressional Hispanic Caucus Institute $14.9M (237), Freedom 250 LLC $9.1M (4), "Various vendors" $5.3M (73), Trump Vance Inaugural Committee $3.9M (filed as honorary), Kennedy Center $3.6M, Congressional Hispanic Leadership Institute $3.1M, APAICS $3.1M, Library of Congress $3.0M, Habitat for Humanity $2.65M (one State Farm item honoring Rep. Foxx), Trust for the National Mall $2.5M (the White House ballroom), Smithsonian Science Education Center $1.4M, Congressional Award Foundation $1.4M, CBC Institute $1.3M, Congressional Institute $1.1M, CBC Political Education & Leadership Institute $1.1M, Holocaust Memorial Museum $1.0M, UnidosUS $1.0M, University of Louisville $0.9M, Congressional Sports for Charity $0.9M, Ford's Theatre Society $0.9M, McConnell Center $0.8M.

## 3. Who is honored

`honoree_name` is free text: "Sen. John Thune", "Rep C Allred; Rep A Pfluger; Lyssa Bell (Rep. Pfluger)…", "Members of the Congressional Black Caucus", "The White House", a 400-word list of the Cabinet. I matched it against `data/members.json` by surname plus an adjacent first name or nickname ("Chuck" for Charles, "Bobby" for Robert), with a surname alone accepted only when it's unique among current members *and* the text has a legislative title (Sen., Rep., Speaker, Whip, Leader, Hon.). Words after a surname like Center, Foundation, Library or Award ("John F. Kennedy Center", "McConnell Center") and before it like "of" ("Department of Justice" is not Sen. Justice) are skipped. Honorary + meeting items, 3,951 items, $127.1M:

| Match | Items | $ | Share of $ |
|---|---|---|---|
| Full name | 1,872 | $46.1M | 36.3% |
| Unique surname with a title | 107 | $2.1M | 1.6% |
| Shared surname, no first name ("Sen. Scott", "Rep. Kelly", "Rep. Johnson") | 60 | $1.1M | 0.8% |
| No current member named | 1,912 | $77.8M | 61.2% |
| …of which: a group ("Members of the CBC", "Congressional Hispanic Caucus", board members) | 742 | $36.9M | |
| …executive branch (Trump Cabinet lists at Freedom 250, "The White House", agency heads) | 205 | $14.9M | |
| …a title but no current member (former members: Napolitano, Cárdenas, Romney, Bucshon; staff; "Congressional Baseball Game") | 256 | $9.4M | |
| …other (judges, generals, Fed and FDIC officials, sponsorships described in prose) | 681 | $14.9M | |
| …blank or "N/A" | 25 | $0.6M | |

1,249 items ($50.6M, 40%) name more than one person; the per-member figures below split those evenly.

- **Precision.** 25 full matches drawn at random were all the right person. Misses within them were former or deceased members ("Bill Pascrell", "Donald Payne Jr.") and a misspelling ("Rep. Eric Sorenson"). Before the adjacency and title rules, the Cabinet lists matched five members (a "Mike" and a "Collins" in the same string), the Kennedy Center matched Sen. John Kennedy and "Department of Justice" matched Sen. Jim Justice; about $7M of false positives, now gone. The 60 shared-surname items should be shown only with hand resolution or not at all.
- **Coverage.** 478 of 539 current members are named at least once in 2023–26 (406 twice or more, 251 five or more, 132 ten or more); 271 members have $10,000+ and 154 have $50,000+. **In 2025–26 filings alone: 871 items, $23.5M, 445 members, 321 of them twice or more, median $6,667 per named member.**
- **What honoring a member pays for** (matched items): nonprofits, charities and awards 46%; caucus foundations 26%; unclassified prose payees 19%; venues 6.5%; PAC or campaign committees 1.8% ($0.86M, mostly FECA rows the filer put in the wrong box: "Heartland Values PAC, honoree Sen. John Thune").

Top members by honorary + meeting dollars, 2023–26 (all four years):

| Member | Items | $ | Filers | What it paid for |
|---|---|---|---|---|
| Virginia Foxx (R-NC) | 11 | $2.73M | 9 | one State Farm item: Habitat for Humanity $2.65M; Congressional Award Foundation |
| Mitch McConnell (R-KY) | 30 | $2.64M | 13 | University of Louisville $947K, McConnell Center $790K, McConnell Chao Archives $458K |
| Nancy Pelosi (D-CA) | 42 | $2.02M | 20 | Ford's Theatre Society $500K, Elizabeth Dole Foundation $250K, vendors |
| Hakeem Jeffries (D-NY) | 42 | $1.89M | 30 | CBC Foundation $678K, "Our Gala" vendors $594K |
| Bobby Scott (D-VA) | 21 | $1.76M | 16 | Freedom 250 LLC $1.5M (named on a long list), ODU commencement, CBCF |
| James Clyburn (D-SC) | 83 | $1.16M | 35 | CBCF $140K, Clyburn Scholarship Foundation $137K, Faith and Politics Institute $125K |
| Catherine Cortez Masto (D-NV) | 36 | $1.05M | 14 | Smithsonian Science Education Center $350K (Board of Regents) |
| Judy Chu (D-CA) | 40 | $1.05M | 22 | APAICS $740K |
| Katherine Clark (D-MA) | 27 | $1.01M | 22 | one item: the National Women's Law Center's whole gala, $785K to "various vendors", with Clark one of several honorees; NNPA |
| Debbie Dingell (D-MI) | 62 | $0.91M | 29 | Ford's Theatre Society $338K, Congressional Award Foundation $178K |
| Ben Ray Luján (D-NM) | 51 | $0.90M | 27 | UnidosUS Capital Awards $397K, CHCI $269K |
| Grace Meng (D-NY) | 32 | $0.86M | 16 | APAICS $640K |
| Doris Matsui (D-CA) | 16 | $0.82M | 10 | Smithsonian Science Education Center $350K (Regent), NMAAHC $140K |
| Darren Soto (D-FL) | 56 | $0.64M | 23 | CHCI $575K |
| Terri Sewell (D-AL) | 51 | $0.64M | 28 | CBCF $331K, university vendors $192K |
| John Boozman (R-AR), Gary Peters (D-MI) | 24, 15 | $0.61M, $0.54M | | Smithsonian Regents events |
| Robin Kelly (D-IL) | 65 | $0.53M | 38 | CBCF $200K, Prevent Cancer Foundation $92K |
| Gil Cisneros (D-CA) | 14 | $0.51M | 10 | CHCI $491K |
| Joaquin Castro, Mark Warner, Delia Ramirez, Steven Horsford, Nanette Barragán, Shelley Moore Capito | 8–55 | $0.43–0.50M | | UnidosUS, CHCI, CBCF, Prevent Cancer Foundation, Virginia charities |

The pattern: caucus foundations' annual galas (CBCF, CHCI, APAICS) list the caucus chairs and board members as honorees, so members who chair or sit on those boards accumulate dozens of $5k–$25k sponsorships; a handful of single items ($2.65M for Foxx, $1.5M Freedom 250 lists, the $785K NWLC gala for Clark) dominate individual totals and need a line of context, and when the filer is the charity itself (NWLC, Johns Hopkins, Boston University, University of Louisville) the "expense" is the cost of its own event. The Smithsonian Board of Regents items name the congressional regents.

## 4. Filers and the site's organizations

- 399 registrants filed honorary or meeting items in 2023–26. By `normalizeOrg`/`sameOrg` against `data/organizations.json` names and `lobbying.client`: **187 (47%) match, holding $74.6M of $127.1M (59%)**. The misses in the top 25 are mostly alias problems the ingest already solves elsewhere: "Chevron U.S.A. Inc." (site: Chevron Corp), "Meta Platforms, Inc. and Various Subsidiaries", "Google Client Services LLC", "AT&T Services, Inc. and Its Affiliates", "RAI Services Company" (Reynolds American). Joining on LDA `registrant_id` through the organizations' existing lobbying lookups, or a short alias list, would lift the top 25 to 21 of 25. The genuinely absent are groups without a PAC: AARP ($5.6M), Philip Morris International, University of Louisville, Johns Hopkins, Boston University.
- Inaugural: 106 registrants, **70 on the site, $45.6M of $65.2M** (JBS $5M, Chevron $2M, Robinhood $2M, Amazon $1.9M, GM $1.5M, Intuit, Meta, Comcast, J&J, Altria $1M each).
- Library: 43 registrants, 23 on the site, $11.9M of $74.4M (SoftBank's $50M to the Trump library and HCSC's $5M to the Obama Foundation are not; Apple $6M, Palantir $5.05M to the Reagan Foundation, RTX $1.3M, GE $1.1M are).

## 5. Amendments and data traps

- **Amendments replace the whole report.** `filing_type` MA/YA amends the MM/YY of the same filer and period; the key is (registrant id, lobbyist id or none, filing year, period) and the latest `dt_posted` wins. 7% of all filings are amendments; in the non-FECA pull 137 of 1,364, and 71 originals were superseded in-set (double-counting them would add about 5%). **Blind spot:** an amendment that *removes* the honorary items isn't returned by the `contribution_type` filter, so the original would survive. For a build, also pull `filing_type=MA` and `YA` with `filing_dt_posted_after=<last run>` (about 110 requests a year at 25 per page, or 3 a month incrementally) and void any kept filing with the same key.
- **Misfiled types.** 466 honorary/meeting items ($3.5M) pay a PAC, campaign or party committee: FECA contributions in the wrong box, already in FEC data; drop payees that `looksLikePac` or end in "for Congress". 8 inaugural ($3.9M) and 7 library ($3.0M) items were filed as honorary; reclassify by payee.
- **One expense, several rows.** Some filers list the same payment once per honoree ("The Hill Media Organization (this is same expense as #42 and #43)", three $50k rows). Collapse identical (filing, payee, amount, date) rows before totaling; the comments field sometimes says so.
- **Free-text honorees**: groups ("Members of the Congressional Black Caucus", 57 items, $5.3M), prose ("Mitt Romney received an honorary degree. the amount reflects the total cost of multiple events…", $1.7M), staff with their boss in parentheses, former and deceased members, misspellings, initials ("Rep C Allred"), state tags "(FL-012-R)". About 28 shared surnames among current members (Johnson ×4, Lee ×4, Moore ×5, Smith ×5, Kelly ×4, Scott ×4…) make "Rep. Johnson" unresolvable; "Speaker Johnson" is.
- **Payee prose**: "Various vendors" (73 items, $5.3M), "The National Building Museum, where UnidosUS's Capital Awards event was held", "Renaissance Hotel; Encore; …". Show as filed; classify loosely.
- **Comments** on 245 of 1,293 filings: event descriptions, "funds are used for salary and fringe benefits for UofL employees" (McConnell Center), and corrections that void earlier items. Worth showing on the item.
- Blank or N/A honoree: 26 items ($0.6M). Amounts ≤ 0: none. Items dated outside their filing period: 2 of 4,181. Amounts of $100k+: 422.
- **FECA rows are duplicates of FEC data.** The 1,293 filings pulled carry 73,616 FECA items ($200M) alongside; ~11–12k filings a year have them. An LD-203 FECA row is the registrant PAC's or the lobbyist's own contribution of $200+ to a federal committee, which the recipient itemizes on Schedule A and a PAC on Schedule B, so every one is in the FEC bulk files the site already loads (and at lower resolution, since LD-203 drops sub-$200 rows). The one thing LD-203 adds is `honoree_name` on a FECA row, which names the member behind a leadership PAC or joint fundraiser ("Farm Trust PAC → Reps. Bresnahan, Harris (NC), Messmer, Taylor, Wied"), attribution the FEC data lacks. Interesting, not worth a pull of 1,600 pages a year.

## 6. Legal and terms of use

LD-203 reports are required by 2 U.S.C. § 1604(d) and must be made public over the Internet by the Secretary of the Senate and the Clerk of the House (§ 1605(a)(9), HLOGA § 209). They are not financial disclosure reports under 5 U.S.C. chapter 131, so the § 13107 restrictions on the holdings pages don't apply. The lda.gov [API terms](https://lda.gov/api/tos/) say the data "do not, and should not, include controls over its end use"; they ask that users cite the date accessed and state that "Senate Office of Public Records cannot vouch for the data or analyses derived from these data after the data have been retrieved from LDA.gov", not alter content and still cite LDA.gov, and not use the Senate seal. Rate limits: 15/min anonymous, 120/min with a key. The site already relies on the same API and terms for LD-1/LD-2 data.

## 7. Verdict: build the non-FECA items

What the numbers support:

- **Organization pages, "Honorary expenses and gifts to presidential committees."** For the ~190 matched registrants (more with aliases): total honorary and meeting spending since 2023, the top payees (which caucus foundation or charity), the members named, and separately any inaugural ($45.6M across 70 organizations on the site) and library gifts. This is the cleanest piece: no name matching needed for totals, payees and the presidential items; the filer is the organization itself. It pairs naturally with the existing lobbying block.
- **Member pages, "Events and causes honoring this member."** Full-name and unique-surname-with-title matches only, since January 3, 2025 like the travel section: 445 members, 871 items, $23.5M, median $6.7k. Each item: who paid, what it paid for (payee), amount, date, "named with N others" when the honoree list is long, the filer's comment, and a link to the filing (`filing_document_url`). The framing matters as it did for travel: the money went to a charity or foundation that honored the member, it is disclosed by the payer, and it is legal; the page should say so. Members with nothing get no section. Skip the 60 shared-surname items, or resolve by hand.
- **An index, `/honorary/` (small).** Totals by type and year, top payees (CBCF $17.2M, CHCI $14.9M, APAICS…), top filers, how much names a member vs a caucus vs the executive branch, and the inaugural and library lists. It's where the group-honoree items ($36.9M to "Members of the Congressional Black Caucus" and the like) belong, since they can't go on a member page. Optional but cheap once the data exists.
- **Don't build:** anything from FECA rows; a per-member total that adds the group items; automatic shared-surname matches.

**Refresh.** Reports are due July 30 (January–June) and January 30 (July–December); amendments arrive all year. A monthly job: pull `contribution_type` in he/me/ple/pic for the current and previous filing year (about 60 requests) plus `filing_type=MA`/`YA` posted since the last run, dedupe by filer-period, reclassify misfiled payees, collapse repeated rows, rebuild `data/ld203.json`. With a key this is a minute; without, about five. The weekly ingest's `.env` and `getJson` pacing already fit; add `page_size=25` and the 500 ms floor.

## Files (`.cache/ld203/`)
`api/{year}_{type}_p{n}.json` (one API page each), `api/count_*.json`, `api/counts.json`, `summary.json`, `analysis.md` (the full tables behind this note), `openapi.json`, `tos.html`, and the Senate and House download pages fetched while looking for a bulk file.

## Reproducing

```sh
tsx src/scripts/ld203/fetch.ts            # ~96 requests; 4.1 s apart without LDA_API_KEY, 250 ms with
tsx src/scripts/ld203/analyze.ts          # → .cache/ld203/analysis.md, summary.json
```
