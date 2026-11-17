# Weekly main-data refresh

A launchd job on this Mac re-ingests the main data every week, checks it,
pushes `data/` to main, syncs the labels and publishes the open-data records.
It runs here, not on Railway, because it needs the FEC bulk files (about 12 GB
of individual donations a cycle).

| What | When | Where |
| --- | --- | --- |
| Sponsored travel | Mondays 07:00 local | this Mac, `fyi.contributions.travel-refresh` |
| Lobbying, revolving door, FARA | Mondays 09:00 UTC | Railway cron `refresh-lobbying` |
| **Main data, labels, open data** | **Tuesdays 01:00 local (09:00 UTC)** | **this Mac, `fyi.contributions.main-refresh`** |
| Bluesky lists | daily 15:00 UTC | Railway cron `sync-lists` |
| 527 groups | monthly | Railway cron `refresh-527` |

Tuesday night runs after Monday's travel and lobbying pushes, so it publishes
their data too, and finishes hours before the 15:00 UTC list sync, so lists
and labels come from the same data. launchd runs a missed job when the Mac
wakes; if it was asleep all night, the run can land after that day's list
sync. The lists then catch up the next day. Nothing breaks, they're one day
behind the labels.

## Each run

`run.sh` (outside the repo, written by `install.sh`) takes a lock, resets the
clone to `origin/main` and runs `src/scripts/refresh/refresh.sh`:

1. `pnpm ingest --steps=accounts`, then `accounts-guard.ts`: new matches the
   matcher accepts are kept (`data/accounts.json` only ever holds "accepted"
   matches; "review" candidates go to the untracked `data/review.json`). An
   account the matcher dropped is put back and listed in the run's summary.
   To drop one for real, add it to `exclude` in `data/account-overrides.json`
   or remove it by hand.
2. `pnpm ingest --steps=assignments,fec,bundling,committees,lobbying,individuals,donors,legislation`
   (`pnpm ingest` allows Node a 12 GB heap: three complete cycles of
   individual donations outgrow the default 4 GB).
   Bulk files are refetched only when fec.gov's copy changed (below). The
   revolving door and FARA are left to the Railway job.
3. `check-data.ts`. It stops the run before anything is pushed if:
   - the member count moves by more than 3,
   - total PAC, individual or receipts money drops more than 5% (over the
     cycles both versions cover),
   - itemized individual donations drop more than 5%,
   - any `data/*.json` shrinks by more than 25% or stops parsing.
   - an organization id disappears while a file the run doesn't rebuild
     (`legislation.json`, `revolving-door.json`, `irs527.json`, ...) still
     points at it.
4. `pnpm site:build`.
5. Commits the changed `data/*.json`, ignoring files where only `generatedAt`
   changed, then `git pull --rebase` and push to main, three tries. It never
   force-pushes. A rebase conflict means someone else regenerated the same
   file; the run stops there for a person.
6. `sync-labels --apply --max-accounts=40` via `railway run -s
   us-gov-contributions-labeler`. If more than 40 accounts would change, or
   any account would lose all its labels, nothing is applied: the plan is in
   the clone's `.cache/label-plan.json` and the run exits 3.
7. `pnpm build-sqlite --only=fec,lobbying`: the open data's source files
   (FEC lines, lobbying filings) from this run's cache. If it fails, the
   published ones are kept.
8. `publish-records --apply` via `railway run -s pds`. It writes only
   differences, and skips deletes when more than 10% of a collection would go.
   Files are uploaded only when they changed.

Steps 6 and 8 retry up to three times, 30 seconds apart: Railway's API and
the labeler drop connections now and then, and both scripts only send
differences, so a retry picks up where the last try stopped.

On an error or a stop, and when labels are held, you get a macOS
notification.

**Holdings are not in the job.** `pnpm holdings` reads paper filings with a
paid second reader, and new filings wait for a person in `pnpm review-scans`.
The free parts alone (fetching and indexing new filings) would only fill the
review queue, and the published file doesn't change until someone reviews and
runs `pnpm holdings:publish`, so running them unattended gains nothing. Run
holdings by hand.

