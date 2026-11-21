# Federal contracts, grants and loans (USAspending.gov): is it worth adding to contributions.fyi?

Source: the [USAspending.gov API](https://api.usaspending.gov/docs/endpoints) (Treasury, free, no key), read
on November 21, 2026, about 680 requests at one a second. Scope of analysis: a sample of the organizations
with pages here, the top 200 by contribution total (committees of parties and candidates left out) plus the
top 100 by lobbying spend, 247 after deduplication, matched to USAspending recipients, with their FY2024 and
FY2025 obligations by award type. Scripts: `src/scripts/usaspending/` (common.ts, match.ts, totals.ts,
totals2.ts, report.ts, report2.ts). Cache: `.cache/usaspending/`. `data/organizations.json` has **6,929
organizations** (2,013 with a lobbying client, 1,636 with lobbying spend, 594 with an SEC match).

## Short answer
**Yes, as one block on organization pages, for the companies, and only after a hand review of who the
parent is.** The sample's organizations were obligated **$190B to $255B in FY2025** depending on how a
company's subsidiaries are rolled up (that spread is the main finding, see §3), 99% of it contracts and
69% of it to ten defense and health contractors. Public companies match well (79 of 90 found, 40 with
over $1M in FY2025); trade associations and unions match by name about half the time but get almost
nothing (6 of 157 non-public organizations have over $1M, and those are the Big Four, Exxon and Takeda);
universities and hospital systems, which take most grant money, have no PACs and so aren't on the site.
The data is public domain, two or three requests per organization give fiscal-year totals by award type
with the top agencies, and a full build is an evening of polite requests. **Recommendation: build
"Federal contracts and grants" on organization pages (the two most recent complete fiscal years by type,
top agencies, a link to the recipient profile), described as *alongside* contributions and lobbying, with
`data/usaspending-overrides.json` listing the parent records for every organization over $100M. No sector
rollups yet: each sector's figure is one to three companies.**

## 1. Shape of the source
USAspending publishes every federal award since FY2008 (searches) or FY2001 (downloads): **prime awards**
(contracts, IDVs, grants, loans, direct payments, insurance, other assistance) at transaction level, as
agencies report them to FPDS (contracts) and FABS (financial assistance). "Recipients" are SAM entities,
keyed by UEI (DUNS until 2022), in three levels:

| Level | Meaning | Example |
|---|---|---|
| `P` parent | an entity named as the ultimate parent on transactions; its totals **roll up the children** | LOCKHEED MARTIN CORP, UEI ZFN2JJXBLZT3, 217 children in FY2025 |
| `C` child | an entity with a parent | LOCKHEED MARTIN CORPORATION (TX), SIKORSKY AIRCRAFT CORPORATION |
| `R` recipient | an entity with no parent and no children | AFSCME COUNCIL 66, most unions and small nonprofits |

The same entity can be `P`, `C` and `R` at once (American Hospital Association is its own parent). A
recipient id is a hash of the entity's identifier *and name*, so one company has one record per
(UEI, spelling) pair it has ever registered: the sample's 160 matched organizations have **434 same-name
P/R records** (PricewaterhouseCoopers 11, Honeywell 11, L3Harris 11, General Electric 12, General Motors 15).

Endpoints that matter, all measured here:

| Endpoint | Gives | Used for |
|---|---|---|
| `POST /recipient/` `{keyword, sort: amount}` | recipients whose name, UEI or DUNS contains the keyword, with level and **trailing-12-month** amount | finding the records (up to 50 a page) |
| `GET /recipient/duns/<id>/?year=2025` | profile: alternate names, `parents[]`, location, business types, FY total and transaction count | the link target; which parents a child has had |
| `GET /recipient/children/<duns>/?year=2025` | the children under a parent **DUNS** with that FY's amount (`400` for a P whose DUNS "is not listed as a parent"; by UEI it returns a different, smaller set) | the cross-check in §3 |
| `POST /search/spending_over_time/` `{group: fiscal_year, filters: {recipient_id}}` | per FY: `Contract_`, `Idv_`, `Grant_`, `Loan_`, `Direct_`, `Other_Obligations` | **one request per record gives both years by type** |
| `POST /search/spending_by_category/awarding_agency/` `{filters: {recipient_id, time_period}}` | top agencies by obligation | the "from" line |
| `POST /autocomplete/recipient/` | names only (`recipient_level`, `uei`, `duns` come back null) | not useful; use `/recipient/` |
| `POST /search/spending_by_award/` | award rows with lifetime "Award Amount" and "Total Outlays" | not for totals (see traps) |

The whole database is also offered as a PostgreSQL dump at `files.usaspending.gov/database_download/`:
**177 GB zipped** (`Content-Length` 177,307,886,000). Not downloaded. It is the only way to total by the
parent identifier on each transaction rather than by recipient record (§3), so it's the fallback if the
record-sum approach proves too fiddly.

Searches reach back to 2007-10-01 (Lockheed's FY2008 total is $35.7B; `year=2001` returns 0). Award data
was last updated 11/21/2026 (`/awards/last_updated/`), and the agency-accounts side reveals a month about
seven weeks after it ends (`/references/submission_periods/`: September 2026 revealed 2026-11-17).

## 2. Matching the site's organizations
Method (`match.ts`): for each organization, `POST /recipient/` with the first six words of
`normalizeOrg(name)` as the keyword (then the LDA client name, the SEC name and a parenthesized acronym
if the site's name finds nothing), keep rows where `sameOrg()` accepts the recipient's name against any of
those names, prefer `P` over `R` over `C`, and when only a child matches, fetch its profile and take the
parent. No hand corrections were made for the numbers below.

Organizations in the sample: 247 (200 from the top 200 by contributions, 100 from the top 100 by lobbying
spend, 53 in both; $530M of contributions and $5.7B of lobbying spend between them). Matched to a
recipient: **160 (65%)**: 123 parents, 37 standalone, 1 reached through a child. With any FY2025
obligations: 60; at least $1M: 46 (51 once same-name records are summed); at least $100M: 28 (33).

| Sector | In sample | Matched | With FY2025 awards ≥ $1M | FY2025 obligations (one record each) |
|---|---|---|---|---|
| Finance, Insurance & Real Estate | 59 | 41 (69%) | 7 | $29.7B |
| Health | 38 | 28 (74%) | 9 | $4.2B |
| Labor | 31 | 11 (35%) | 0 | $0 |
| Communications & Technology | 24 | 15 (63%) | 5 | $19.7B |
| Energy & Natural Resources | 24 | 17 (71%) | 8 | $2.0B |
| Agribusiness | 16 | 11 (69%) | 0 | $0 |
| Ideological & Single-Issue | 15 | 3 (20%) | 0 | $26K |
| Transportation | 14 | 11 (79%) | 5 | $1.5B |
| Defense | 11 | 11 (100%) | 10 | $131.8B |
| Misc Business | 10 | 8 (80%) | 2 | $467M |
| Construction | 4 | 3 (75%) | 0 | $0 |
| Lawyers & Lobbyists | 1 | 1 (100%) | 0 | $0 |
| **All** | **247** | **160 (65%)** | **46** | **$189.5B** |

By kind of organization: of the **90 public companies** (an `sec` record), 79 matched and 40 have over
$1M; of the **157 others** (trade groups, unions, private companies, ideological PACs), 81 matched and 6
have over $1M (Deloitte, PwC, Exxon, Takeda, the American Medical Association with $4.2M, 95% grants, and
the American Hospital Association with $1.2M).

Hard cases (the full lists are in `report.ts`'s output):

- **Trade associations that get no money.** 0 search rows for PhRMA, CTIA, Edison Electric Institute,
  NADA, the National Beer Wholesalers, America's Credit Unions, NCTA, the American Council of Life
  Insurers and most of the rest: they are not in SAM. The ones that are (NAR, ABA, NRF, ICBA, NAB $744K,
  American Chemistry Council $585K) get conference-sized contracts or a research grant. Correct, and
  nothing to show.
- **Unions.** AFSCME, SEIU, LIUNA, the Carpenters, IBEW, AFT, NEA, UFCW exist in SAM only as locals and
  state councils ("AFSCME COUNCIL 66", "INTERNATIONAL BROTHERHOOD OF ELECTRICAL WORKERS 194", "AMERICAN
  FEDERATION OF TEACHERS #2275"). `sameOrg` accepted four of those locals as the international (a 0.8
  token overlap), and "American Council of Engineering Companies" as its Illinois chapter. All had $0, so
  harmless, but a rule is needed: reject a recipient name that adds a number, "LOCAL", "COUNCIL", a state
  or a city to the organization's name. The Teamsters ($3.4M, DOL grants), the Fire Fighters' foundation
  ($1.5M) and the Amalgamated Transit Union ($8.0M in FY2024, a DOT training grant) are the real union
  recipients.
- **Universities and hospital systems.** Essentially absent from `organizations.json` (Northwestern
  University is there with a small PAC; USAspending gives it $468M in FY2025, 94% grants). The "Health"
  organizations here are specialty societies and insurers. A grants story would need a different list.
- **Short and punctuated names.** AT&T (keyword "AT AND T" found a sedan service; the recipient is "AT&T
  INC"), T-Mobile ("T MOBILE USA INCORPORATED (9335)"), Visa ("ONG VISA"), CME Group, CSX, Southern
  Company ("SOUTHERN CO SERVICES INC"), Bristol-Myers Squibb (only the Gilead joint venture came back for
  the unhyphenated keyword), Coca-Cola, Biogen ("BIOGEN U.S. CORPORATION"), Novartis ("NOVARTIS
  PHARMACEUTICALS CORPORATION"), iHeartMedia, Williams. Eleven public companies missed, all because the
  keyword or `nameSimilarity` on a one- or two-token name is too strict (`{NOVARTIS}` vs `{NOVARTIS,
  PHARMACEUTICALS}` scores 0.5). Fix: search the raw name too, and for names of one or two tokens accept a
  recipient whose first tokens equal them and whose profile's `alternate_names` or `business_types` match.
- **Name collisions.** "Investment Company Institute" → "THE INVESTMENT INSTITUTE, LLC"; "American Revival
  PAC" → "AMERICAN REVIVAL LLC"; "Johnson & Johnson Inc" → "JOHNSON AND JOHNSON LTD", a junk `R` record,
  while the real money is under "JOHNSON & JOHNSON HEALTH CARE SYSTEMS INC." ($39M trailing), which
  `sameOrg` rejects; "Walmart Inc" → "WALMART", a dead registration (Walmart has no real prime awards);
  "Delta Airlines" → "DELTA AIRLINES" (the recipient is "DELTA AIR LINES INC"). Zero-dollar matches
  hide the problem, so the review file should record "checked, nothing" rather than leave them to chance.
- **Subsidiaries that are their own parent.** Humana shows $3.2B in FY2024 and $0 in FY2025 because the
  TRICARE contract's recipient, HUMANA GOVERNMENT BUSINESS INC, is listed as its own ultimate parent.
  Honeywell's Kansas City plant (HONEYWELL FEDERAL MANUFACTURING & TECHNOLOGIES, $2.6B as a child one
  year, $0.7B as a parent another) and Sandia (Lockheed's until 2017) are the same pattern. A parent
  rollup misses them unless the review file adds them by hand.
- **Parents that aren't the site's organization.** "Amalgamated Sugar Company LLC" → SNAKE RIVER SUGAR
  COMPANY (its cooperative parent, correct); "Shell USA" → SHELL PLC; "Leidos Inc" → LEIDOS HOLDINGS;
  "Cigna Corp" → CIGNA HOLDING CO; "Amazon.com Services LLC" → "AMAZON COM INC" `R` with $0 (Amazon Web
  Services is a separate parent). Each needs a human to say which parent the page means.

## 3. What the matched organizations get, and the rollup problem
Three ways to total a company's fiscal year disagree:

1. **One record** (`totals.json`): `spending_over_time` filtered by the single best-matching recipient id.
2. **All same-name records** (`totals2.json`): the same, summed over every `P` and `R` record whose name
   `sameOrg` accepts (records are disjoint sets of transactions, so the sum doesn't double count).
3. **Children by DUNS**: `/recipient/children/<parent DUNS>/?year=FY` summed, for each distinct parent DUNS
   among those records. This follows the DUNS on each transaction regardless of the parent's name or UEI
   at the time.

Sample FY2025 totals: **$189.5B / $218.8B / $230.3B**, and $255.1B taking the larger of 2 and 3 per
organization. 85 of 160 organizations have more than one same-name record; **31 differ by more than 10%
between methods 2 and 3 in a year with at least $1M**. Neither method is a superset of the other:

| # | Organization | FY2025: one record | all same-name records | children by DUNS | FY2024: one record | all records | children | Records (P/R) |
|---|---|---|---|---|---|---|---|---|
| 1 | Lockheed Martin Corp | $66.4B | $74.9B | $74.9B | $33.5B | $39.0B | $39.0B | 13 |
| 2 | RTX Corporation and Affiliates | $13.7M | $18.2M | $36.1B | $1.3B | $1.3B | $25.3B | 2 |
| 3 | UnitedHealth Group Inc | $25.2B | $25.2B | $25.2B | $18.5B | $18.5B | $18.5B | 2 |
| 4 | Boeing | $23.5B | $23.6B | $23.6B | $21.6B | $22.2B | $22.2B | 3 |
| 5 | General Dynamics Corporation | $3.1B | $12.8B | $3.1B | $3.6B | $15.4B | $3.6B | 2 |
| 6 | Leidos Inc | $10.7B | $12.2B | $12.2B | $11.0B | $11.7B | $11.7B | 8 |
| 7 | Northrop Grumman Corp | $11.3B | $11.3B | $11.3B | $13.8B | $13.8B | $13.8B | 1 |
| 8 | Huntington Ingalls Industries | $11.2B | $11.2B | $11.2B | $6.3B | $6.3B | $6.3B | 1 |
| 9 | BAE Systems | $3.9B | $10.5B | $6.5B | $0 | $10.9B | $7.9B | 3 |
| 10 | L3Harris Technologies | $8.7B | $9.2B | $9.2B | $9.0B | $10.6B | $9.1B | 11 |
| 11 | General Electric Company | $4.1B | $4.1B | $203M | $3.1B | $3.1B | $138M | 12 |
| 12 | Space Exploration Technologies | $3.8B | $3.8B | $3.8B | $3.8B | $3.8B | $3.8B | 2 |
| 13 | Deloitte LLP | $3.7B | $3.7B | $3.7B | $3.5B | $3.5B | $3.5B | 2 |
| 14 | Textron | $3.6B | $3.6B | $3.6B | $2.9B | $2.9B | $2.9B | 3 |
| 15 | Merck | $2.9B | $2.9B | $0 | $2.2B | $2.9B | $691M | 2 |
| 16 | Valero Energy | $563M | $1.2B | $617M | $0 | $1.1B | $1.1B | 4 |
| 17 | Palantir Technologies | $1.1B | $1.1B | $1.1B | $585M | $585M | $585M | 1 |
| 18 | FedEx | $971M | $971M | $971M | $1.5B | $1.5B | $1.5B | 3 |
| 19 | General Motors | $302M | $803M | $303M | $279M | $319M | $280M | 15 |
| 20 | Pfizer | $700M | $700M | $700M | $1.3B | $1.3B | $1.3B | 1 |
| 21 | Phillips 66 | $531M | $640M | $531M | $0 | $443M | $0 | 3 |
| 22 | Cigna | $563M | $563M | $0 | $264M | $264M | $0 | 3 |
| 23 | Marathon Petroleum | $542M | $542M | $0 | $287M | $287M | $0 | 1 |
| 24 | DaVita | $536M | $536M | $536M | $1.4M | $1.4M | $1.4M | 4 |
| 25 | Microsoft | $54K | $534M | $2.7M | $2K | $518M | $2K | 5 |
| 26 | Caterpillar | $456M | $456M | $0 | $399M | $400M | $1.2M | 2 |
| 27 | Exxon Mobil | $15.5M | $347M | $0 | $60.2M | $168M | $108M | 5 |
| 28 | USAA | $0 | $272M | $0 | $0 | $32.5M | $0 | 3 |
| 29 | Elevance Health | $261M | $261M | $261M | $186M | $186M | $186M | 1 |
| 30 | Honeywell International | $1.9M | $91.8M | $258M | $0 | $1.5B | $3.8B | 11 |

What's going on, from the profiles:

- **RTX.** The record named "RTX CORPORATION" (UEI PPLZG8J3N9D4) has $1.3B in FY2024, $14M in FY2025 and
  $38.6B in FY2026. The children endpoint for its DUNS 001344142 finds 133 children and $36.1B in FY2025,
  led by RAYTHEON COMPANY ($12.1B) and an "RTX CORPORATION" child ($7.3B). The Raytheon child's profile
  lists three parents over time: RTX CORPORATION, RAYTHEON COMPANY (its own DUNS, as parent) and, oddly,
  ROCKWELL COLLINS AUSTRALIA. FY2025's transactions name a parent whose (identifier, name) hash is none
  of the "RTX CORPORATION" records the search returns, and "RAYTHEON TECHNOLOGIES" returns no records at
  all. The DUNS-keyed children endpoint is the only API path that sees that year.
- **Honeywell.** Eleven "HONEYWELL INTERNATIONAL INC" parents with different UEIs; the one with the
  largest trailing-12-month amount ($3.7B) has $0 in FY2024 and $1.9M in FY2025. FY2024's $1.4B sits under
  UEI YBVGQEYENNM6, and the children endpoint finds $3.8B that year. The company's SAM registration moved.
- **General Electric, Merck, Caterpillar, Marathon, Cigna, Microsoft.** The opposite: the hash-based
  records hold the money and the children-by-DUNS endpoint returns little or nothing, because those
  companies' parent DUNS on recent transactions isn't the DUNS on the P record (post-2022 UEI-only
  registrations), or because the P record's DUNS "is not listed as a parent" (five of them: 049944143,
  001338912, 001213214, 009076738, 967697686).
- **General Dynamics.** Two P records: VF58HFRNGEL8 ($3.1B) and FAZSFFE6CST9 ($9.7B). The matcher took
  the one with the larger trailing amount. Summing both is right ($12.8B; GD's FY2025 federal revenue was
  about that).
- **Lockheed.** Thirteen P records; the one picked had $66.4B, all of them $74.9B, and children by DUNS
  agree. The matcher's choice of a single "best" record undercounts even the cleanest case by 11%.

So the API can't give a certified total for a company, because a company isn't one recipient. What it can
give, reliably enough to publish with the right wording, is **the sum of every parent and standalone
record carrying the company's name**, cross-checked against children-by-DUNS, with a human adding the
sub-parents that carry a different name (RAYTHEON COMPANY under RTX, HUMANA GOVERNMENT BUSINESS under
Humana, HONEYWELL FEDERAL MANUFACTURING under Honeywell) to an overrides file. The page should say "at
least", name the records, and link them.

Award types (sum of same-name records, FY2025): **$218.8B total, 99.9% contracts and IDVs**. Grants:
$105M across the whole sample (NextEra $48.7M, Boeing $34.7M, Lockheed $12.5M, the AMA $4.0M). Loans: one
entry, JPMorgan Chase, −$6.1M (a de-obligation). Direct payments: −$214M net (UnitedHealth, −1% of its
total). Nine organizations have a negative year (Gilead −$9.5M, JPMorgan −$4.9M, AbbVie −$2.1M in FY2025).

Top awarding agencies, FY2025, one-record basis:

| Organization | Agencies (share of its FY2025 obligations) |
|---|---|
| Lockheed Martin | Defense 98%, NASA 2% |
| UnitedHealth Group | Veterans Affairs 100% (community care network) |
| Boeing | Defense 93%, NASA 7% |
| Northrop Grumman | Defense 91%, NASA 8% |
| Huntington Ingalls | Defense 92%, GSA 8%, Energy 2% |
| Leidos | Defense 40%, Veterans Affairs 26%, Energy 7%, Transportation 7%, HHS 6% |
| L3Harris | Defense 80%, Transportation 14% (FAA), NASA 4% |
| General Electric | Defense 97%, NASA 2% |
| BAE Systems | Defense 98% |
| SpaceX | NASA 56%, Defense 43% |

Alongside the site's numbers (one-record basis; the sum-of-records column is in the table above):

| Organization | Sector | Contributions 2022–26 | Lobbying 2021–26 | Federal obligations FY2025 | FY2024 |
|---|---|---|---|---|---|
| Lockheed Martin | Defense | $3.8M | $82.5M | $66.4B | $33.5B |
| UnitedHealth Group | Finance, Insurance & Real Estate | $2.2M | $43.8M | $25.2B | $18.5B |
| Boeing | Defense | $3.9M | $72.0M | $23.5B | $21.6B |
| Northrop Grumman | Defense | $3.2M | $53.5M | $11.3B | $13.8B |
| Huntington Ingalls | Defense | $1.3M | $28.5M | $11.2B | $6.3B |
| Leidos | Communications & Technology | $1.9M | $19.8M | $10.7B | $11.0B |
| L3Harris | Defense | $2.4M | $16.0M | $8.7B | $9.0B |
| General Electric | Communications & Technology | $984K | $21.6M | $4.1B | $3.1B |
| BAE Systems | Defense | $1.8M | $23.3M | $3.9B | $0 |
| SpaceX | Communications & Technology | $2.6M | $16.1M | $3.8B | $3.8B |
| Deloitte | Finance, Insurance & Real Estate | $3.8M | $9.7M | $3.7B | $3.5B |
| Textron | Defense | $1.2M | $29.2M | $3.6B | $2.9B |
| General Dynamics | Defense | $3.4M | $70.5M | $3.1B | $3.6B |
| Merck | Health | $1.2M | $55.3M | $2.9B | $2.2B |
| Palantir | Communications & Technology | $75K | $28.0M | $1.1B | $585M |
| FedEx | Transportation | $1.9M | $63.6M | $971M | $1.5B |
| Pfizer | Health | $1.8M | $67.2M | $700M | $1.3B |
| Valero Energy | Energy & Natural Resources | $1.6M | $10.5M | $563M | $0 |
| Cigna | Finance, Insurance & Real Estate | $2.2M | $5.9M | $563M | $264M |
| Marathon Petroleum | Energy & Natural Resources | $1.6M | $15.1M | $542M | $287M |
| DaVita | Health | $1.6M | $23.6M | $536M | $1.4M |
| Phillips 66 | Energy & Natural Resources | $1.8M | $28.8M | $531M | $0 |
| Caterpillar | Misc Business | $2.1M | $24.6M | $456M | $399M |
| General Motors | Transportation | $2.3M | $80.5M | $302M | $279M |
| Elevance Health | Finance, Insurance & Real Estate | $3.0M | $39.8M | $261M | $186M |

The columns sit next to each other to show what a section would look like beside the numbers already on
an organization page. Describe them as *alongside*: a company's federal awards are a fact about the
company, like its lobbying spend, not an outcome of its contributions, and the page shouldn't say or
imply otherwise. The FY2024 → FY2025 jumps (Lockheed doubling, BAE and Valero from $0) are mostly the
record-splitting above and multi-year contract awards landing in one year, not news.

## 4. Traps
- **A company is many recipients.** See §3. Never total from a single recipient id; sum every same-name
  P/R record, cross-check children-by-DUNS, hand-add differently named sub-parents, and write "at least".
- **Obligations, not outlays, and say so.** The search endpoints return obligations (money the government
  committed to the award in that fiscal year, including modifications and de-obligations, which can make
  a year negative). Outlays (money actually paid) come back `null` at the transaction level and `0` at the
  award level for a parent filter; they exist only per award in `spending_by_award` ("Total Outlays"), as
  the cumulative amount paid over the award's life, which can't be split by fiscal year. Show obligations
  and call them "obligated", not "received" or "paid": "The federal government obligated at least
  **$74.9B** in contracts to Lockheed Martin and its subsidiaries in fiscal 2025 (Oct 2024–Sep 2025)."
- **Fiscal years, not calendar years or election cycles.** FY2025 is Oct 1, 2024 to Sep 30, 2025. Keep
  the label on the page; don't line it up with "2024 cycle" totals.
- **Lag.** FY2026 ended Sep 30, 2026, but on Nov 21 Lockheed's October and November 2026 contracts show
  $0.03B and $0.06B against $5–13B in earlier months: the Department of Defense releases its contract
  actions about 90 days late, and other agencies have up to three business days (FPDS) or 30 days (FABS)
  to report. So the latest *complete* fiscal year is the one that ended at least four months ago; show
  the two most recent complete years and refresh monthly.
- **Prime awards only.** Recipient totals never include sub-awards (`recipient_id` is "not supported for
  subaward queries"), so a company whose federal work is all as a subcontractor shows nothing, and a prime
  contractor's total includes what it passed to subcontractors. Drug and device makers (Eli Lilly $0,
  Medtronic $0, J&J) sell to the government through distributors and show nothing.
- **IDV obligations** (indefinite-delivery vehicles) are a separate bucket from contracts in the response;
  they're contract money (Lockheed: $0.66B of $66.4B in FY2025). Add them to "contracts".
- **Don't total awards from `spending_by_award` with a parent `recipient_id`.** Filtered by Lockheed's
  parent id, the top rows were Humana Government Business's TRICARE contract ($51.3B lifetime; its parent
  is Humana) and Sandia's M&O contract (a Lockheed subsidiary until 2017). Award-level filtering by parent
  is wrong or stale there, and "Award Amount" is the award's lifetime value.
- **Trailing-12-month `amount`** in the recipient search is not a fiscal year, and sorting by it picks
  the company's *current* registration, which is often the one with the least history. It is sort order
  only.
- **Government-owned, contractor-operated sites** inflate some companies: national-lab operators and
  shipyards get obligations in the tens of billions that are mostly pass-through operating budgets.
  Nothing to fix, but the dek should not call it revenue or profit.
- **Universities and hospitals** take most federal grant money, and the site has almost none of them.
  A grants story would need a different organization list.
- **Loans** are face value, not subsidy cost, and absent from this sample; keep the bucket but expect it
  empty except for a few lenders and exporters.
- Negative years happen (de-obligations exceed new obligations); show them as negative with a note, don't clamp.
- The recipient search returns rows with a `null` name (crashed the first run).

## 5. Legal and use
USAspending data is a work of the United States Government, published under the Federal Funding
Accountability and Transparency Act of 2006 and the DATA Act of 2014, and is in the public domain
(17 U.S.C. § 105); the usaspending-api repository is CC0 1.0. The site asks for no attribution and sets
no terms of use; the API has no key and no published rate limit. We should still say where each number
comes from and link the recipient profile (`https://www.usaspending.gov/recipient/<id>/latest`), as the
pages do for FEC and LDA data, and note "obligations, prime awards only, as reported by agencies". None of
the § 13107 restrictions that apply to the holdings pages are involved.

## 6. Cost of building and refreshing
Measured: 208 requests to match 247 organizations, 170 for one-record totals and agencies, 258 for the
same-name records and children cross-check, about 45 by hand: **≈ 680 requests, 11 minutes of waiting**.

| Run | Requests | Time at 1/s |
|---|---|---|
| Match all 6,929 organizations (keyword search, raw-name retry, a profile for child-only matches) | ≈ 9,000 | ≈ 2.5 h |
| Totals for the matched organizations: 65% of the sample matched, say 40% in the long tail, ≈ 2,800 orgs × (2.7 same-name records + 3 children lookups) | ≈ 16,000 | ≈ 4.5 h |
| Top agencies for those with ≥ $1M (21% of the sample's matches; say 600 orgs, one request each) | ≈ 600 | ≈ 10 min |
| **First build** | **≈ 26,000** | **≈ 7 h** |
| **Monthly refresh** (totals and agencies for the ≈ 600 organizations that showed money, plus new organizations; the zero-dollar matches re-checked quarterly) | ≈ 4,000 | ≈ 1 h |

Weekly is unnecessary: the figures change meaningfully once a month, and the DoD lag means the current
year is always incomplete. A monthly cron, like `refresh-527`, fits; or fold a `usaspending` step into the
weekly `ingest` with a 30-day cache age, which is how `lobbying` already treats LDA spend.

## 7. Recommendation and proposed pages
**Build**, as one section, after "Bills it lobbied on" and before "Former government officials" on
`site/src/pages/organizations/[id].astro`, shown only when the organization has reviewed recipient records
and at least $1M in either of the two most recent complete fiscal years (about 51 of the 247 sampled;
perhaps 300–500 pages site-wide):

- **`Federal contracts and grants`** (`id="federal-awards"`): dek "In fiscal 2025 (Oct 2024–Sep 2025) the
  federal government obligated at least **$74.9B** to Lockheed Martin and its subsidiaries, almost all of
  it contracts, mostly from the Department of Defense (98%) and NASA (2%). FY2024: $39.0B. Obligations
  are money the government committed to its contracts and grants, not payments, and aren't part of the
  contributions totals above." Then a two-row table (FY2024, FY2025) × (contracts, grants, loans, other,
  total), a `RankedTable` of the top five awarding agencies, and a source line: "From USAspending.gov,
  prime awards to the 13 recipient records registered as Lockheed Martin Corp (UEI ZFN2JJXBLZT3 and
  others) and their subsidiaries; obligations as reported by agencies, Defense Department actions
  published about 90 days late. [Recipient profile]."
- **Data file** `data/usaspending.json`: `{ fiscalYears: ["2024","2025"], updated, organizations: { <id>:
  { records: [{ id, name, uei, level }], byYear: { "2025": { contracts, grants, loans, direct, other,
  total } }, childrenCheck: { "2025": n }, agencies: [{ name, amount }] } } }`, built by
  `src/scripts/usaspending/build.ts` from `data/organizations.json` + the overrides, read by
  `site/src/lib/usaspending.ts` the way `irs527.ts` reads its file.
- **Hand review** `data/usaspending-overrides.json`, in the style of `data/committee-overrides.json`:
  organization id → `{ records: ["<hash>-P", …] | null, note }`, where `null` means "we checked; show
  nothing". Required before shipping for every organization over $100M (33 in the sample; perhaps 60
  site-wide), for every match where the hash-sum and children-by-DUNS disagree by more than 10% (31 in
  the sample), and for any match on a name other than the site's. The worklists are `report.ts`'s
  near-miss and odd-match lists and `report2.ts`'s disagreements.
- **Matcher fixes** before the build: search the raw name as well as the normalized one; reject recipient
  names that add a number, "LOCAL", "COUNCIL", a state or a city; accept one- and two-token names on a
  prefix match confirmed by the profile; sum all same-name P/R records; and discover differently named
  sub-parents from the children list of each parent DUNS.
- **About page**: a paragraph under the sources, modeled on "State political groups", with the
  obligations/outlays, prime-only, many-records and lag notes.

**Don't build yet:** sector rollups on `/sectors/<slug>/` (Defense is ten companies and $132B, every
other sector is one to three companies, and one wrong parent moves a sector by billions; revisit after
the review file exists), a page per recipient or per agency (that's USAspending's job), award-level
lists (the parent filter is unreliable there and the rows are lifetime values), anything on member pages
(contracts don't go to districts in a way the data supports without the sub-award and place-of-performance
work this study didn't do), and comparisons that read as "gave $X, got $Y".

## Files (`.cache/usaspending/`)
`probe/` (hand requests from this study: Lockheed profile, children, monthly series, award types,
submission periods, RTX and Raytheon profiles, API contract docs), `recipient/`, `recipient_duns_*`,
`recipient_children_*`, `search_spending_over_time/`, `search_spending_by_category_awarding_agency/`
(every response, keyed by endpoint and request body), `matches.json`, `totals.json`, `totals2.json`,
`report.md`, `report2.md`, `*.log`.

## Reproducing
```sh
tsx src/scripts/usaspending/match.ts     # sample → .cache/usaspending/matches.json (≈ 210 requests)
tsx src/scripts/usaspending/totals.ts    # one record each: FY2024/25 by type, top agencies → totals.json (≈ 170)
tsx src/scripts/usaspending/totals2.ts   # all same-name records + children by DUNS → totals2.json (≈ 260)
tsx src/scripts/usaspending/report.ts    # §2 tables, hard cases
tsx src/scripts/usaspending/report2.ts   # §3 rollup comparison
```
