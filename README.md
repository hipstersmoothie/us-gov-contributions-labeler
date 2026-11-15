# US Gov Contributions Labeler

Who funds Congress: a [Bluesky labeler](https://bsky.app/profile/us-gov-funding.bsky.social) that tags members of Congress with their top funding sectors and contributors, and a website for browsing the same data.

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

## Website

```sh
pnpm photos        # official portraits (not committed)
pnpm site:dev
pnpm site:build
```

## Deployment (Railway)

- **Labeler** (`us-gov-contributions-labeler` service): built from the root `Dockerfile`, with the label database on the `/sqlite-data` volume (`DB_PATH`).
- **Website** (`website` service): built from `site/Dockerfile` (`RAILWAY_DOCKERFILE_PATH=site/Dockerfile`).

`pnpm dedupe-labels` is a one-off cleanup for duplicate label events in the labeler's database; run it on the labeler service (`railway ssh`).
