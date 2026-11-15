# Members' stock holdings and trades: exploration

Can contributions.fyi add what members of Congress own and trade, from their
financial disclosure reports, and show it fairly? Short answer: **yes for the
House, as a narrow version; not yet for the Senate.** House e-filed reports
parse cleanly and match to SEC companies well. Paper filings, about half of
all House trade lines, are now read by machine from the scans (79% of trade
rows and 92% of asset rows read with no doubts; the rest are flagged and left
out). The Senate's search is down for maintenance, so it's still to come. Numbers, legal notes and screenshots below.

Everything is on the `sesh/stock-holdings-exploration` branch. Nothing was
written to Bluesky, the PDS or the labeler, and nothing here is in the CC0
open data.

## What's on the branch

- `src/scripts/disclosures/`: the exploration code. `house-index.ts` (filing
  index → bioguide ids), `pdf.ts` + `house-parse.ts` (text layer → holdings and
  trades), `match.ts` (assets → SEC companies, sectors, the site's
  organizations), `house-all.ts` (fetch and parse every current member's
  filings), `house-build.ts` (→ `site/src/data/holdings.json`),
  `house-measure.ts` / `house-full-measure.ts` (the numbers here),
  `senate.ts` / `senate-try.ts` (the eFD attempt). Caches under
  `.cache/disclosures/`.
- Prototype pages, each marked "Prototype" on the page:
  - **`/members/[id]/investments/`**: a member's holdings by kind and by
    industry as ranges, every single-company holding with whose it is, stock in
    industries their committees cover against a baseline, and recent trades.
    Linked from the member page with one line, not embedded in it.
  - **`/holdings/`**: coverage, how to read the data, the latest trades and a
    paginated archive of every trade (`/holdings/trades/N/`, server-rendered:
    the site never ships the parsed data as one bulk file), the most widely
    held companies, and the members who file on paper, linked.
  - **`/holdings/companies/[cik]/`**: which members own a company and which
    traded it, with its PAC shown beside the list, not joined to it.
- A `ranges` chart in `site/src/lib/charts.ts`: a solid bar to the least a
  filer could hold and a pale one on to the most, so a range never reads as a
  figure.


## 1. Data

All numbers are for current House members (439, including delegates), the
calendar-2025 annual reports filed in 2026, and transaction reports (PTRs)
filed January 2025 to November 13, 2026, unless noted.

### Verdicts

