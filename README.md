# contributions.fyi

Who funds Congress: [contributions.fyi](https://contributions.fyi), a [Bluesky labeler](https://bsky.app/profile/contributions.fyi) that tags members of Congress with their top funding sectors and contributors, and a website for browsing the same data.

- `src/ingest/` pulls and joins the data into `data/*.json`
- `src/label-server.ts` is the labeler service Bluesky talks to
- `src/sync-labels.ts` brings the live labels in line with the data
- `site/` is the Astro website built from `data/`

## Data sources

| Source | Used for |
|---|---|
| [congress-legislators](https://github.com/unitedstates/congress-legislators) | Current members, IDs, committee seats, photos |
| [FEC bulk data](https://www.fec.gov/data/browse-data/?tab=bulk-data) | Campaign totals, PAC contributions, outside spending, individual and super PAC donations |
| [FEC API](https://api.open.fec.gov/developers/) | Leadership PAC sponsors |
| [SEC EDGAR](https://www.sec.gov/edgar) | Industry codes for public companies |
| [Lobbying disclosures](https://lda.gov/api/) | What organizations lobby on and spend, which PACs they run |
| Bluesky | Matching members to their accounts |

Contributions are counted by organization: an organization's total is its PAC plus donations from people who list it as their employer.

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

Meant to be run by hand every so often, e.g. on a machine at home. The first run downloads ~15 GB of FEC files and takes a few hours; later runs reuse the cache in `.cache/` and only refetch the current cycle.

```sh
pnpm ingest                    # everything, last 3 election cycles
pnpm ingest --steps=accounts   # just re-match Bluesky accounts
pnpm read-dms                  # pull account tips from the labeler's DMs (feeds account matching)
pnpm sync-labels               # dry run: what labels would change
pnpm sync-labels --apply       # publish the label changes
```

Steps: `accounts`, `assignments`, `fec`, `committees`, `lobbying`, `individuals`, `donors`. Each caches its work, so an interrupted run picks up where it stopped.

Manual corrections:

- `data/account-overrides.json`: `{ "<bioguide>": { "include": ["handle or did"], "exclude": [...] } }`
- `data/committee-overrides.json`: `{ "<FEC committee id>": { "sector": "...", "industry": "...", "name": "..." } }`

Accounts the matcher wasn't sure about, and PACs it couldn't classify, are listed in `data/review.json` and the ingest output.

## Open data

The dataset is published as atproto records in its own repo, [@data.contributions.fyi](https://bsky.app/profile/data.contributions.fyi) (`did:plc:ej5cllsvxdrzdsweyfgr2nge`), on our PDS at `pds.contributions.fyi`. Anyone can download it with standard atproto tooling and no API key. Lexicons are in `lexicons/fyi/contributions/`; see [contributions.fyi/open-data](https://contributions.fyi/open-data/) for the user-facing version.

| Collection | Record key | |
|---|---|---|
| `fyi.contributions.dataset` | `self` | metadata, plus the complete `data/*.json` files as gzipped blobs |
| `fyi.contributions.account` | Bluesky DID | who funds this account: a member's summary, linking to their member record |
| `fyi.contributions.member` | bioguide id | |
| `fyi.contributions.committee` | FEC committee id | |
| `fyi.contributions.organization` | organization id | |
| `fyi.contributions.donor` | donor id | |
| `fyi.contributions.congressCommittee` | Thomas id | |
| `com.atproto.lexicon.schema` | NSID | the lexicons, for [resolution](https://atproto.com/specs/lexicon#lexicon-publication-and-resolution) (`_lexicon.contributions.fyi`) |

Records link to each other by at-uri, in `uri` fields next to the ids: members to their organizations, PACs, outside spenders, committee seats and accounts; PACs to their organization, sponsors, recipients and donors; donors to the PACs they gave to; organizations to their PACs. A few record keys differ from the id (the PDS's name filter rejects them, so they use underscores), so follow the links rather than building them. Amounts in records are whole dollars (the atproto data model has no floats); the files keep cents. FEC, SEC and LDA data are public domain; our classifications and matching are CC0.

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
railway run --service pds -- pnpm publish-records          # dry run: what would change
railway run --service pds -- pnpm publish-records --apply  # write it
```

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

## Website

```sh
pnpm photos        # official portraits (not committed)
pnpm site:dev
pnpm site:build
```

## Deployment (Railway)

- **Labeler** (`us-gov-contributions-labeler` service): built from the root `Dockerfile`, with the label database on the `/sqlite-data` volume (`DB_PATH`).
- **Website** (`website` service): built from `site/Dockerfile` (`RAILWAY_DOCKERFILE_PATH=site/Dockerfile`).
- **Feeds** (`feeds` service): built from `feeds/Dockerfile`, with its SQLite database on a volume at `/data`.
- **Lists** (`sync-lists` service): a cron job, daily at 15:00 UTC, built from `src/sync-lists.Dockerfile` with the data baked in; `LABELER_PASSWORD` references the labeler's.

`pnpm dedupe-labels` is a one-off cleanup for duplicate label events in the labeler's database; run it on the labeler service (`railway ssh`).
