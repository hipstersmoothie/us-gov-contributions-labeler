#!/bin/zsh
# Weekly refresh of the main data on this Mac: re-ingest, check, push to main,
# sync labels, publish the open data. Run by launchd from a clone of the repo
# kept just for this, up to date with main; see install.sh and
# design/refresh/README.md.
#
#   DRY_RUN=1 zsh src/scripts/refresh/refresh.sh    # ingest, check and build; no push, labels or publish
#
# Exits 0 when everything ran, 1 on an error or when the data looked wrong
# (nothing pushed), 3 when the data was pushed but the label changes were
# held for review.
set -eu
setopt pipefail

log() { print -r -- "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

RAILWAY_PROJECT=9c644391-3bf5-4923-905f-cea2ebd1902d
RAILWAY_ENV=2f859f9f-6599-4d18-89cb-394f2d34d9c7
STEPS=assignments,fec,bundling,committees,lobbying,individuals,donors,legislation,races
SUMMARY=.cache/refresh/summary.txt
mkdir -p .cache/refresh
: > "$SUMMARY"
note() { print -r -- "$*" >> "$SUMMARY"; log "$*"; }

pnpm install --frozen-lockfile --silent

# Bluesky accounts first, on their own, so dropped matches can be put back
# before anything is built from them.
log "matching Bluesky accounts"
pnpm ingest --steps=accounts
npx tsx src/scripts/refresh/accounts-guard.ts | tee -a "$SUMMARY"

log "ingesting $STEPS"
pnpm ingest --steps=$STEPS

log "checking the data against main"
npx tsx src/scripts/refresh/check-data.ts | tee -a "$SUMMARY"

log "building the site"
pnpm site:build > .cache/refresh/site-build.log 2>&1 || { tail -40 .cache/refresh/site-build.log; note "site build failed"; exit 1; }

# Every build stamps generatedAt; leave files where nothing else changed.
changed=$(node -e '
  const { execSync } = require("child_process");
  const fs = require("fs");
  const strip = (s) => { try { const d = JSON.parse(s); if (d && !Array.isArray(d)) delete d.generatedAt; return JSON.stringify(d); } catch { return s; } };
  const files = execSync("git diff --name-only -- data", { encoding: "utf8" }).split("\n").filter(Boolean);
  const real = files.filter((f) => strip(fs.readFileSync(f, "utf8")) !== strip(execSync(`git show HEAD:${f}`, { maxBuffer: 1 << 30 }).toString()));
  console.log(real.join(" "));
')
git diff --name-only -- data | while read -r f; do [[ " $changed " == *" $f "* ]] || git checkout -- "$f"; done
untracked=$(git ls-files --others --exclude-standard -- data)
if [[ -n "$untracked" ]]; then
  note "new files in data/ (not committed): $untracked"
fi

if [[ -n "${DRY_RUN:-}" ]]; then
  note "changed: ${changed:-nothing}; not pushing (DRY_RUN)"
  exit 0
fi

if [[ -n "$changed" ]]; then
  note "changed: $changed"
  git add -- ${=changed}
  git -c user.name="contributions.fyi data" -c user.email="data@contributions.fyi" \
    commit --quiet -m "Data: weekly refresh of FEC filings, accounts and committees"
  # Others push to main too. Rebase on top of their work; data files are
  # regenerated whole, so a conflict means someone else refreshed the same
  # file: stop and leave it for a person rather than pick a side.
  pushed=
  for attempt in 1 2 3; do
    if ! git pull --quiet --rebase origin main; then
      git rebase --abort 2>/dev/null || true
      note "conflict rebasing onto main; nothing pushed"
      exit 1
    fi
    if git push --quiet origin HEAD:main; then pushed=1; break; fi
    sleep 30
  done
  [[ -n "$pushed" ]] || { note "push failed"; exit 1; }
  note "pushed $(git rev-parse --short HEAD)"
else
  note "no data changes"
fi

# Railway's CLI session refreshes its token on use. Its API, lda.gov and the
# labeler drop connections now and then, so the steps below retry; both only
# send differences, so a retry picks up where the last try stopped.
retry() { local i; for i in 1 2 3; do "$@" && return 0; local code=$?; (( code == 3 )) && return 3; log "attempt $i failed (exit $code)"; sleep 30; done; return 1; }
retry railway whoami > /dev/null || { note "railway CLI isn't logged in; run 'railway login'"; exit 1; }

log "syncing labels"
labels_run() {
  railway run -p $RAILWAY_PROJECT -e $RAILWAY_ENV -s us-gov-contributions-labeler -- \
    npx tsx src/sync-labels.ts --apply --max-accounts=40 > .cache/refresh/labels.log 2>&1
}
set +e
retry labels_run
labels=$?
set -e
grep -vE "DEP0169|trace-deprecation" .cache/refresh/labels.log | tail -15
grep -E "accounts change|lose all|Not applying|Applied" .cache/refresh/labels.log >> "$SUMMARY" || true
if (( labels == 3 )); then
  held=1
elif (( labels != 0 )); then
  note "label sync failed"
  exit 1
fi

# The source records (FEC lines, lobbying filings) come from this run's ingest
# cache; publish-records builds contributions.sqlite itself. If they fail to
# build, the published ones stay.
log "building the open data's source files"
pnpm build-sqlite --only=fec,lobbying > .cache/refresh/sqlite.log 2>&1 || { tail -20 .cache/refresh/sqlite.log; note "building the SQLite source files failed; publishing the previous ones"; }

log "publishing the open data"
publish_run() {
  railway run -p $RAILWAY_PROJECT -e $RAILWAY_ENV -s pds -- \
    npx tsx src/publish-records.ts --apply > .cache/refresh/publish.log 2>&1
}
retry publish_run || { tail -20 .cache/refresh/publish.log; note "publishing the open data failed"; exit 1; }
grep -E "create,|files changed|writes, |skipping|Done" .cache/refresh/publish.log
grep -E "writes, |skipping" .cache/refresh/publish.log >> "$SUMMARY" || true

if [[ -n "${held:-}" ]]; then
  note "label changes held for review: .cache/label-plan.json"
  exit 3
fi
log "done"