| Source | Verdict | Measured |
| --- | --- | --- |
| **House Clerk, e-filed PDFs** | **Use.** | Every e-filed PDF had a clean text layer (1,254 of 1,254). In a 48-report, 125-PTR sample, parsing got a value range and type code for every asset and an amount for every trade (checked by script, with spot checks against the PDFs). 94% of single-company holdings (89% of their value) and 95% of single-company trades match an SEC company. |
| **House Clerk, paper filings** | **Use, read by machine, flagged and linked.** | 7.2% of annual reports (31 of 431) and 13.1% of PTRs (124 of 944) are scanned paper with no text layer, but they hold about half of all House trade lines (9,000 of them Ro Khanna's). A local pipeline (section 1a) reads **11,383 trade rows from 887 PTR pages, 79% with no doubts**, and **4,909 assets from 272 Schedule A pages, 92% with no doubts**. On fresh pages checked by eye, every unflagged row's type, amount, owner and date matched the scan. Flagged rows (2,380 trades, 395 assets) are counted and linked, not shown. |
| **Senate eFD** | **Down for maintenance. Nothing measured yet.** | Confirmed in a browser: search shows the same maintenance page to people. Retrying slowly; see below. |

### House Clerk (disclosures-clerk.house.gov)

**Access.** The Clerk publishes a yearly ZIP (`{year}FD.zip`, ~100 KB) with
an XML and a tab-separated index of every filing: name, filing type, state and
district, filing date and DocID. Each PDF is at a stable URL:
`public_disc/ptr-pdfs/{year}/{DocID}.pdf` for PTRs,
`public_disc/financial-pdfs/{year}/{DocID}.pdf` for everything else. The
index's `Year` is the year *reported on*: CY2025 annual reports, filed in
2026, are in `2025FD.zip`. Waivers have no filing date.

**The DocID says how it was filed.** Eight-digit DocIDs (`1…` annual, `2…`
PTR) are e-filed; seven-digit ones (`8…`, `9…`) are scanned paper. This held
for all 1,412 PDFs in the full run: 1,254 eight-digit DocIDs, all with a text
layer, and 158 seven-digit ones, none with one, so the ingest can skip paper
before downloading if it wants.

**Matching to bioguide ids** is by last name and state, with district or
first name to break ties, since districts move with redistricting. Every
sitting member who owes a 2025 annual report matches. Two needed a second
rule because the surname sits elsewhere ("Aumua Amata" Radewagen, "Ashley
Hinson Arenholz"). Of the 8 members with no 2025 annual yet, 7 were sworn in
between November 2025 and September 2026 and aren't due; one (Dan Crenshaw)
has filed only an extension.
Candidate filings (types C and D) under a member's name are skipped.

**Coverage and freshness.**

- Annual reports value holdings at **December 31** and arrive **five to eight
  months later**: 138 of 431 in May 2026, then 204 in August after the
  automatic 90-day extension (the 2025 index has 714 extension filings, from members and candidates).
  A holdings page is always a snapshot of last New Year's Eve.
- PTRs must come within 30 days of the member learning of a trade and no
  later than 45 days after it. Days from trade to filing: **median 27, 90th
  percentile 50, 99th percentile 306**; 11.6% were filed more than 45 days
  after the trade date (this includes amendments, late-learned trades and a
  handful of date typos: 6 trades are dated after their filing). "Recent
  trades" are always about a month old.
- 139 House members filed at least one PTR since January 2025; 122 filed
  them electronically. 171 of the 400 e-filed annual reports list any stock
  in a single company.
- 27 of the annuals used are amendments, which replace the original. PTR
  amendments arrive as new PTRs with lines marked "Amended" or "Deleted" (23
  lines); a production ingest should net those out rather than add them.

**Parsing.** e-filed PDFs come from the House's filing system, so each table
has a header row whose x positions define the columns; cells wrap onto
following lines, and value ranges split across two (`$1,000,001 -` /
`$5,000,000`). `house-parse.ts` assigns text runs to columns by position. The
small-caps labels under each row (Location, Description, Comments, Subholding
of) have no text mapping in the PDF font and come out as a capital letter
followed by NUL characters, which turns out to be a reliable marker.

| Field | Result (e-filed) |
| --- | --- |
| Asset name | 19,037 assets in 400 reports, median 25 per member. 8 reports really are empty ("None disclosed"). 90% of assets are listed inside an account ("Account ⇒ Holding"), which the parser splits off. |
| Asset type | House type code on 100% of assets (`[ST]` stock, `[MF]` mutual fund, `[EF]` ETF, `[OP]` option, `[RP]` real property, … 49 codes). |
| Owner | self 56%, spouse 25%, joint 14%, dependent child 5% of assets; on trades, self 53%, spouse 26%, joint 16%, child 6%. |
| Value | A range on every asset. 2,053 (10.8%) are "None" or "Undetermined" (accounts emptied during the year, some private holdings); 79 are open-ended ("Over $50,000,000", "Spouse/DC Over $1,000,000"); 15 assets from 2 members give exact dollar figures instead of a range. |
| Trades | 10,512 trade lines dated 2025 or later: transaction type (purchase, sale, partial sale, exchange), trade and notification dates, amount range, owner, and the filer's comments. 74% are $1,001–$15,000; 0.6% are over $1M. |
| Tickers | In the asset name on 74% of assets and 91% of trade lines. |

**Matching to companies and sectors.**

- Ticker first, against SEC `company_tickers.json`, then the normalized
  company name (`normalizeOrg`); the industry comes from the SEC submissions
  SIC code, through `sectorForSic`. **94.0% of single-company holdings
  match (89.3% of their value); 94.8% of single-company trades.**
- 53% of single-company holdings are in a company that has an organization
  page on the site (its PAC is in our data).
- What doesn't match: OTC ADRs that don't file with the SEC (Alfa-Laval,
  Komatsu, Chugai), and companies that have since merged or changed tickers
  (Warner Bros. Discovery after the Paramount Skydance deal).
  `company_tickers.json` only has current tickers, so a production version
  needs historical ticker-to-CIK history.
- **Filers' type codes need correcting.** 39 holdings from 7 members were
  index products or funds typed as stocks or bonds: buffered S&P 500
  annuities and structured notes typed as `[CS]`, SPY typed as `[ST]`. SPY
  even has a CIK, so it would have been given an industry. `house-build.ts`
  moves them by name. Before that fix, one member's index annuities made 45%
  of all "single-company" value unmatched.
- SIC-based sectors are coarse: Amazon is retail (Misc Business), Visa is
  business services (Misc Business), and refiners and ethanol producers are
  both Energy.

**Value: most of it isn't stock.** By the midpoints of the ranges (used only
for these shares, never shown), members' disclosed assets are 33% real
estate and private businesses, 21% mutual funds and ETFs, 12% other, 10%
single-company stock, 8% private funds, 7% cash and Treasuries and 7%
insurance and annuities. Funds can't be broken down: reports list a fund or
a 401(k) by name, not its holdings.

**Pitfalls, measured.**

- **Ranges only.** The high end of a member's total is a median **2.9 times**
  the low end (90th percentile 4.7x). Nancy Pelosi's 67 assets add up to
  $85.9M–$412.4M.
- **Spouse holdings.** 44% of assets aren't the member's own. For Pelosi,
  66 of 67 are a spouse's or joint.
- **Blind trusts.** Only 4 members mention a qualified blind trust, whose
  contents aren't disclosed. Rare, but their pages must say so rather than
  show nothing.
- **Mutual funds and ETFs** are 41% of assets and exempt from PTRs, so trades
  are 86% single-company stock: the trade data over-represents stock-picking
  compared with how members actually hold their money.
- **Options** are 0.1% of assets, but the description carries strike and
  expiry ("50 call options with a strike price of $150 …"); the value range
  is the option's value, not the exposure.
- **Advisers.** 370 trades (3.5%, from 5 members) carry the filer's note that
  an adviser or manager made the trade. Reports don't otherwise say who chose
  a trade, so no note doesn't mean the member did.
- **Lots.** 3.8% of trade lines repeat the same member, date, asset,
  direction and owner (lots reported separately), so counts overstate
  activity.
- **Concentration.** The 5 most active e-filers account for 47% of trade
  lines, one for 16%.

### 1a. Paper filings, read by machine

The first pass treated paper as unreadable (Vision OCR read names and dates
but lost the X marks). The second pass reads the marks as ink in the form's
grid, all on this machine (macOS PDFKit and Vision; no service sees the
reports):

- `scan/analyze.swift` renders each page, picks its orientation (and turns it
  180° when the owner tags sit on the right; Vision reads upside-down text, so
  a text score alone can't tell), OCRs every word with its position, finds the
  table's ruling lines, and measures the ink in each cell, skipping pixel rows
  that are ruling lines. Every date is read three times (page, 3× crop, 4×
  binarized crop, upright and flipped) and the majority wins, which recovers
  dates Vision reads backwards ("9ZOZ/S/E" for 3/5/2026).
- `scan/ptr.ts` finds the two date columns, makes one row per trade date
  (scans lose row rules, so a ruled row can hold two trades), assigns name
  lines to the nearest date below them, and picks the transaction type and
  amount as the cell with clearly more ink than the lower of its column's and
  its row's typical ink (empty printed boxes aren't empty, and when every row
  is a purchase the purchase column's typical cell is itself marked).
- `scan/annual.ts` does the same for Schedule A: one row per ruled row with a
  name, skipping the form's printed example rows, and Block B's 13 value
  columns located by the A–M letters OCR reads above them (each letter votes),
  or centered under "Value of Asset".
- A row is flagged, and left out, when a mark is missing or two marks compete,
  the three date readings disagree, the notification predates the trade or
  comes more than 90 days after it, the owner tag is unreadable, or there's no
  name. Kept rows carry a "Scan" tag and link to their page of the PDF.

| | Paper PTRs | Paper annual reports (Schedule A) |
| --- | --- | --- |
| Documents, pages | 124, 887 | 34, 1,005 (272 Schedule A grid pages) |
| Rows found | 11,383 (an earlier date-line count estimated ~11,500) | 4,909 |
| No doubts | 9,003 (79.1%) | 4,514 (92.0%) |
| Biggest filers | Khanna 6,959 of 9,017; McCaul 1,721 of 1,930; Fleischmann 111 of 115 | Khanna 3,259 of 3,475; Harshbarger 599 of 612; Guest 252 of 254 |
| Weakest | Handwritten and check-mark forms (Self, Mann, McClain) | Handwritten forms (Craig, Thompson, Sherman, Gonzalez): a few rows each |
| Matched to an SEC company | 76% of company-like names, by loose name (no tickers on paper PTRs); 25 random matches all right | 1,963 holdings; Harshbarger's forms carry tickers |
| Not read at all | 100 pages with no trade table (cover pages, "nothing to report", statements) | Attached brokerage statements (~75 pages), other schedules |

**Accuracy, checked by eye.** On 7 PTR pages not used for tuning (89 rows
across Khanna, McCaul, Harshbarger, Wied and Fleischmann), after the fixes
those pages prompted: transaction type 89/89, amount 89/89, owner 89/89,
trade date right or flagged on every row. On three Schedule A pages (Khanna,
Whitesides, Harshbarger; ~55 rows) every value matched after locating Block B
by its letters. The weak spot is blurry scans: on one Khanna page I tuned
against, 2 of 19 trade dates were read as 05/02 instead of 06/02 by all three
readings, so they weren't flagged. Expect a small rate of silent date errors
on the worst scans; that's why every scanned row links to its page.

Fixes the checks forced, for the record: upside-down pages, overlapping date
bands on tight forms, owner tags OCR'd as "5P"/"SE" (now matched loosely and
flagged if unmatched, rather than called the member's), a stray rule splitting
the owner column, trust headings read into asset names, and Block B shifted
one column where OCR missed the "EIF" box.

### Senate eFD (efdsearch.senate.gov): down for maintenance

**Verdict: no data measured. Don't build on it yet.**

What happened, in full (every request this exploration made to the host):

| Time (PST, Nov 15 2026) | Request | Result |
| --- | --- | --- |
| 12:09 | `GET /robots.txt` | 404 (no robots file) |
| 12:09 | `GET /search/home/` | 200, the agreement form |
| ~12:20 | `GET /search/home/`, `POST` the agreement (2 s apart) | 302: accepted |
| ~12:20 | `POST /search/report/data/` (PTRs and annuals, 2024–26) | **503** |
| ~12:21 | `GET /search/home/`, `POST` the agreement, then `GET /search/` as a session check (sent with a placeholder user agent, `x`, by mistake) | 302, then 200 |
| ~12:21 | `POST /search/report/data/` with no session, to read the error | 400 from Akamai |
| — | *Backed off 32 minutes* | |
| 12:54 | `GET /search/home/`, `POST` the agreement, `POST /search/report/data/` (5 s apart, user agent `contributions.fyi research (https://contributions.fyi)`, no retries) | Agreement 302; search **503**: "U.S. Senate: Site Under Maintenance … WEBSITE TEMPORARILY UNAVAILABLE DUE TO MAINTENANCE." |
| 13:24 | The same three requests, same pacing and user agent | Same 503 maintenance page. |
| ~14:40 | The user ran a search on efdsearch.senate.gov in a browser | "Down for maintenance": a real outage, not a block on automated access. |

The home page and the agreement step work, but search is down for maintenance
for everyone: the user saw the same page in a browser. So this is an outage to
wait out, not automated access being refused. One slow attempt (the same
three requests, 5 s apart, same user agent, no retries) runs every 6 hours
until November 17; when search answers, the plan is to list senators' 2025–26
reports, measure the electronic-versus-paper rate, parse a handful of
senators first, and check back before fetching all 100. Nothing about the
Senate's coverage or parse quality has been measured yet.

What's known about the format without fetching, from the eFD site's public
pages and URL scheme; unverified here, to check when it's reachable:

- Reports filed through eFD are **HTML pages** (`/search/view/annual/{id}/`,
  `/search/view/ptr/{id}/`) with real tables: asset, type, owner, value range,
  transaction type and date. If they're reachable, they'd parse more reliably
  than the House's PDFs, with no column inference.
- Paper filings are `/search/view/paper/{id}/`: **page images (GIFs)**, one
  per page, with the same OCR problem as House paper filings (section 1).
- There's no bulk download and no published API; the search endpoint is a
  DataTables backend behind a CSRF token and the agreement cookie.
- Reports are taken down six years after a senator leaves office.

**If the outage drags on, or search comes back but refuses automated
requests**, the alternatives, in order:

1. **Contact the Senate Office of Public Records** (Office of Public Records,
   144 Hart Senate Office Building, Washington, D.C. 20510-7116; (202)
   224-0322, per the eFD home page). Ask whether automated access to eFD
   search and report pages is permitted, at what rate, and whether there's a
   bulk export.
2. **A much slower schedule**, if they say it's fine or the endpoint comes
   back: one search request and a few report pages per minute, run weekly. A
   full Senate refresh is ~100 senators × (1 annual + a few PTRs), a few
   hundred pages: an hour or two at that pace.
3. **Occasional manual exports**: someone searches in a browser, affirms the
   terms, and saves the senators' report pages, which a script parses offline.
   Workable for 100 senators a few times a year; it doesn't scale to trades.

Not recommended: rotating user agents, headless browsers to get past the
503, or third-party mirrors of Senate data. The first two are exactly the
evasion the site may be guarding against; the third launders the Senate's
click-through and adds a commercial intermediary's terms.


## 2. UX

Three directions, built as rough pages on the branch. The design follows the
site's editorial style: serif headlines, hairline rules, black bars, color
only for party. Light and dark come from `prefers-color-scheme`, the trades
table uses the site's React Aria `ListTable` and filter controls, and the
range charts use Observable Plot with the site's legend and table view.

1. **A member's investments page** (`/members/[id]/investments/`), separate
   from the campaign-money page and linked from it by one line (screenshot
   08). Totals and every chart are ranges: a solid bar to the least the filer
   could hold, a pale one on to the most. Holdings are split by kind first
   (single company / funds / cash / property and businesses / accounts), and
   only single-company holdings get an industry. Every holding says whose it
   is. Trades show the amount range, how many days later they were reported
   (linked to the PDF), and an "Adviser" tag where the filer said so. Paper
   filers' rows are read by machine, tagged "Scan" and linked to their page,
   with a note saying how many rows couldn't be read (07, 09).
2. **The index** (`/holdings/`): coverage, four "how to read these" rules,
   every trade in a filterable table (defaulting to single companies), the
   most widely held companies (which mostly mirror the stock market), and the
   paper filers, linked.
3. **A company page** (`/holdings/companies/[cik]/`): who reported owning
   it and who traded it, by party, with the company's PAC in a separate box
   that says the page doesn't connect the two. The version that does join
   them is screenshot 06, and isn't recommended.

| | |
| --- | --- |
| `01-index-{light,dark}.png` | The index: coverage, how to read, the trades table, widely held companies, paper filers. |
| `02-member-pelosi-{light,dark}.png` | A spouse-held, mostly-tech portfolio: 66 of 67 assets not her own, ranges of $85.9M–$412.4M. |
| `03-member-bresnahan-{light,dark}.png` | 624 assets, 654 trades, adviser notes on 27; committee overlap at the baseline (1% vs 1%). |
| `04-member-gottheimer-light.png` | Financial Services member with 238 single-company holdings. |
| `05-company-rtx-{light,dark}.png` | RTX: 14 holders (7 D, 7 R), 8 traders, its PAC beside the list. |
| `06-company-rtx-joined-NOT-RECOMMENDED-light.png` | The same page with a "From its PAC" column. |
| `07-paper-khanna-{light,dark}.png` | A paper filer: 3,134 assets and 6,959 trades read by machine from the scans, each tagged and linked, mostly held in family trusts. |
| `09-paper-harshbarger-light.png` | A typed paper Schedule A with tickers: 591 assets, and municipal-bond trades read from checkbox forms. |
| `08-member-page-link-light.png` | The one line on the member page. |

### What keeps it fair

- **Ranges everywhere**, including totals. Midpoints are used only to compute
  shares and are never displayed.
- **Kinds before industries.** A fund isn't a bet on an industry; only
  single-company holdings get one.
- **Whose it is**, on every row.
- **Its own page.** Holdings never sit beside "biggest backers" or PAC
  charts.
- **Baselines.** Committee overlap is shown only next to the share for all
  House members' single-company stock pooled.
- **Coverage stated**: senators and paper filers missing, on every page that
  aggregates.
- **Sources linked** to every PDF, with the § 13107 notice.

### Framings with a high risk of misleading

1. **Joining PAC money to holders** (screenshot 06). It reads as "owns it and
   is paid by it". On RTX, 6 of its 14 holders got money from its PAC, which
   looks pointed until you see that **61% of all House e-filers did**: holders
   got its money *less* often. Across the 164 companies held by 5 or more
   members, holders get a company's PAC money at about the base rate (21
   companies run 15+ points above it, 17 run 15+ below), and 160 of 356
   companies with a PAC have at least one holder it funded. The join produces
   a striking-looking overlap for nearly every big company, by chance.
2. **"Members on the X committee own X stocks", with no baseline.** 25% of
   Armed Services members with any company stock hold a defense company,
   against **26.5% of everyone else**. Energy and Commerce: 71% hold an
   energy, health or tech stock, against 82% of non-members (those three industries are
   60% of all members' single-company stock by value). Financial Services: 65% against 60%.
   The only gap of note is Transportation and Infrastructure, 54% against
   36%. The naive line is true and damning-sounding for every committee. On
   the member page, a member at 2x the baseline and 10 points over it
   happens for 8 members on 3 committees, and small baselines (agriculture,
   0.6%) make "2x" trivially easy.
3. **A chronological trade feed** is mostly a few accounts: one member is 16%
   of all lines and the top five are 47%, many of them $1,001–$15,000 lots
   from managed accounts. "What Congress is buying" is really what two or
   three advisers are buying. Group by member, or don't headline it.
4. **"Most active traders" rankings.** Wrong in a way that misleads: the most
   active House trader (about 9,400 lines, by OCR estimate) files on paper and
   is invisible to the e-filed data. Lot-level lines (3.8% repeats) inflate
   counts too.
5. **"Late filer" labels.** 11.6% of lines are past 45 days, but that count
   includes amendments, trades the member learned of late (the 30-day clock
   runs from notification), and date typos (some come out at −1 days). It
   needs a manual check per case before anything is labeled late.
6. **Net worth or "their stake in X"** from midpoints, and anything about
   returns or "beating the market". Ranges that span 3–5x and month-old
   dates can't support either.
7. **Trade timing next to events** ("sold before the hearing"). Not
   attempted; the dates are real, but the data can't show what the member
   knew, and whether an adviser made the trade is rarely stated.
8. **Spouse holdings as the member's**, and **fund holdings as industry
   bets**. Both are handled in the prototype, and both are easy to lose in a
   headline, a chart title or a Bluesky label.


## 3. Recommended scope

**A narrow House-only version, without PAC joins.**

*Ship first: low risk, high value*

- The **member investments page** for House e-filers as prototyped: kinds
  and single-company industries as ranges, whose it is, trades with
  reporting lag and adviser notes, links to every PDF. Paper filers get a
  page that says so and links their scans. One line on the member page links
  to it.
- The **index** with the trades table defaulting to single companies,
  grouped or filterable by member, and the paper-filer list.
- **Company pages** listing holders and traders, with the PAC box separate
  or left off. No per-member PAC column.
- The § 13107 notice on every page, and no asks of any kind on or near them.

*Later, only if each prerequisite is met*

- **The Senate**, once eFD search is back from maintenance (or, if it then
  refuses automated requests, once the Senate Office of Public Records says
  automated access is fine or offers an export). eFD's HTML reports would likely parse
  better than House PDFs.
- **Committee overlap**, kept on the member page, always beside the
  baseline, and never as a headline, list or label. Review whether it adds
  anything once the baseline makes most rows unremarkable.
- **Paper filings beyond what's flagged clean**: the machine reading
  (section 1a) ships with its "Scan" labels and page links. Before launch, a
  person should spot-check each paper filer's newest report, especially
  Khanna's blurriest scans, and the flagged rows (2,380 trades, 395 assets)
  need a person to transcribe if they're to appear at all.
- **Historical ticker matching**, to cover merged and renamed companies.

**Not worth it, or not appropriate:** per-member PAC joins, "most active
traders" or "biggest holders" rankings, late-filer labels without review,
returns or net-worth estimates, holdings in Bluesky labels or feeds, and
holdings in the CC0 open data or the PDS (section 4).

## 4. Legal and open-data notes

*Not legal advice. These are the points a lawyer should look at before any of
this ships, and especially before any of it is redistributed.*

### The statute

5 U.S.C. § 13107 (until December 2022, 5 U.S.C. app. § 105(c)) makes it
unlawful for **any person** to obtain or use a financial disclosure report:

- for any unlawful purpose;
- for any commercial purpose, other than by news and communications media for
  dissemination to the general public;
- for determining or establishing anyone's credit rating;
- for use, directly or indirectly, in soliciting money for any political,
  charitable or other purpose.

The Attorney General can sue; the Senate's notice quotes a civil penalty of up
to $10,000 (the amount is inflation-adjusted, so check the current figure).

contributions.fyi fits as a free, non-commercial, public-interest site. What
keeps it inside the lines:

- **No asks anywhere near this data.** The site has no donate, sponsor or tip
  links today (checked: none in `site/src`). If one is ever added, it must not
  appear on investments pages, in their link previews, or in any feed or
  Bluesky post built from them. "Directly or indirectly" is broad: a donate
  button in the site footer of an investments page is the kind of thing to ask
  a lawyer about.
- **No ads, sponsorships or paid tiers** on these pages.
- **Every page that shows this data carries the § 13107 notice** (the
  prototype pages do, in the source line).

### What the sites ask

| | House Clerk | Senate eFD |
| --- | --- | --- |
| robots.txt | None (404) | None (404) |
| Terms | No website terms. The search page repeats the § 105(c) notice and says some personal information has been redacted. (The "Terms of Service" link in the Clerk's footer is a list of members' terms in office, not website terms.) | A click-through: "I understand the prohibitions on obtaining and use of financial disclosure reports," required before any search. |
| Bulk access | Offered: a yearly ZIP of the filing index (`{year}FD.zip`), and every PDF at a stable URL. | None. The search page calls a DataTables JSON endpoint behind a CSRF token and session cookie. |
| What we did | Fetched the index ZIPs and 1,412 PDFs at one request per 1.5 s with a user agent naming the project and a contact email (now changed to the site's URL), cached under `.cache/disclosures/`. | Read the terms, posted the affirmation once (the project's use is within it), made two search requests: both 503. Stopped; see section 1. |

### Why holdings can't go into the CC0 open data as-is

The open-data page says the data is "CC0 1.0. Use them for anything." That's
right for FEC and lobbying data. It would be wrong for this data:

1. **CC0 is a copyright waiver; the problem here isn't copyright.** Government
   reports aren't copyrighted anyway. § 13107 restricts *use*, and it binds
   whoever obtains or uses a report, not just us. "Use them for anything" would
   tell downstream users something false about their own legal exposure.
2. **It's unsettled whether parsed data counts as "the report".** A table of
   one member's holdings with their value ranges is the report's content in
   another format. The conservative reading is that the restrictions travel
   with it.
3. **The Senate gates access behind an affirmation.** Republishing Senate data
   in bulk, with no gate, would route around the one step the Senate asks of
   every reader.
4. **atproto records can't carry conditions.** Anything in the PDS is copied by
   relays and every firehose consumer, commercial ones included, with no notice
   attached and no way to withdraw it. Holdings should **never** go into the
   PDS or Bluesky labels.

If the site ever offers this data for download, it should be a separate file
with its own terms, roughly:

> **Financial disclosure data.** Parsed from reports filed with the Clerk of
> the U.S. House of Representatives under the Ethics in Government Act. Under
> 5 U.S.C. § 13107, it is unlawful to obtain or use these reports for any
> unlawful purpose; for any commercial purpose, other than by news and
> communications media for dissemination to the general public; to determine
> or establish anyone's credit rating; or, directly or indirectly, to solicit
> money for any political, charitable or other purpose. By downloading this
> file you agree to use it only within those limits. It is not offered under
> CC0. Values are the ranges members reported, not amounts. The original
> reports are linked from every record and are the authoritative version.

with, at minimum: a click-through before the download (like the Senate's),
no bulk endpoint without it, the file kept out of `publish-records.ts`, the
dataset record and `/open-data`'s "Use them for anything", and its own entry
in the open-data page's source list. **Flag for the user: get a lawyer's read
before redistributing any of it.** Showing it on the site's own pages, as news
and public-interest dissemination, is the lower-risk use.

The prototype keeps to this: its data file is `site/src/data/holdings.json`,
which `publish-records.ts` never reads, and nothing was written to Bluesky,
the PDS or the labeler.

## 5. Ingest cost

Measured on this machine, for all current House members (CY2025 annual
reports plus 2025–26 PTRs):

| Step | Cold run | Incremental | Raw cache | Output |
| --- | --- | --- | --- | --- |
| Filing index (3 yearly ZIPs) | < 1 s | Daily: the ZIPs are regenerated; ~100 KB each | 2 MB unzipped | — |
| PDFs (1,412: 468 annual/amendment, 944 PTR) | **33 min** at one request per 1.5 s | ~11 new PTRs a week (468 in 2026 so far); annual season is a burst of ~430 PDFs (94 MB) in May and August | **185 MB** (annual 94 MB, PTR 91 MB; paper PDFs are the big ones: Khanna's annual is 353 pages, 11 MB) | — |
| Parse every PDF from cache | **26 s**, ~1 GB peak memory (pdf.js) | Only new PDFs | — | — |
| Match and build (`house-build.ts`) | 79 s, mostly SEC submissions lookups for ~350 new CIKs at 5/s | Seconds (cached) | SIC cache, < 1 MB | `holdings.json` **9.6 MB** (1.0 MB gzipped) for 434 members |
| Site build | Whole site 2 min 43 s for 20,879 pages | — | — | 434 investments pages (26 MB), 1,249 company pages (53 MB), `trades.json` 3.4 MB |
| Read paper filings (`scan/analyze.swift`, macOS only) | ~1–3 s a page with three date readings; 887 PTR pages ≈ 12 min and 1,005 annual pages ≈ 15 min on four cores | Per new paper PTR (a few a week) | 54 MB of page JSON | Parsing all of it: seconds |
| Senate | Unknown | — | — | — |

The first run fits the existing ingest pattern (budgeted minutes per run,
cached between runs); after that, a weekly run is a few minutes. The
prototype data file, `site/src/data/holdings.json`, is gitignored on the
branch: regenerate it with

```sh
pnpm tsx src/scripts/disclosures/house-all.ts     # ~33 min cold, 26 s cached
# Paper filings (macOS): analyze each scanned PDF, then parse
swiftc -O src/scripts/disclosures/scan/analyze.swift -o .cache/disclosures/scan/analyze
#   .cache/disclosures/scan/analyze <pdf> > .cache/disclosures/scan/<DocID>.jsonl   (per paper PDF)
pnpm tsx src/scripts/disclosures/scan/run-ptrs.ts
pnpm tsx src/scripts/disclosures/scan/run-annuals.ts
pnpm tsx src/scripts/disclosures/house-build.ts
```

