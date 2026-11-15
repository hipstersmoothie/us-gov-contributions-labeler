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

Contributions are counted the way OpenSecrets did: an organization's total is its PAC plus donations from people who list it as their employer.

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

The dataset is published in the labeler's atproto repo (`did:plc:ylmdlijvrvgbe4md6v4dyce6`), so anyone can download it with standard atproto tooling and no API key. Lexicons are in `lexicons/fyi/contributions/`; see [contributions.fyi/open-data](https://contributions.fyi/open-data/) for the user-facing version.

| Collection | Record key | |
|---|---|---|
| `fyi.contributions.dataset` | `self` | metadata, plus the complete `data/*.json` files as gzipped blobs |
| `fyi.contributions.member` | bioguide id | |
| `fyi.contributions.committee` | FEC committee id | |
| `fyi.contributions.organization` | organization id | |
| `fyi.contributions.donor` | donor id | |
| `fyi.contributions.congressCommittee` | Thomas id | |
| `com.atproto.lexicon.schema` | NSID | the lexicons, for [resolution](https://atproto.com/specs/lexicon#lexicon-publication-and-resolution) |

Amounts in records are whole dollars (the atproto data model has no floats); the files keep cents. FEC, SEC and LDA data are public domain; our classifications and matching are CC0.

Getting it:

```sh
# everything: the dataset record, then each file it links
DID=did:plc:ylmdlijvrvgbe4md6v4dyce6
curl -s "https://bsky.social/xrpc/com.atproto.repo.getRecord?repo=$DID&collection=fyi.contributions.dataset&rkey=self" |
  jq -r '.value.files[] | "\(.name) \(.blob.ref["$link"])"' |
  while read -r name cid; do
    curl -sL "https://bsky.social/xrpc/com.atproto.sync.getBlob?did=$DID&cid=$cid" | gunzip > "${name%.gz}"
  done

# single records, or the whole repo, with goat
goat get at://contributions.fyi/fyi.contributions.member/C000127
goat repo export contributions.fyi -o contributions.car && goat repo unpack contributions.car

# plain XRPC
curl "https://bsky.social/xrpc/com.atproto.repo.listRecords?repo=$DID&collection=fyi.contributions.member&limit=100"
```

Publishing, after an ingest:

```sh
pnpm publish-records                  # dry run: what would change, and how many rate-limit points it costs
pnpm publish-records --apply          # write it; stops at the rate limit, re-run to continue
pnpm publish-records --apply --wait   # or wait out each hourly window
```

It writes only records whose content changed and deletes records for entities that are gone. The PDS allows 5,000 write points an hour and 35,000 a day (create 3, update 2, delete 1), shared with the labeler's own writes, so the script always leaves `--reserve` (default 1,000) points unspent. A first publish of all ~18,500 records is ~55,000 points: about 14 hours over 2 days. For testing, `--collections=schema,dataset,member --limit=5` publishes 5 members and never deletes. Needs `LABELER_PASSWORD`, e.g. `railway run --service us-gov-contributions-labeler -- pnpm publish-records --apply`.

## Bluesky lists and starter packs

`pnpm sync-lists` keeps the labeler account's lists in line with `data/`: "Congress on Bluesky" (everyone), one per state delegation with 2+ members on Bluesky, one per full committee with 3+, and the top 25 recipients of each sector's money (`combinedSectors`). Starter packs hold at most 150 accounts, so there are three: the Senate, and the House split into Northeast & South and Midwest & West, each with one account per member plus the labeler.

```sh
pnpm sync-lists                          # dry run: what would change, and how many points it costs
pnpm sync-lists --apply                  # write it; stops at 70% of the rate-limit window, re-run to continue
pnpm sync-lists --apply --wait           # or wait out each hourly window
pnpm sync-lists --apply --only=state-de  # just these lists (keys are in the dry-run output)
```

Run it after an ingest, with `LABELER_PASSWORD` (e.g. `railway run --service us-gov-contributions-labeler -- pnpm sync-lists --apply`). It adds and removes list items, updates names and descriptions, and deletes its own lists that no longer qualify. Record keys are derived from each list's key, so URLs stay stable. The old hand-made "US Government Officials" list is renamed as archived but keeps its members, because the account matcher reads it. A full first run is about 6,300 points (about 2 hours at 70% of 5,000 an hour); later runs only write what changed.

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

`pnpm dedupe-labels` is a one-off cleanup for duplicate label events in the labeler's database; run it on the labeler service (`railway ssh`).
