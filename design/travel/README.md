# Privately sponsored travel

Trips that outside groups paid for, taken by current members of Congress and
their staff since the 119th Congress convened (January 3, 2025). Shipped as
`/travel/`, a page per sponsor (`/travel/sponsors/<slug>/`), a section on every
member page ("Trips paid for by outside groups") and on the organization pages
of sponsors that have one ("Trips it sponsored for members and staff").

Numbers below are from the build of November 16, 2026.

## Sources

| | House | Senate |
| --- | --- | --- |
| Where | Clerk of the House, [gift travel filings](https://disclosures-clerk.house.gov/GiftTravelFilings) | Secretary of the Senate, [gift rule travel database](https://www.senate.gov/legislative/Public_Disclosure/gift-rule-travel.htm) (`giftrule-disclosure.senate.gov`, not eFD) |
| Index | `public_disc/gift-pdfs/{year}Travel.zip`: XML/TSV with DocID, filer, member office, state and district, destination, dates, sponsor, original or amendment | `media/giftruledownloads/giftruledata.zip`: XML with filer, office, travel dates, received date, page count and PDF URL. **No sponsor, destination or cost.** |
| Filings | `gtimages/{MT,ST}/{year}/{DocID}.pdf` (MT member, ST staff), avg ~4 MB | `media/{year}/{id}.pdf`, scans of 20–40 MB |
| What's in a filing | traveler's post-travel form, sponsor's post-travel form (actual costs), the Ethics Committee's approval letter, and the pre-approval forms (traveler form, primary trip sponsor form with good-faith estimates, agenda) | RE-2 (staff) or RE-3 (senator) post-travel form with sponsor and actual costs, RE-1 pre-travel authorization with destination, sponsor certification, invitation, itinerary |
| Since Jan. 3, 2025 | 3,545 filings for current members' offices (416 offices; 99.3% of the index matched to a current member) | 834 filings (96 offices; 99.9% matched) |

The Ethics Committees' pre-approval forms aren't published separately; they're
inside each filing.

Access: one request at a time with the user agent `contributions.fyi research
(https://contributions.fyi)`, at least 2 seconds apart, no retries, cached
under `.cache/travel/`. Senate PDFs are fetched with one range request for
their first 8 MB (the server supports ranges): iText writes each page's image
in order, so that covers the post-travel and pre-travel forms in about a fifth
of the bytes (~6.7 GB instead of ~31 GB).

## Legal

These are filed under House Rule XXV, clause 5 and Senate Rule XXXV, and
published under sections 304 and 546 of the Honest Leadership and Open
Government Act of 2007. They are **not** financial disclosure reports under
5 U.S.C. chapter 131, so the § 13107 restrictions that apply to the holdings
pages don't apply here; the Clerk's and Senate's pages carry no use
restriction. The same trips also appear on members' annual financial
disclosure ("Travel" schedule), which *is* covered by § 13107; that schedule
isn't used. `/travel/` and the about page say so. The data is in
`data/travel.json` in the public repo.

## Reading costs

The cost is the sponsor's post-travel form, question 5: actual amounts per
traveler for transportation, lodging, meals and other, plus a row for an
accompanying relative (House). The pre-trip form's question 18 is an estimate,
and isn't used.

House, in order (`src/scripts/travel/house-parse.ts`, `house-read.ts`):

1. **Form fields.** Most sponsor forms are fillable PDFs; the amounts are field
   values (`Total Transportation ExpensesTraveler`, …), not page text.
2. **Text layer**, for flattened forms: the values in the "Traveler" row,
   assigned to columns by the x position of the four headings.
3. **OCR** (macOS Vision, `ocr.swift`) of the first pages when the sponsor
   form is a scan, or typed but with the amounts drawn rather than written as
   text. Same column logic on the OCR boxes. A scanned cost is kept only when
   two renders at different sizes read the same figures and every figure was
   read with its dollar sign: handwritten "$1052.53" read as "91052", and
   Vision reports full confidence either way.

Senate (`senate-pages.ts`, `senate-parse.ts`, `senate-read.ts`): page images
are decoded straight from the truncated PDF, OCR'd, and parsed by label
position. The forms are typed (printed from the Ethics Committee's travel
app), so they read cleanly. The Senate form has a single total that includes
an accompanying spouse or child; those trips are marked "incl. a relative".

| | House | Senate |
| --- | --- | --- |
| Cost read | 2,947 of 3,545 trips (83.1%) | 720 of 834 (86.3%) |
| … from form fields / text / scan | 1,159 typed (form fields or text) / 1,788 scans | all scans |
| Left out: scan failed the checks | 253 filings, plus 2 dropped by the build's last checks (a part over $30,000, or a total 4× off the others on the same trip) | — |
| Left out: form found, not read | 124 filings | 114 |
| No sponsor form in the filing | 41 filings; 1 filing 404s at both paths | — |
| Sponsor | 100% (index) | 97.5% (OCR) |
| Destination | 100% (index) | 50.8% (RE-1 when within the first pages, else a House filing with the same sponsor and dates) |

**Spot checks against the source documents** (rendered pages, by eye): House
scans 500029634, 500029640, 500029612 (with a family row), 500029613; House
text layer 500029683 (family row), 500031011 (two "other" items added up);
Senate 1NoVp0JQg0eqh7aH6mau7w, CcV90NE0SauY8XmjVJg, rhijDe340i7jSFCY3hMtA,
3lfHR4qcUUWnD9xLbHRYag ($38,264 incl. a spouse), 8BuqTbDankqWbUIsQ1Aj5w
($18,060 lodging). Every figure matched. The handwritten form 500031340 is the
case the dollar-sign rule exists for: it's left out. Two OCR errors found
this way and fixed in the reader: a wrapped "($254/night" joined onto "477.95"
(500034248, $254,477.95 for meals) and "$17.576.91" read as $17.57
(500033893); both are also caught by the build's last checks.

Screenshots: `01-travel-index-{light,dark}.png`, `02-sponsor-aief-light.png`,
`03-member-scalise-travel-{light,dark}.png`, `04-org-cta-travel-{light,dark}.png`,
`05-member-mobile-light.png`.

Amendments replace the filing they amend (same traveler and departure date).

## Sponsors and organizations

Sponsors are grouped by a strict key (case, punctuation, "Inc.", "The",
parenthetical acronyms ignored; "Fund" and "Committee" kept, so the
Commonwealth Fund isn't the "Commonwealth" PAC). Joint sponsors ("Aspen
Institute and the Rockefeller Foundation") are split only when every part is
a sponsor seen on its own. OCR'd Senate names are cleaned (Cyrillic
look-alikes, run-in dates and labels) and snapped to a House spelling when an
acronym for it or within a small edit distance.

**Matching to the site's organizations is rare: 13 sponsors,
290 (6.6%) of trips** (CTA, NCTA, RIAA, NAB, MPA, Microsoft, Club for
Growth, …). Most sponsors are nonprofits, think tanks, universities and
foundations without a PAC. Organizations named only after their committee
(`center-forward-c00568444`, a super PAC) are never matched: Center Forward the
nonprofit isn't its super PAC. An education fund or foundation affiliated
with a trade group stays separate. Hence a page for every sponsor.

## Pages

- `/travel/`: totals, how to read, sponsors by trips, trips by party of the
  office (with the seat split as a baseline), offices with the most trips,
  every sponsor (30, the rest lazy-loaded from
  `/fragments/travel/sponsors/`), coverage, legal note.
- `/travel/sponsors/<slug>/`: whose offices, where, every trip (25, the rest
  from `/fragments/travel/sponsors/<slug>/`), link to the organization page.
- Member pages: summary, sponsors chart (3+ sponsors), the 8 latest trips, the
  rest from `/fragments/members/<id>/travel/`.
- Organization pages: for the 13 matched sponsors.
- Cards: `travel/index` and `travel/<slug>` (`site/server/src/cards.ts`).
- Search: sponsors are a result type ("Trip sponsors").

What keeps it fair: the trips are described as approved and legal, every
member page says so; staff trips are labeled as staff; costs are "reported"
and only where read, with the count; party is shown next to the seat split.

## Refresh

```sh
tsx src/scripts/travel/fetch.ts          # new filings, both chambers
tsx src/scripts/travel/house-read.ts     # parse/OCR new House filings
tsx src/scripts/travel/senate-read.ts    # OCR new Senate filings
tsx src/scripts/travel/build.ts          # → data/travel.json
```

`swiftc -O src/scripts/travel/ocr.swift -o .cache/travel/ocr` first (macOS).

## Not done

- Trips by members who have left Congress; travel paid with official funds or
  by foreign governments (MECEA); members' annual-disclosure travel schedules.
- Handwritten House sponsor forms (left out, linked).
- Senate destinations beyond the first pages read (50.8% found).
