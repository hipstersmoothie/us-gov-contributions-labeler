#!/bin/zsh
# Weekly refresh of data/travel.json on this Mac (the OCR needs macOS Vision):
# new House and Senate filings, read, built, and pushed to main when anything
# but the timestamp changed. Run by launchd from a clone of the repo kept just
# for this, up to date with main; see install-refresh.sh.
#
#   DRY_RUN=1 zsh src/scripts/travel/refresh.sh    # everything but the push
set -eu

log() { print -r -- "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

pnpm install --frozen-lockfile --filter us-gov-contributions-labeler --silent

# The OCR tool, rebuilt when its source changes.
if [[ ! -x .cache/travel/ocr || src/scripts/travel/ocr.swift -nt .cache/travel/ocr ]]; then
  mkdir -p .cache/travel
  swiftc -O src/scripts/travel/ocr.swift -o .cache/travel/ocr
fi

log "fetching new filings"
npx tsx src/scripts/travel/fetch.ts
log "reading House filings"
npx tsx src/scripts/travel/house-read.ts
log "reading Senate filings"
npx tsx src/scripts/travel/senate-read.ts
log "building data/travel.json"
npx tsx src/scripts/travel/build.ts

# Every run stamps generatedAt; only push when something else changed.
changed=$(node -e '
  const { execSync } = require("child_process");
  const strip = (s) => { try { const d = JSON.parse(s); delete d.generatedAt; return JSON.stringify(d); } catch { return ""; } };
  const before = execSync("git show HEAD:data/travel.json", { maxBuffer: 1 << 28 }).toString();
  console.log(strip(require("fs").readFileSync("data/travel.json", "utf8")) !== strip(before) ? "yes" : "");
')
if [[ -z "$changed" ]]; then
  log "no changes to data/travel.json"
  git checkout -- data/travel.json
  exit 0
fi
if [[ -n "${DRY_RUN:-}" ]]; then
  log "changed; not pushing (DRY_RUN)"
  exit 0
fi

git add data/travel.json
git -c user.name="contributions.fyi data" -c user.email="data@contributions.fyi" \
  commit --quiet -m "Sponsored travel: weekly refresh of House and Senate filings"
# Someone may push in between; retry on top of their work.
for attempt in 1 2 3; do
  if git pull --quiet --rebase origin main && git push --quiet origin HEAD:main; then
    log "pushed"
    exit 0
  fi
  sleep 30
done
log "push failed"
exit 1
