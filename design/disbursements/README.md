# Campaign spending (FEC operating expenditures): is it worth adding to contributions.fyi?

Source: FEC bulk "Operating expenditures" files, `oppexp26.zip` (50 MB, 344 MB unzipped, 1.79M rows) and `oppexp24.zip` (64 MB, 430 MB, 2.25M rows), both rebuilt by the FEC on November 15, 2026; PAC summaries `webk26/24.zip` (0.5 MB); and the committee master, candidate–committee linkage, candidate summary and `pas2` files the ingest already uses. Data dictionary: [operating expenditures file description](https://www.fec.gov/campaign-finance-data/operating-expenditures-file-description/).
Scripts: `src/scripts/disbursements/` (`scan.py`, `amend.py`, `vendors.py`, `payees.py`; Python, ~10 s a pass). Cache: `.cache/disbursements/`.

**Shipped as** `/vendors/` (an index and a page per vendor at `/vendors/<slug>/`), a "Where the money goes" section on every member page, and a "Where its money goes" section on leadership PAC pages. The ingest is `src/ingest/disbursements.ts` (`pnpm ingest --steps=disbursements`), writing `data/disbursements.json`; vendor spellings that are one company are merged by `data/vendor-aliases.json`; buckets and name rules are in `src/lib/spending.ts`. A vendor gets a page once members' campaigns and leadership PACs paid it $250,000 or more from five or more committees over the three cycles.

## Short answer
**Yes, and it's cheap: the file is small, the members' slice is clean, and the vendors are the story.** Current members' campaign committees account for $1.10B of the 2026 file (430,833 itemized payments, 532 members) and their leadership PACs for another $106M. Ads and media are 31% of what campaigns spend in this cycle so far (45% in 2024), fundraising 19%, consultants 9%, staff 6%. A few hundred vendors carry most of it: the top 50 take 45% of the dollars and 367 vendors were paid $100k or more by five or more members' campaigns. Leadership PACs split about 41% contributions to other committees against 49% operating costs, and for the biggest one (John Kennedy's Common Sense for America, $14.0M) 94% is operating, nearly all of it direct mail fundraising. Three things need rules: memo entries (drop them for totals, use them for vendor names behind credit cards and payroll), a three-month processing lag for the current cycle, and two junk presidential filers that are 14% of the file's dollars. **Recommendation: build "Where the money goes" on member pages, a page per big vendor, and the contributions-vs-operating split on leadership PAC pages.**

## 1. Shape

| | 2026 (through Nov 15, 2026) | 2024 |
|---|---|---|
| Rows | 1,790,165 | 2,249,911 |
| Dollars, all rows | $6.27B | $10.26B |
| Dollars, memo rows (`MEMO_CD = X`) | $488M (459,955 rows) | $527M (696,235 rows) |
| Dollars, non-memo | $5.78B | $9.73B |
| Negative rows (voids, refunds) | 16,777, −$110M | 22,581, −$222M |
| Reports (committee × year × type) | 49,006 | 57,208 |
| Amended (`AMNDT_IND = A`) rows | 25% | 37% |

The file carries one line per itemized operating expenditure: Form 3 line 17 (House and Senate campaigns), Form 3X line 21B (PACs and parties) and Form 3P line 23 (presidential). It does **not** carry the other disbursement lines: transfers to affiliated committees, contributions to other committees, loan repayments or refunds. Those live in `pas2` (24K contributions, which the site already reads) and in the summary files. `CATEGORY` codes 008 (transfers), 010 (refunds) and 011 (political contributions) exist but together mark $3.7M of 2026, i.e. operating lines filers mislabeled; they can be ignored.

Non-memo dollars by filer type, 2026: House campaigns $1.32B, party committees $0.92B, Senate campaigns $0.86B, super PACs $0.58B, PACs $0.66B, leadership PACs $0.18B (all of them), two junk presidential filers $0.78B (below).

**Current members' slice (2026):**

| | Rows | Non-memo $ | Memo $ | Share of file's non-memo $ |
|---|---|---|---|---|
| 556 principal/authorized committees of 532 members (ccl, P and A, as `fec.ts` does) | 582,995 | $1,096.0M | $123.2M | 19.0% |
| 456 leadership PACs with a current-member sponsor (`committees.json`) | 62,392 | $106.4M | $11.6M | 1.8% |

2024: 519 members, $1,804M non-memo; leadership PACs $85.6M.

**How much of total disbursements this is.** Against `weball`'s total disbursements for the same members, itemized operating expenditures cover 80% in 2024 (median member 88%) but only 57% in 2026 (median 61%). The 2024 gap is the other disbursement lines plus unitemized payments under $200; the extra 2026 gap is the processing lag in §5. The member page should keep showing weball's total and present this as "where the itemized spending went".

## 2. Memo entries: the double-counting trap
`MEMO_CD = X` means "not included in the itemization total." In this file, 97% of memo dollars have a `BACK_REF_TRAN_ID`, which points at a non-memo parent in the same report: a credit card payment, a payroll run, a reimbursement. Including memo rows would overcount members' campaign spending by **$123M (11%)** in 2026 and $146M (8%) in 2024.

For members' rows: pass-through parents (purpose "credit card payment", "see memo", "payroll fee", American Express, Brex, Gusto, ADP, Paychex, Payroll Data Processing) are $115.7M in 2026, and $104.0M of them have memo children; $130.5M of memo children match a parent, $4.3M don't. The children carry the real payees. The biggest memo payees in the whole file are Meta/Facebook ($34M), American Airlines ($7.8M), United ($5.3M), Uber ($1.7M across 33,071 rows), Marriott, Google, Amazon, the Capitol Hill Club: ad buys and travel paid by card.

**Rule:** totals and category shares from non-memo rows only. For the vendor index, when a non-memo parent has memo children, show the children's payees instead of "American Express", capping the children at the parent's amount so the total can't move. The FEC's own note on the individual-contributions file says to include memo rows (earmarks); that advice is wrong for this file and the one place the two differ.

Processing fees (ActBlue Technical Services $17.7M, WinRed Technical Services $7.9M, Democracy Engine $3.1M, Anedot) are ordinary non-memo rows and are counted once.

## 3. Amendments and duplicates
The file is built from the FEC's processed data, where an amendment replaces the report it amends; this is not the "every version ever filed" situation of the 24/48-hour notices. Checked by looking for one committee's report type and year under more than one `FILE_NUM`:

| | 2026 | 2024 |
|---|---|---|
| Reports under more than one file number | 90 of 49,006 | 79 of 57,208 |
| Dollars in the older file numbers | $11.9M | $16.0M |
| …whose `TRAN_ID`s recur in the newest file (true duplicates) | $0.37M in 14 reports | $13.6M in 16 reports |

Most multi-file cases are two different reports with the same type code (two 30S post-special reports, say). The true duplicates are a few small committees' originals left next to their amendments. **Rule:** when a (committee, year, type) has several file numbers and the `TRAN_ID`s overlap, keep the highest `FILE_NUM`. That's cheaper than `fec.ts`'s receipts handling only because the file has already done most of the work. `SUB_ID` is unique across the file (0 duplicates).

## 4. Junk filers
Two committees that aren't in the 2026 committee master are $850M, 13.6% of the file: C00831388 "Jim A Norris for the United States President" ($776M in a handful of lines coded `CATEGORY 101`, purpose "OPERATION EXPERDITURE") and C00840389 ($74M of "candidate salary" to Joseph Luiz Gonzaga, plus $74M of memo rows). Neither touches a member, but any file-wide number, or a vendor page's "all committees" total, has to drop committees absent from `cm` or filing Form 3P with no real campaign. Dates also need clamping: `TRANSACTION_DT` runs from 1960 to 2056, with the 1st–99th percentile inside the cycle.

## 5. Freshness
`RPT_YR` and `RPT_TP` identify the report (Q1–Q3, YE, MY, 12P/12G pre-election, 30G post-general, M2–M12 for monthly filers, TER). The rows are coded by FEC staff before they appear, so the file lags e-filing by weeks to months, and the lag is worst in the stretch the site cares about most. On November 15, 2026 the 2026 file had the Q3 report (through September 30) for 257 of the members' campaign committees, the pre-general (through October 14) for 76, and nothing past the pre-primary for 319. The median committee's newest payment is dated **August 18, 2026**; 10% of committees stop at June 30. The 2024 file is complete (99th-percentile date December 19, 2024; 30G and YE reports in).

For receipts, `fec.ts` fills the same gap with the 24/48-hour notices. There is no notice equivalent for spending. The options are to label it ("itemized spending reported through <date>", per member, the way the race pages say what's processed) or to top it up from the FEC API's raw e-filing endpoint (`/schedules/schedule_b/efile/`, one request per committee per refresh, the DEMO_KEY budget already in `outside.ts`). Start with the label.

## 6. Vendors
`NAME` is free text: "AISLE 518" and "AISLE 518 STRATEGIES LLC", "DELTA AIRLINES" and "DELTA AIR LINES", "AMAZON" and "AMAZON.COM", "ARISTOTLE" and "ARISTOTLE INTERNATIONAL, INC". Normalizing case, punctuation, "THE", "DBA …" and legal suffixes (INC, LLC, CORP, CO, LP, LLP, PLLC, GROUP) takes members' 2026 payees from 27,941 raw names to 26,292. Among the top 500 by dollars, 24 pairs remain where one name is a prefix of the other, worth $44M (4% of members' spending); a hand alias list for the top few hundred is enough (the site already keeps `overrides` for PAC parents). Two look like one vendor but aren't: "WinRed" ($3.3M, earmark fees) and "WinRed Technical Services" ($7.9M, processing fees) are two companies, and "ActBlue" vs "ActBlue Technical Services" likewise.

**Size of the index (members' campaigns, 2026, non-memo):** 26,292 vendors; 151 paid $1M or more, 497 $250k+, 1,087 $100k+; 420 used by 10 or more campaigns, 137 by 25 or more; **367 vendors at $100k+ and 5+ campaigns**. Top 50 = 45% of dollars, top 500 = 77%. 2024: 33,229 vendors, 221 at $1M+, 443 at $100k+ and 5+ campaigns, top 500 = 80%.

Top 15 by dollars, 2026 (campaigns using them):

| $M | Campaigns | Vendor | Typical purpose |
|---|---|---|---|
| 41.3 | 194 | American Express | credit card payment (pass-through) |
| 31.6 | 38 | Targeted Victory | digital fundraising |
| 56.6 | up to 14 | Aisle 518 Strategies (two spellings, 3 and 11 campaigns) | media buy / digital ads |
| 26.9 | 112 | Gusto | payroll (pass-through) |
| 23.6 | 4 | Buying Time | media buy |
| 21.1 | 2 | Adelstein & Associates | television |
| 20.1 | 30 | Payroll Data Processing | payroll (pass-through) |
| 17.7 | 225 | ActBlue Technical Services | processing fees |
| 17.4 | 3 | MVAR Media | media buy |
| 13.9 | 223 | NGP VAN | software |
| 13.8 | 9 | SKDKnickerbocker | media buy |
| 11.5 | 8 | Strategic Media Placement | advertising |
| 10.5 | 7 | Middle Seat | list acquisition / digital |
| 10.1 | 6 | Screen Strategies Media | media |
| 9.8 | 27 | TAG LLC | digital media |

Most used, 2026: Democracy Engine (379 campaigns, merchant fees), ActBlue Technical Services (225), NGP VAN (223), American Airlines (211), American Express (194), USPS (191), WinRed Technical Services (179), Google (171), United Airlines (171), Anedot (156), Amalgamated Bank (156), Capitol Hill Club (154, food and beverage), Uber (145), Intuit (135), Amazon (132). Also in the top 50: Elias Law Group (80 campaigns, $3.1M), AIPAC as a venue and conduit (60 and 56), the Congressional Institute (79), Lansdowne Resort (52, "officially connected: caucus issues"), DCCC (56, transfers).

In 2024 the top of the list is the general-election media buyers: OnMessage $71M (14 campaigns), Screen Strategies $64M, SKDK $50M, Grassroots Media $42M (3 campaigns), AX Media $36M, Aisle 518 $35M, Buying Time $33M.

## 7. Categories and purposes
The `CATEGORY` code (001 administrative, 002 travel, 003 fundraising, 004 advertising, 005 polling, 006 materials, 007 events, 008–012 transfers/loans/refunds/contributions/donations) is optional and mostly unused: **blank on 74% of members' 2026 dollars** (79% in 2024). Where present, 001 dominates ($183M), then 004 ($43M) and 003 ($43M). It can't be the primary classification.

`PURPOSE` is free text but formulaic. A first-match regex over purpose, falling back on the payee name, classifies members' campaign spending as:

| Bucket | 2026 | 2024 |
|---|---|---|
| Advertising/media | 30.7% | 45.4% |
| Fundraising (consultants, direct mail, lists, texting) | 18.5% | 15.1% |
| Pass-through (credit card, payroll service; §2) | 9.5% | 6.7% |
| Consulting (strategy, general) | 9.1% | 6.7% |
| Payroll/staff | 6.2% | 5.6% |
| Processing and bank fees | 4.1% | 3.4% |
| Legal/compliance/accounting | 3.7% | 2.7% |
| Printing/mail/postage | 3.5% | 3.6% |
| Rent/office/tech | 3.5% | 2.4% |
| Polling/research | 2.2% | 2.0% |
| Events/food | 2.2% | 1.5% |
| Travel | 1.6% | 1.4% |
| Taxes, contributions, canvassing, refunds | 1.6% | 0.8% |
| Unclear | 3.3% | 2.5% |

Checked by eye on a 60-row random sample: 54 right, the misses being "caging" (a direct-mail term), "commissions", "teleconferencing fee" and in-kind lines. Resolving pass-throughs into their memo children would move most of that 9.5% into travel, ads and staff. The buckets and regexes are in `vendors.py`; the shipped version should be a table of (pattern → bucket) with the vendor fallbacks, and should show "Unclear" rather than guess.

## 8. Five members
Non-memo 2026 spending, top vendors (share) with the filed purpose:

- **John Thune**, $1.74M: American Express 20% (card), U.S. Treasury 17% (taxes), Rizzo Dukes Group 9% (fundraising consulting), Crosby Ottenhoff Group 8% (compliance), SDLS LLC 7% (political strategy), The Lukens Company 7% (printing/postage), Charles Schwab 5% (accounting), MDG Strategies, Pitney Bowes, Red Writer Consulting. An unopposed leader's campaign: overhead and fundraising, no ads.
- **Sarah McBride** (freshman, DE-AL), $2.28M: Middle Seat Consulting **47%** (digital advertising), ActBlue fees 7%, a staffer's salary 5%, American Express 5%, Heartland Payment Systems 5% (payroll), NGP VAN 4%, Kalik & Associates and JBW Consulting (fundraising), Global Strategy Group (research), Premier Political Compliance.
- **Steve Scalise**, $6.59M: Strategic Advance Services 28% (management consulting/ads), American Express 22%, Peaks and Valleys LLC 16% (political strategy), Targeted Victory 7%, The Political Firm 7%, Nungesser Consulting 3% (catering/event staging), Crosby Ottenhoff, Stewart Development (rent), HRBSN LLC, Public Opinion Strategies.
- **Ben Ray Luján** (random), $3.53M: Mothership Strategies 22% (list rental), Viewpoint Media 12% (digital buy), Payroll Data Processing 12%, Sage Media Planning 10% (TV), American Express 8%, NGP VAN 5%, Moore Campaigns (printing), Strathdee Group and Left Coast Consulting (fundraising), ActBlue fees.
- **Katie Britt** (random), $1.54M: Convergence Media 29% (media consulting/online ads), WinRed 12% (fees), Skye Global 8% (security consulting), Socko Strategies 6% (fundraising/catering), Newman and Associates (accounting), Sean Ross (strategic consulting), Lex Politica (legal), Cardinal Consulting Group, Three Arbor Insurance, EBW Development.

These read as sensible and recognizably different (a freshman spending half her money on one digital firm; a leader's campaign that's all overhead; a senator paying for security). Each is one line on the site: "Spent $2.3M so far this cycle; 47% to Middle Seat Consulting for digital advertising." The pass-through rows (card, payroll) should be resolved or labeled as such so "American Express" isn't anyone's top vendor.

## 9. Payments to the member, family, and other named payees
Feasibility, not claims:

- **`ENTITY_TP = CAN`** (payee is a candidate): 1,657 rows, $2.51M, 231 members in 2026 (2,394 rows, $3.17M, 253 members in 2024). Almost all are travel and expense reimbursements, which are legal and routine. The largest: Rick Scott $252k (in-kind air travel, his own plane), Jeff Hurd $159k (travel reimbursements), Kevin Hern $125k, John Rose $113k, Michael Baumgartner $95k ("see memos").
- **Payee surname = member's surname** (4+ letters, word match): 2,518 rows, $4.33M, 328 members. Top of the list after the self-reimbursements: Beth Van Duyne $159k (facility rental/catering/travel, to herself), Vince Fong $127k (a bank card labeled "Fong"), **Richard Neal $94k to Brendan Neal Strategies** (strategic consulting; a relative with the same surname is the kind of thing the match surfaces), Gwen Moore $91k (a Brenda Moore on salary), Tim Scott, Chuck Edwards, Madeleine Dean. Common surnames (Scott, Moore, Smith, Johnson) produce noise; a match is a lead, never a label. If shown at all, show "payments to the candidate" (ENTITY_TP CAN, with the purposes) as a plain fact and leave surname matching as a research-only flag.
- **Individual payees in general** (`ENTITY_TP = IND`): 33,227 rows, $54.1M (4.9%) in 2026, mostly staff salaries and stipends by name. Legal to publish (the FEC does), but there is no public-interest reason to put a field organizer's pay on a page by name. Roll individuals up as "staff and individuals" except the candidate.
- **Venues as a sanity check for a vendor index.** Payments to Trump properties (Mar-a-Lago, Doral, Bedminster, Trump National/International) across every committee: 2026, 144 rows, **$2.63M**, of which $2.01M from party committees and $126k from current members' campaigns (the largest a $73k "fundraising event fees" line at Mar-a-Lago) plus $3k from leadership PACs; 2024, about $2.1M in venue payments plus $14.4M of lines whose payee is Trump's own campaign or JFCs (refunds, transfers), which a venue page must exclude by matching committee ids, not names. This is exactly the kind of page a vendor index makes a one-liner.

## 10. Leadership PAC spending
Operating expenditures (this file) against the PAC's summary (`webk`: total disbursements, contributions to other committees, independent expenditures, transfers), for the 449 leadership PACs with a current-member sponsor and a 2026 summary row:

| | 2026 (through Oct 14 for monthly filers) | 2024 |
|---|---|---|
| Total disbursements | $218.5M | $180.3M |
| Contributions to other committees | $89.5M (**41%**) | $81.4M (45%) |
| Itemized operating expenditures (this file, non-memo) | $106.4M (**49%**) | $85.6M (48%) |
| Of operating: fundraising | 39% | 37% |
| Of operating: consulting | 14% | 16% |
| Of operating: pass-through (card, payroll) | 10% | 13% |
| Of operating: legal/compliance, events, travel, ads | 8%, 4%, 4%, 6% | 8%, 4%, 4%, 4% |

`pas2` 24K sums (which the site already has per leadership PAC, for current-member recipients) run below `webk`'s contributions figure because they stop at the last processed report and exclude non-member recipients; use `webk` for the split and `pas2` for who got it.

Top 20 by 2026 disbursements:

| PAC | Sponsor | $M | To other committees | Operating | Biggest operating bucket |
|---|---|---|---|---|---|
| Common Sense for America | John Kennedy | 14.0 | 2% | 94% | fundraising (MDI Imaging & Mail, Fulfillment Solutions, HSP Direct: direct mail) |
| PAC to the Future | Nancy Pelosi | 8.1 | 15% | 71% | consulting (Sutro Creatives $2.9M) |
| AmeriPAC | Steny Hoyer | 8.0 | 22% | 63% | fundraising (Mothership Strategies) |
| Medicare for All | Pramila Jayapal | 6.4 | 6% | 56% | consulting (Mothership Strategies) |
| Commander Zinke Leadership Fund | Ryan Zinke | 4.4 | 12% | 66% | ads (Targeted Victory) |
| Heartland Values PAC | John Thune | 3.1 | 16% | 80% | card pass-through |
| Fair Shot PAC | Katherine Clark | 3.1 | 73% | 22% | fundraising |
| Hellfire PAC | Wesley Hunt | 3.0 | 3% | 78% | ads (WinRed) |
| Electing Majority Making Effective Republicans | Tom Emmer | 2.6 | 73% | 17% | fundraising (814 Consulting) |
| Mr. Southern Missourian in the House | Jason Smith | 2.2 | 53% | 44% | fundraising |
| Jobs, Education & Families First | Hakeem Jeffries | 2.2 | 71% | 20% | fundraising |
| Alabama First PAC | Katie Britt | 2.1 | 28% | 67% | fundraising (Socko Strategies) |
| Mitten PAC | Elissa Slotkin | 2.0 | 31% | 49% | fundraising |
| Eye of the Tiger PAC | Steve Scalise | 2.0 | 86% | 13% | fundraising |
| Common Ground PAC | Tim Kaine | 1.9 | 37% | 46% | fundraising |
| Liftoff PAC | Mark Kelly | 1.8 | 52% | 42% | fundraising |
| American Mobilization PAC | Chris Murphy | 1.8 | 33% | 17% | consulting |
| Elect Every Democrat PAC | Lois Frankel | 1.8 | 9% | 61% | fundraising (Mothership Strategies) |
| Jobs, Freedom and Security PAC | Ted Cruz | 1.7 | 20% | 56% | travel (Evojets) |
| In the Arena PAC | French Hill | 1.7 | 83% | 13% | fundraising |

The spread (2% to 86% to other committees) is the story the PAC page can tell with one bar; the site today shows only what each leadership PAC gave to members. Where contributions + operating don't reach 100%, the rest is unitemized spending, refunds, and independent expenditures (none in the top 20).

## 11. Legal and use
FEC reports are public records. The sale-and-use restriction, 52 U.S.C. § 30111(a)(4), says information copied from reports "may not be sold or used by any person for the purpose of soliciting contributions or for commercial purposes" except to solicit a political committee; the FEC reads it as protecting **contributor** information. Payees aren't contributors, so vendor and venue pages raise nothing the site's donor pages don't already handle, and the data goes in the public repo like `fec` lines do. The one judgment call is individuals paid by campaigns (staff, §9); that's taste, not law. No § 13107 issue: these aren't financial disclosures.

## 12. Verdict: build it
Sized by the numbers above:

- **Member pages, "Where the money goes"** (532 members with 2026 rows; 2024 and 2022 too, `oppexp22.zip` exists): total itemized operating spending for the cycle next to the existing receipts and disbursements totals; a bar of purpose buckets (ads, fundraising, consultants, staff, fees, other); the top 8–10 vendors with filed purpose and share, pass-throughs resolved to their memo children; "reported through <date>" from the committee's newest processed report. Payments to the candidate (ENTITY_TP CAN) as one line with the purposes, no surname matching.
- **Vendor pages, `/vendors/<slug>/`**: for vendors paid $100k+ by 5+ members' campaigns or leadership PACs (367 in 2026, ~450 in 2024; a few hundred after aliasing across cycles), each listing which members paid them, how much, for what, by party, with the committee-id guard against candidate committees that match a name. Everything else stays a name in a member's table. A `/vendors/` index by dollars and by number of campaigns; a vendors result type in search. Pages for Mar-a-Lago, Elias Law Group, Targeted Victory, Middle Seat and the Capitol Hill Club fall out of the same template.
- **Leadership PAC pages**: the contributions / operating / other split from `webk`, with the operating side's buckets and top vendors.
- **Fairness**: say "reported by the campaign", keep the bucket names plain ("fundraising", not "overhead"), and never label a vendor by who else uses it; show the party split as a baseline.

**Don't build:** family-payment claims from surname matching; a per-payment feed (the fec lines schema in the MCP server can take the rows as a `disbursement` kind instead); 24/48-hour-style gap filling until the label proves insufficient.

**Pipeline cost.** Per cycle, one 50–65 MB zip (the ingest's `fecBulk` already handles this, next to `indiv` at 2.6–4.2 GB) plus the 0.5 MB `webk`; one streaming pass in `rows()` style, under 15 s in Python and about the same in Node; output roughly 2 MB of JSON (per member per cycle: buckets, top 10 vendors, through-date; per vendor: per-member totals) and a few hundred vendor pages. The `cm`, `ccl`, `weball` and `pas2` reads already exist in `fec.ts`.

## Files (`.cache/disbursements/`)
`oppexp26.zip`, `oppexp24.zip`, `oppexp_header_file.csv`, `webk26.zip`, `webk24.zip`; copies of `cm`, `ccl`, `cn`, `weball`, `pas2` for 2024 and 2026 from the shared FEC cache; `stats{26,24}.json` (scan), `member_rows{26,24}.tsv` (members' rows, 645k/760k), `amend{26,24}.json`, `vendors{26,24}.json` and `.txt`, `payees{26,24}.json`.

## Reproducing
```sh
# One request at a time, user agent "contributions.fyi research (https://contributions.fyi)":
# https://www.fec.gov/files/bulk-downloads/2026/oppexp26.zip (50 MB), .../2024/oppexp24.zip (64 MB),
# .../2026/webk26.zip, .../2024/webk24.zip, .../data_dictionaries/oppexp_header_file.csv → .cache/disbursements/
# plus cm/ccl/cn/weball/pas2 zips for both cycles (copied from .cache/fec/<cycle>/).
python3 src/scripts/disbursements/scan.py 2026 2024      # shape, memo, committee kinds, members' rows
python3 src/scripts/disbursements/amend.py 2026 2024     # original-plus-amendment duplicates
python3 src/scripts/disbursements/vendors.py 2026 2024   # vendors, buckets, samples, surnames, leadership PACs
python3 src/scripts/disbursements/payees.py 2026 2024    # Trump venues, memo chains
```