## Install, run, uninstall

```sh
# install (first time: seed the clone's .cache, .env and dm-leads from a checkout that has run the ingest)
zsh src/scripts/refresh/install.sh "/path/to/checkout"
# re-install after changing install.sh (keeps the clone and its cache)
zsh src/scripts/refresh/install.sh

# run it now
launchctl kickstart gui/$(id -u)/fyi.contributions.main-refresh
# or in the foreground
"$HOME/Library/Application Support/contributions-fyi/main-refresh/run.sh"
# everything but push, labels and publish, in the clone
cd "$HOME/Library/Application Support/contributions-fyi/main-refresh/repo" && DRY_RUN=1 zsh src/scripts/refresh/refresh.sh

# is it loaded / running?
launchctl print gui/$(id -u)/fyi.contributions.main-refresh | grep -E "state|last exit"

# uninstall (keeps the clone and caches)
zsh src/scripts/refresh/install.sh --uninstall
```

## Logs

`~/Library/Application Support/contributions-fyi/main-refresh/logs/`, one
`YYYY-MM-DD-HHMM.log` per run, the last 12 kept. The last line is `exit N`:
0 done, 1 failed or stopped before pushing, 3 pushed but labels held. The
run's short summary (accounts added and kept, the money check, what changed,
the label and publish counts) is in the clone's `.cache/refresh/summary.txt`,
next to `labels.log`, `publish.log` and `site-build.log`.

```sh
ls -t "$HOME/Library/Application Support/contributions-fyi/main-refresh/logs/" | head -1
cat "$HOME/Library/Application Support/contributions-fyi/main-refresh/repo/.cache/refresh/summary.txt"
```

## Credentials

- `.env` in the clone: `FEC_API_KEY`, `LDA_API_KEY`, `SEC_USER_AGENT`,
  `SITE_URL` (copied by `install.sh` from the seeding checkout).
- `LABELER_PASSWORD` and `DATA_PASSWORD` come from Railway through
  `railway run`, with the project and environment passed explicitly, so the
  clone doesn't need `railway link`. The run calls `railway whoami` first,
  which refreshes the CLI's token. If the session has expired, the run stops
  with "railway CLI isn't logged in"; run `railway login` once.
- Pushes use your normal git credentials for github.com.

## Caches

The FEC bulk files live in one place,
`~/Library/Application Support/contributions-fyi/cache/fec/<cycle>/` (plus
`filings/`, the raw electronic filings). The clone's `.cache/fec/<cycle>` and
`project-overhaul`'s are symlinks to it, and other worktrees link to
`project-overhaul`'s files, so they all see the same copies. To point another
checkout at it:

```sh
for c in 2022 2024 2026 filings; do rm -rf .cache/fec/$c; ln -s "$HOME/Library/Application Support/contributions-fyi/cache/fec/$c" .cache/fec/$c; done
```

### When a bulk file is refetched

`src/lib/download.ts` saves each file's Content-Length, ETag and
Last-Modified as `<file>.meta.json` and sends one HEAD request per file per
run. fec.gov rebuilds the small files every day and the big ones about weekly,
often with the same rows and only new timestamps in the zip, so:

- a different size: refetch;
- same size, new ETag or Last-Modified: refetch files under 50 MB; refetch
  bigger ones once the copy is 7 days old (current cycle) or 90 days old
  (past cycles);
- no saved headers (a file from before this) and the same size: keep it and
  save the headers.

`pnpm fec-audit` (or `pnpm fec-audit <dir>`) lists the cached files that
fec.gov has changed since. Big files are fetched in 8 parallel byte ranges,
checked for length and a readable zip directory, then renamed into place. A
cache shared between checkouts is updated in place: symlinks are followed.

`indiv` zips hold `itcont.txt` and the same rows again in `by_date/` splits.
If the two disagree, the ingest reads the splits and says so. The
`indiv22.zip` cached until November 2026 had an `itcont.txt` cut off at 4.47
GB of 12.08 GB, so the 2022 individual-donor figures came from about a
third of the rows.
