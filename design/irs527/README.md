# IRS Section 527 data: is it worth adding to contributions.fyi?

Source: IRS Political Organization Filing and Disclosure full file (e-filed 8871/8872 only), transmitted 2026-11-14.
Scope of analysis: 8872 reports whose period ends in 2023–2026. Scripts: `src/scripts/irs527/` (parse.py, orgs.py, members.py, donors.py, transfers.py, scope.py, names.py).

## Short answer
**It's mostly state-level money, and very little of it involves current members.** About 69% of 2023–26 receipts belong to state/local groups: governors', attorneys general and legislative committees, single-state groups, and ActBlue's state-level conduit. Another 10% is ActBlue's processing entity, and 12% is union or business nonfederal accounts that also mostly fund state work. Groups focused on federal races account for about 0.2%. 527 spending on current members' federal races comes to about $2M over four years, and most of it is ordinary PAC contributions that are already in FEC data. **Recommendation: (B) build only a small piece.** Show on organization pages what the companies and unions the site already covers gave to governors', AG and legislative 527s. Optionally, list members' legal defense funds. Do not build a "527s that spent on this member" section.

## 1. Shape
- Full file: 78,842 Form 8871 filings (59,796 EINs, 14,603 amended); 56,729 Form 8872 reports (4,252 EINs); 9.99M Schedule A rows; 8.47M Schedule B rows. Malformed lines: 155 out of 18.9M. Of these, 114 are 8871s cut off after PURPOSE, which are still usable. 41 are truncated A/B/D/R rows, which were dropped, plus one trailing `(return status = 0)` line.
- Reports for 2023–2026: 10,163 reports, 761 of them flagged as amended. An amended 8872 replaces the whole report, so I kept the latest-filed report for each (EIN, begin date, end date). That leaves **9,487 reports from 1,164 organizations**. Without this step, receipts would be overcounted by $511M.

| Period-end year | Orgs | Reports | Receipts | Spending |
|---|---|---|---|---|
| 2023 | 761 | 1,815 | $627M | $646M |
| 2024 | 814 | 3,666 | $958M | $969M |
| 2025 | 707 | 1,714 | $739M | $623M |
| 2026 (to ~Q3/pre-general) | 690 | 2,292 | $1,146M | $1,156M |
| **Total** | 1,164 | 9,487 | **$3.47B** | **$3.39B** |

- After deduplication there are 2.79M Schedule A rows and 2.83M Schedule B rows.
- 168 EINs have overlapping periods that aren't exact duplicates (for example, monthly and quarterly reports covering the same months). That's at most $14.6M of extra double counting.
- At least $114M (3.3%) is transfers between 527s, matched by name. Examples: DGA → Protect Our Wisconsin $10.9M and DGA → Making Michigan's Future $8.7M.
- The money is concentrated: the top 10 organizations hold 64% of receipts, the top 25 hold 79% and the top 100 hold 94%.

## 2. Federal vs state/local
Form 8871 has an EXEMPT 8872 flag (qualified state/local organization), an EXEMPT STATE field, an EXEMPT 990 flag (caucus or association of state/local officials) and PURPOSE. The EAIN records carry the issuing state, with `FD` meaning federal. Very few 8872 filers set the exemption flags: of the organizations that filed an 8871 in 2023 or later, 9,802 claimed the state/local exemption and only 102 of those filed e-8872s. So for the top organizations I classified scope by hand, and for the long tail I used name and purpose keywords plus the EAIN state.

