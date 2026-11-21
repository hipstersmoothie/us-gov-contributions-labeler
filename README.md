# contributions.fyi

Who funds Congress: [contributions.fyi](https://contributions.fyi), a [Bluesky labeler](https://bsky.app/profile/contributions.fyi) that tags members of Congress with their top funding sectors and contributors and their shares from small donors and in-state donors, and a website for browsing the same data.

- `src/ingest/` pulls and joins the data into `data/*.json`
- `src/label-server.ts` is the labeler service Bluesky talks to
- `src/sync-labels.ts` brings the live labels in line with the data
- `site/` is the Astro website built from `data/`; its server (`site/server`) also hosts an [MCP](https://modelcontextprotocol.io) server at [contributions.fyi/mcp](https://contributions.fyi/mcp/) for AI assistants: search, page records (House members' investments included, with their § 13107 notice, and bulk access only after the user agrees to its terms), who represents a ZIP or address, and SQL over everything, including the open data's filing-level files, which `site/scripts/mcp-data.ts` fetches from the PDS at build time

## Data sources

| Source | Used for |
|---|---|
| [congress-legislators](https://github.com/unitedstates/congress-legislators) | Current members, IDs, committee seats, photos |
| [FEC bulk data](https://www.fec.gov/data/browse-data/?tab=bulk-data) | Campaign totals, PAC contributions, outside spending, individual and super PAC donations |
| [FEC API](https://api.open.fec.gov/developers/) | Leadership PAC sponsors |
| [SEC EDGAR](https://www.sec.gov/edgar) | Industry codes for public companies |
| [Lobbying disclosures](https://lda.gov/api/) | What organizations lobby on and spend, which PACs they run, lobbyists' former government jobs |
| [FARA bulk data](https://efile.fara.gov/ords/fara/f?p=API:BULKDATA) | Foreign agents, their foreign principals by country, and (with FEC itemized records) their donations |
| [House Clerk gift travel](https://disclosures-clerk.house.gov/GiftTravelFilings) and [Senate gift rule travel](https://www.senate.gov/legislative/Public_Disclosure/gift-rule-travel.htm) filings | Trips paid for by outside groups (`src/scripts/travel/`, `data/travel.json`; see `design/travel/README.md`) |
| [IRS political organization filings](https://www.irs.gov/charities-non-profits/political-organizations/political-organization-filing-and-disclosure) | Organizations' gifts to state-level 527 groups, members' legal defense funds (`src/scripts/irs527/`, `data/irs527.json`; see `design/irs527/README.md`) |
| Bluesky | Matching members to their accounts |

Contributions are counted by organization: an organization's total is its PAC, donations from people who list it as their employer, and donations earmarked through its PAC (sent to a campaign through the PAC, as with AIPAC or J Street; payment platforms like ActBlue and WinRed don't count).

## Setup

```sh
pnpm install
cp .env.example .env   # then fill it in
```

`.env`:

| Variable | Needed for |
|---|---|
| `FEC_API_KEY` | `ingest` ([free key](https://api.data.gov/signup/)) |
| `LDA_API_KEY` | `ingest` (free key from lda.gov; works without, much slower) |
| `SEC_USER_AGENT` | `ingest` (SEC requires a contact, e.g. `name you@example.com`) |
| `LABELER_PASSWORD` | `sync-labels --apply` |
| `SITE_URL` | link from label descriptions to the website |
| `BSKY_DM_APP_PASSWORD` | `read-dms` (app password with DM access) |

## Refreshing the data

A launchd job on the maintainer's Mac runs this weekly, then syncs the labels and publishes the open data, with checks that stop it before anything looks wrong goes public: see [design/refresh/README.md](design/refresh/README.md). By hand: the first run downloads ~15 GB of FEC files and takes a few hours; later runs reuse the cache in `.cache/` and refetch a bulk file only when fec.gov's copy changed (`pnpm fec-audit` lists the cached files that are out of date).

```sh
pnpm ingest                    # everything, last 3 election cycles
pnpm ingest --steps=accounts   # just re-match Bluesky accounts
pnpm read-dms                  # pull account tips from the labeler's DMs (feeds account matching)
pnpm sync-labels               # dry run: what labels would change
pnpm sync-labels --apply       # publish the label changes
```

Steps: `accounts`, `assignments`, `fec`, `committees`, `lobbying`, `individuals`, `donors`, `legislation`, `revolving`, `fara`, `races`. Each caches its work, so an interrupted run picks up where it stopped. `legislation`, `revolving` and `fara` only need what's already in `data/`, so they can run on their own (`--steps=revolving,fara`); `revolving` reads the same cached LD-1/LD-2 filings as `legislation`.

The revolving-door matches are checked by hand on a random sample: `tsx src/scripts/review-revolving.ts sample 150 50`, then `show`, then `wrong <numbers>`; the about page reports the result from `data/revolving-door-review.json`.

`races` writes `data/races-<year>.json` for each election with a `data/elections-<year>.json` (dates, redistricting, primary systems, certification calendar): every House and Senate race and candidate on the November ballot, from the fec step's cache plus `cn`, `ccl`, `weball`, `pas2` and `indiv`, with the FEC's ballot list and official results once published. Certified results are entered with `pnpm race-results` (status, add, check, import), each checked against its official source. See [design/races/README.md](design/races/README.md) for how it works, what to do each election cycle, and the checklist for each new Congress. Members who leave Congress move from `data/members.json` to `data/former-members.json` on the next run, so their pages stay up; the labeler, lists and feeds only read `members.json`.

Manual corrections:

- `data/account-overrides.json`: `{ "<bioguide>": { "include": ["handle or did"], "exclude": [...] } }`
- `data/committee-overrides.json`: `{ "<FEC committee id>": { "sector": "...", "industry": "...", "name": "..." } }`
- `data/race-results-<year>.json`: certified results, entered with `pnpm race-results add`, each with its official source
- `data/elections-<year>.json`: one election's dates, redistricting, primary systems and certification calendar (see design/races/README.md, "Each cycle")

Accounts the matcher wasn't sure about, and PACs it couldn't classify, are listed in `data/review.json` and the ingest output.

## Open data

The dataset is published as atproto records in its own repo, [@data.contributions.fyi](https://bsky.app/profile/data.contributions.fyi) (`did:plc:ej5cllsvxdrzdsweyfgr2nge`), on our PDS at `pds.contributions.fyi`. Anyone can download it with standard atproto tooling and no API key. Lexicons are in `lexicons/fyi/contributions/`; see [contributions.fyi/open-data](https://contributions.fyi/open-data/) for the user-facing version.

| Collection | Record key | |
|---|---|---|
| `fyi.contributions.dataset` | `self` | metadata, plus the complete data files as gzipped blobs (below) |
| `fyi.contributions.account` | Bluesky DID | who funds this account: a member's summary, linking to their member record |
| `fyi.contributions.member` | bioguide id | |
| `fyi.contributions.committee` | FEC committee id | |
| `fyi.contributions.organization` | organization id | |
| `fyi.contributions.donor` | donor id | |
| `fyi.contributions.congressCommittee` | Thomas id | |
| `fyi.contributions.foreignCountry` | country slug | FARA foreign principals and their US agents |
| `com.atproto.lexicon.schema` | NSID | the lexicons, for [resolution](https://atproto.com/specs/lexicon#lexicon-publication-and-resolution) (`_lexicon.contributions.fyi`) |

Records link to each other by at-uri, in `uri` fields next to the ids: members to their organizations, PACs, outside spenders, committee seats and accounts; PACs to their organization, sponsors, recipients and donors; donors to the PACs they gave to; organizations to their PACs. A few record keys differ from the id (the PDS's name filter rejects them, so they use underscores), so follow the links rather than building them. Amounts in records are whole dollars (the atproto data model has no floats); the files keep cents. FEC, SEC and LDA data are public domain; our classifications and matching are CC0.

The dataset record's files:

| File | |
|---|---|
| `*.json` | the data files the site is built from, minified |
| `contributions.sqlite` | the same JSON as tables: a table per kind of record and per list inside them (`members`, `members_sectors`, `committees_recipients`, ...), described in its `tables` table, with views `pac_contributions`, `outside_spending` and `member_votes`. Built by `src/lib/sqlite-tables.ts` without a schema, so new fields in `data/` show up on their own; which files and lists go in is set in `src/lib/sqlite-files.ts` |
| `fec-lines.sqlite` | every FEC line counted toward members' totals, as filed: the fec step writes them to `.cache/fec/<cycle>/lines.jsonl`, and they sum to the totals |
| `lobbying-filings.sqlite` | every LD-1/LD-2 filing of the current Congress, from the legislation step's cache (`.cache/legis/ld2`), linked to organizations the way the legislation and revolving steps match them |

The last two are separate files because, gzipped, each has to stay under the PDS's 100 MB blob limit (`PDS_BLOB_UPLOAD_LIMIT`); they're about 30 MB and 55 MB now. Individual donors are only in them as totals, as on the site.

Getting it:

```sh
PDS=https://pds.contributions.fyi
DID=did:plc:ej5cllsvxdrzdsweyfgr2nge

# who funds this Bluesky account? (RecordNotFound if it isn't a member's)
curl "$PDS/xrpc/com.atproto.repo.getRecord?repo=$DID&collection=fyi.contributions.account&rkey=did:plc:e3ap6sjaftiof33z6xjt54aa"

# everything: the dataset record, then each file it links
curl -s "$PDS/xrpc/com.atproto.repo.getRecord?repo=$DID&collection=fyi.contributions.dataset&rkey=self" |
  jq -r '.value.files[] | "\(.name) \(.blob.ref["$link"])"' |
  while read -r name cid; do
    curl -s "$PDS/xrpc/com.atproto.sync.getBlob?did=$DID&cid=$cid" | gunzip > "${name%.gz}"
  done

# single records, or the whole repo, with goat
goat get at://data.contributions.fyi/fyi.contributions.member/C000127
goat repo export data.contributions.fyi -o contributions.car && goat repo unpack contributions.car

# plain XRPC
curl "$PDS/xrpc/com.atproto.repo.listRecords?repo=$DID&collection=fyi.contributions.member&limit=100"
```

Publishing, after an ingest:

```sh
pnpm build-sqlite                                          # the SQLite files, in .cache/open-data/
railway run --service pds -- pnpm publish-records          # dry run: what would change
railway run --service pds -- pnpm publish-records --apply  # write it
```

`publish-records` builds `contributions.sqlite` itself. The two source files need the ingest cache, so they're only rebuilt on a machine that ran the fec and legislation steps (`pnpm build-sqlite --only=fec,lobbying`); elsewhere the published ones are kept. Files are uploaded only when their SHA-256 changes, and the SQLite builds are byte-for-byte reproducible from the same inputs.

It writes only records whose content changed and deletes records for entities that are gone, so a refresh takes a minute or two; an interrupted run picks up where it stopped. For testing, `--collections=schema,dataset,member --limit=5` publishes 5 members and never deletes. Needs `DATA_PASSWORD` (a variable on the `pds` service). `DATA_PDS_URL` overrides the PDS address, e.g. `https://pds-production.up.railway.app`. Our PDS doesn't rate-limit writes. Against a PDS that does, the script reads the budget from the response headers and leaves `--reserve` points unspent.

### The PDS

The `pds` Railway service runs the official `ghcr.io/bluesky-social/pds` image with its data on a volume at `/pds`. Its secrets (`PDS_JWT_SECRET`, `PDS_ADMIN_PASSWORD`, `PDS_PLC_ROTATION_KEY_K256_PRIVATE_KEY_HEX`) and `DATA_PASSWORD` exist only as Railway variables. It hosts one account, `data.contributions.fyi`, and invites are required. `PDS_CRAWLERS=https://bsky.network` makes it ask the Bluesky relay to crawl it after writes.

## Bluesky lists and starter packs

`pnpm sync-lists` keeps the labeler account's lists in line with `data/`: "Congress on Bluesky" (everyone), one per state delegation with 2+ members on Bluesky, one per full committee with 3+, and the top 25 recipients of each sector's money (`combinedSectors`). Starter packs hold at most 150 accounts, so there are three: the Senate, and the House split into Northeast & South and Midwest & West, each with one account per member plus the labeler.

```sh
pnpm sync-lists                          # dry run: what would change, and how many points it costs
pnpm sync-lists --apply                  # write it; stops at 70% of the rate-limit window, re-run to continue
pnpm sync-lists --apply --wait           # or wait out each hourly window
pnpm sync-lists --apply --only=state-de  # just these lists (keys are in the dry-run output)
```

The `sync-lists` Railway service runs it daily (see Deployment), so a data refresh pushed to `main` reaches the lists by the next run. To run it by hand, it needs `LABELER_PASSWORD`, e.g. `railway run --service us-gov-contributions-labeler -- pnpm sync-lists --apply`. It adds and removes list items, updates names and descriptions, and deletes its own lists that no longer qualify. Record keys are derived from each list's key, so URLs stay stable. The old hand-made "US Government Officials" list is renamed as archived but keeps its members, because the account matcher reads it. A full first run is about 6,300 points (about 2 hours at 70% of 5,000 an hour); later runs only write what changed.

## Feeds

`feeds/` is a Bluesky feed generator (`did:web:feeds.contributions.fyi`) for posts by members of Congress, published from @contributions.fyi. The feeds are defined in `feeds/feeds.ts`: everyone, the Senate, the House, and one per sector for members whose top 3 funding sectors (the same ones on their labels) include it. They show original posts and quote posts, not replies or reposts.

It follows members' accounts on Jetstream, keeps 30 days of posts in SQLite, and backfills new accounts from the AppView. It reads `data/members.json` from `main` on GitHub at startup and every hour (`MEMBERS_URL`, `REFRESH_MINUTES`), so pushing new data updates the feeds without a redeploy.

```sh
pnpm feeds                           # run locally on :3000 (DATA_DIR=.cache/feeds)
pnpm feeds:publish                   # dry run: the feed generator records
pnpm feeds:publish --apply           # write them; needs LABELER_PASSWORD and a live did.json
```

## Posts

`posts/` posts to Bluesky as @contributions.fyi on its own: series of posts written from templates out of the data on `main` (see [design/posts/README.md](design/posts/README.md)). So far:
- `member-elect`: a post per certified winner new to their chamber
- `new-on-bluesky`: a post when a member's first account is matched

It reloads the data every 5 minutes. Each post has a key that makes it happen once. At most 2 go out a day across every series (`MAX_PER_DAY`), at least 4 hours apart, between 8 a.m. and 9 p.m. Eastern. A post waits until its page on the site says what the post says. Member-elect posts follow `races-<year>.json`, so they go out after `pnpm ingest --steps=races` is pushed.

```sh
pnpm posts:preview                    # what each series would post, from local data/
pnpm posts:preview --since=HEAD~5     # including members newly on Bluesky since that commit
pnpm posts:preview --pages            # with each link card, from the live site
pnpm posts --dry --once               # the service against main's data, posting nothing
```

On Railway it's the `posts` service, built from `posts/Dockerfile`, with its SQLite database on a volume at `/data`. Variables:
- `POSTS_APP_PASSWORD`: an app password for @contributions.fyi
- `POSTS_MEMBER_ELECT`, `POSTS_NEW_ON_BLUESKY`: `on` (the default), `off`, or `dry` to log instead of post

## Website

```sh
pnpm photos            # official portraits (not committed)
pnpm bluesky-profiles  # members' Bluesky avatars and follower counts, for /bluesky/
pnpm site:dev
pnpm site:build
pnpm --filter site start   # serve the build, with link-preview images, on :3000
```

The `/bluesky/` page links to the lists, starter packs and feeds using the same code that publishes them (`src/lib/list-specs.ts`, `feeds/feeds.ts`), and shows each member's labels from `memberLabels()` in `src/lib/labels.ts`, so it always matches what's live. Profile data comes from the public AppView, read-only. The website's Docker build fetches it fresh on every deploy and falls back to the committed `data/bluesky-profiles.json` if that fails.

In production the site is served by `site/server`, a small Node server: it serves `site/dist` the way `serve` did (same trailing-slash handling, 404 page, ETags and compression) and renders each page's link-preview card on request at `/og/<version>/<type>/<id>.png`. The build writes no images: `site/scripts/og-cards.ts` runs before `astro build` and writes a small record per page to `site/server/data/cards.json`, which the server renders with satori and resvg in the site's fonts (static instances in `site/server/fonts`). `<version>` is a hash of the card records and templates, so images are cached for a year and a new build gets new URLs. To look at cards without the server: `node site/server/src/sample.ts out-dir member/S000033 pac/C00504530`, or `--bench 200` to time a random sample.

**Search engines.** `site/scripts/sitemap.ts` writes the sitemaps and `robots.txt` after the build. A page's `<lastmod>` is when its text last changed: the build fingerprints each page's title, description and `<main>` text and compares them with the live build's, from `contributions.fyi/data/pages.json` (or `PREVIOUS_PAGES`, a URL or file). Unchanged pages keep their date, changed and new ones get the build's. When the live copy can't be fetched, every page is dated by the data and counts as changed. Once a new deployment is serving the site, the server sends the changed and removed URLs to [IndexNow](https://www.indexnow.org/) (Bing, Yandex and others; `site/server/src/indexnow.ts`), using the key file in `site/public/`. It sends nothing for a build more than 6 hours old or a build that never goes live (a local preview); `INDEXNOW=off` turns it off. `www.contributions.fyi` redirects to `contributions.fyi`.

### Finding your member: ZIP codes, addresses and districts

The finder (`/find/` and the home page, `site/src/islands/find/`) maps a ZIP code to districts from `data/districts/<congress>.json`, built by `pnpm zip-districts` from the Census Bureau's ZCTA-to-congressional-district relationship file and committed so the site build doesn't depend on census.gov. The build splits it into one small file per three-digit prefix (`/data/zips/<congress>/850.json`), loaded only when someone looks up a ZIP, plus each state's delegation (`/data/delegations/az.json`). A ZIP that crosses district lines shows every district it touches with each one's share of the ZIP's land area (slivers under 1% are named, not carded). PO box and business ZIPs the Census doesn't map fall back to their prefix's state. A street address goes to `POST /api/district` on `site/server` (`geocode.ts`), which asks the Census Geocoder and returns the district. Addresses travel only in the request body: they never appear in a URL, the request log, analytics or storage. The proxy rate-limits by client (20 per 10 minutes) and overall, and when the geocoder fails the finder falls back to the ZIP.

**Districts and the next Congress.** District maps are versioned by Congress. Members represent the districts they were elected from, so the site uses the map for the Congress in `data/members.json`, even after states redraw for the next election (Texas, California and others did for 2026). The Census Geocoder's "Current" vintage moves to the new map before those members take office (it returned 120th Congress districts by November 2026), so each Congress is pinned to a geocoder vintage and layer, and every answer's layer name is checked. To switch to the 120th Congress once its members are in `data/members.json` (January 2027):

1. In `src/lib/districts.ts`, add `120` to `DISTRICT_MAPS` (the Census `tab20_cd12020_zcta520_natl.txt` relationship file, once published; the geocoder vintage and layer) and set `CONGRESS = 120`.
2. Check `LAYERS[120]` in `site/server/src/geocode.ts` against the geocoder (`/geocoder/vintages?benchmark=Public_AR_Current`), and keep it in step with `DISTRICT_MAPS`.
3. Run `pnpm zip-districts` and commit `data/districts/120.json`. The page text, ZIP file URLs and the in-district donor estimates in `pnpm ingest` all follow `CONGRESS`. The build warns if a House member's district isn't on the map, which is how a mismatch between members and map shows up.

## Deployment (Railway)

- **Labeler** (`us-gov-contributions-labeler` service): built from the root `Dockerfile`, with the label database on the `/sqlite-data` volume (`DB_PATH`).
- **Website** (`website` service): built from `site/Dockerfile` (`RAILWAY_DOCKERFILE_PATH=site/Dockerfile`), running `site/server`.
- **Feeds** (`feeds` service): built from `feeds/Dockerfile`, with its SQLite database on a volume at `/data`.
- **Lists** (`sync-lists` service): a cron job, daily at 15:00 UTC, built from `src/sync-lists.Dockerfile` with the data baked in; `LABELER_PASSWORD` references the labeler's.
- **Lobbying refresh** (`refresh-lobbying` service): a cron job, Mondays at 09:00 UTC, built from `src/refresh-lobbying.Dockerfile`. It reruns `pnpm ingest --steps=revolving,fara` on main's data and pushes `data/revolving-door.json` and `data/fara.json` back to main when they change (which redeploys the site). The LD-1/LD-2 filings and FEC bulk files it reads are cached on a volume at `/cache`; a cold cache takes about five hours, a weekly run one to two. Variables: `LDA_API_KEY`, and `DEPLOY_KEY`, the private half of the repo's "refresh-lobbying (Railway cron)" deploy key (write access).

`pnpm dedupe-labels` is a one-off cleanup for duplicate label events in the labeler's database; run it on the labeler service (`railway ssh`).