| Category | Orgs | Receipts | Share |
|---|---|---|---|
| National state-level committees (DGA, RGA, RSLC, RAGA, DAGA, DLCC, NDRC, DASS, judicial/DA groups) | 21 | $1,369M | 39.5% |
| ActBlue Non-Federal (state/local earmarks) + ActBlue Technical Services | 2 | $882M | 25.4% |
| Union/business nonfederal accounts (AFSCME, SEIU, AFT, NAR, UA, IBEW…) | 57 | $420M | 12.1% |
| Single-state groups (Garden State Forward, the Meta-funded CA group, NC Families First, MI/WI groups) | 54 | $261M | 7.5% |
| Other state/local (by keyword/EAIN) | 475 | $225M | 6.5% |
| National ideological/party-building (EMILY's List Non-Fed, GOPAC, Emerge, turnout groups) | 34 | $182M | 5.2% |
| Unclear | 394 | $117M | 3.4% |
| Legal defense funds | 13 | $8M | 0.2% |
| Federal-focused (mostly small campaign/exploratory committees) | 93 | $5M | 0.2% |

Top 25 by receipts (2023–26):

| $M | Org | Class |
|---|---|---|
| 537.0 | ActBlue Non-Federal | conduit to state/local candidates |
| 388.8 | Democratic Governors Association | governors |
| 344.9 | ActBlue Technical Services | ActBlue processing entity |
| 315.3 | Republican Governors Association | governors |
| 179.2 | Republican State Leadership Committee | state legislatures |
| 98.2 | AFSCME Working Families Fund | union nonfederal |
| 93.4 | Republican Attorneys General Assn | AGs |
| 91.4 | Democratic Attorneys General Assn | AGs |
| 89.0 | Democratic Legislative Campaign Committee | state legislatures |
| 81.5 | The PAC for America's Future | state legislatures |
| 59.7 | Garden State Forward | NJ |
| 58.3 | SEIU Political Ed & Action Fund | union nonfederal |
| 49.7 | EMILY's List Non-Federal | party-building, state + federal |
| 47.4 | GOPAC | GOP state candidate training |
| 45.0 | American Technology Excellence Project | CA state/local (Meta-funded) |
| 36.6 | AFT Solidarity 527 | union nonfederal |
| 32.9 | National Association of Realtors Fund | trade nonfederal |
| 26.9 | United Association Political Issues Fund | union nonfederal |
| 25.5 | Leadership PAC (Leadership for Educational Equity) | state/local |
| 24.6 | The Justice Project | judicial/prosecutor |
| 23.4 | North Carolina Families First | NC |
| 21.6 | Good Government Coalition | VA |
| 18.7 | Making Michigan's Future | MI |
| 18.1 | DAGA People's Lawyer Project | AGs |
| 17.5 | National Democratic Redistricting Committee | redistricting/state |

## 3. Overlap with FEC committees
Neither the site data nor the FEC bulk committee master (cm24/cm26) includes EINs, so all matching here is by normalized name using a port of `normalizeOrg`.
- **78 of the 1,164 organizations ($347M, 10%)** match a committee already on the site. **239 ($649M, 19%)** match some FEC committee name from 2024 or 2026.
- Most of these matches are the nonfederal account of a federal PAC or union, such as the NAR Fund, AFSCME WFF, IBEW, LGBTQ Victory Fund and Progressive Turnout Project. The money in those accounts is separate from the FEC-reported money, not a copy of it. The exception is small corporate PACs whose 8872s repeat their FEC filings; Self 4 Congress, for example, says its rows are "a summary of the records recorded in the FEC reports."
- What's genuinely new is about 925 organizations and about $2.8B, nearly all of it state-level.

## 4. Relevance to current members
**a. Schedule B spending naming members.** I scanned 2.83M deduplicated rows for three things:
- recipient names equal to a member's FEC campaign committee or leadership PAC name
- the member's full name in the recipient name
- the member's name, or surname plus office, in the purpose text

Raw matches: 1,845 rows, $6.5M, about 200 members. After removing vendor/generic-name collisions and namesakes:
- **Federal races: about $2.0M, about 140 members.** Almost all of it is $1k–$10k direct contributions from corporate or trade PACs that also report to the FEC (ND Petroleum Council, Energy Transfer, Transmission PAC, Sorghum PAC). The items that are genuinely new:
  - United Association Political Issues Fund: member communications for Brian Fitzpatrick, $1.37M
  - WE VOTE WE WIN–Nevada: canvassing for Susie Lee and Dina Titus, $138k
  - 30mm PAC: Wesley Hunt Victory Fund expenses, $62k
  - Central Valley Young Republicans: independent-expenditure mailer for Vince Fong, $18k
- **Members' own state/local races: about $0.9M, about 70 members.** These are payments to members' non-federal committees: Chuy García's mayoral committee via ActBlue Non-Federal ($419k), Friends of Mike Quigley ($164k), Byron Donalds' governor committee (RSLC $250k and others), Jon Husted for Ohio, and pre-Congress state campaigns of Aisha Wahab, Luz Rivas, Tim Moore and Kelly Morrison.

**Precision check (`precision_sample.json`).**
- Random sample of 24 matched rows: 22–23 were the right person, but only 5 were spending on the member's federal race. Most were small ActBlue earmarks to the member's state/local committee.
- Top 20 matched groups by dollars: 9/20 were the right person and 5/20 were federal-race spending. The 11 false positives were:
  - the vendor "The Strategy Group", whose name collides with a committee linked to Ron Johnson (6 groups, $2.6M)
  - "Freedom PA PAC", matched to both Crapo and Clyde
  - Oregon's "Evergreen PAC", matched to DelBene
  - a DGA staffer named James Gallagher
  - Tony Vargas's NE "Vargas for Congress", matched to Juan Vargas
- Name matching alone is not reliable enough to publish without hand curation.

**b. Who funds these 527s (Schedule A, 2.79M rows, $3.47B).**
- **Organizations on the site:** 1,683 matched, $503M total.
  - About 600 are businesses or unions, giving $347M. Their money goes mainly to DGA ($69M), RGA ($67M), ATEP ($45M, Meta), RSLC ($31M), RAGA ($21M), DAGA ($20M), DLCC ($18M) and GOPAC ($10M).
  - Examples: Meta $48.3M, Altria $12.4M, Vertex $7.4M, Elevance $7.1M, Molina $6.9M, Comcast $6.4M, Google $4.4M, Charter $4.3M, Amazon $3.9M.
  - The rest are party and ideological committees.
- **Large donors in donors.json:** 1,447 matched, $814M.
  - 872 individuals, matched by name and state, gave $221M. Examples: Bloomberg $32.8M, Miriam Adelson $15.0M, Deborah Simon $8.6M. A sample of 20 looked correct.
  - Donor organizations account for $403M and committees for $189M.
- This is the strongest and cleanest link to the site, but the recipients are state-level 527s.

**c. Members' own 527s.**
- 325 links were flagged by name, officer or related entity. The only real ones with 2023–26 money are Senate/House legal defense funds:
  - Senator Schiff Legal Defense Fund: $1.30M
  - Senator Mark Kelly Legal Defense Fund: $0.86M
  - Senator Slotkin Legal Defense Fund: $0.51M
  - Sanford Bishop 2020 Legal Expense Trust: $11k
  - Gallego's and Cuellar's funds are on file with $0.
- Self 4 Congress ($0.40M, 2023) mirrors FEC data.
- The rest are old state campaign committees with no recent money: Thune for Governor exploratory, Peters for AG 2002, Whitehouse, Merkley. "Menendez Legal Defense Fund" is the former senator's, not Rep. Rob Menendez's.
- I found no leadership-style 527s run by members with real money.

**d. National 527s, noted separately.** DGA $389M, RGA $315M, RSLC $179M, RAGA $93M, DAGA $91M (+$18M People's Lawyer Project), DLCC $89M, PAC for America's Future $82M, EMILY's List Non-Federal $50M, GOPAC $47M, NDRC $17.5M, Dem. Assn of Secretaries of State $15.5M. All of these work at the state level.

## 5. Data quality
- **Paper filings are missing, but they're small.** An 8872 must be filed electronically once an organization exceeds $50k in contributions or expenditures for the year, so every org big enough to matter is in the file. 4,850 orgs filed an 8871 in 2023 or later, didn't claim the state/local exemption, and have no e-filed 8872. Many look like junk or misfiled registrations (childcare businesses, LLCs), and each one is capped at under $50k a year.
- **The date fields are clean:**
  - 0 reports have begin > end.
  - Schedule A: 91 of 3.08M row dates fall outside their report period, and 24 amounts are negative.
  - Schedule B: 499 of 2.98M row dates fall outside their report period, and 12 amounts are negative.
- **Things to handle if this is built:** amendments, as above; overlapping periods ($14.6M); 527-to-527 transfers; ActBlue pass-through; and the 2026 data, which is incomplete because post-general and year-end reports haven't been filed yet.

## 6. Verdict: (B) build only a small piece
- **Build:** a short block on organization pages, e.g. "Also gave $X to state-level political groups (governors', attorneys general and legislative 527s), 2023–26." Use normalized-name matches to the 527 contributors, list the top recipients, and say clearly that this is state-level money.
- **Optional:** list a member's Senate/House legal defense fund and its donors on their page. That covers 3–4 members today.
- **Don't build:** a member-page "527s that spent on this race" section. It comes to about $2M, mostly duplicates of FEC data, with low precision from name matching.

## Files (`.cache/irs527/`)
`FullDataFile.txt` (unzipped, 3 GB), `orgs.jsonl`, `reports.tsv`, `sched_a.tsv`, `sched_b.tsv`, `parse_stats.json`, `dedupe_stats.json`, `orgs_2023_2026.json`, `scope_shares.json`, `transfers.json`, `member_sched_b_matches.json` (raw), `member_sched_b_clean.json`, `precision_sample.json`, `member_527s.json`, `donor_matches.json`, `cm24/cm26/ccl24/ccl26.txt` (FEC committee master and linkage files, read-only copies from the project-overhaul worktree's FEC cache).

## Reproducing

```sh
# The IRS full file (one request, ~370 MB): https://forms.irs.gov/app/pod/dataDownload/fullData → .cache/irs527/PolOrgsFullData.zip, unzipped
# FEC committee master and candidate-committee linkage files for 2024 and 2026 (cm24.txt, cm26.txt, ccl24.txt, ccl26.txt) in .cache/irs527/
python3 src/scripts/irs527/parse.py && python3 src/scripts/irs527/orgs.py && python3 src/scripts/irs527/members.py \
  && python3 src/scripts/irs527/donors.py && python3 src/scripts/irs527/transfers.py && python3 src/scripts/irs527/scope.py
```

Nothing from this assessment is on the site.
