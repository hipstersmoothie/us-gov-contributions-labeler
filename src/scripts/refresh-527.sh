#!/bin/sh
# Rebuild data/irs527.json from the IRS's political organization bulk file and
# main's data, and push it back to main when it changed. Run monthly by the
# refresh-527 cron service (src/refresh-527.Dockerfile); /cache is its volume.
#
# To try it locally: REPO=https://github.com/hipstersmoothie/us-gov-contributions-labeler.git
# DRY_RUN=1 (don't push), SKIP_DOWNLOAD=1 (use the zip already on the volume), FORCE=1 (run even if
# the IRS file hasn't changed).
set -eu

REPO=${REPO:-git@github.com:hipstersmoothie/us-gov-contributions-labeler.git}
UA="contributions.fyi research (https://contributions.fyi)"
CACHE=/cache/irs527
mkdir -p "$CACHE"

if [ -n "${DEPLOY_KEY:-}" ]; then
  mkdir -p ~/.ssh
  printf '%s\n' "$DEPLOY_KEY" > ~/.ssh/id_ed25519
  chmod 600 ~/.ssh/id_ed25519
  ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null
fi

rm -rf /tmp/repo
git clone --quiet --depth 50 "$REPO" /tmp/repo
cd /tmp/repo
mkdir -p .cache
ln -s "$CACHE" .cache/irs527

# The IRS rebuilds the file every Saturday. One request; it's ~370 MB.
if [ -n "${SKIP_DOWNLOAD:-}" ]; then
  cp "$CACHE/PolOrgsFullData.zip" "$CACHE/PolOrgsFullData.zip.new"
else
  curl -sSL --fail -A "$UA" -o "$CACHE/PolOrgsFullData.zip.new" https://forms.irs.gov/app/pod/dataDownload/fullData
fi
if [ -f "$CACHE/PolOrgsFullData.zip" ] && cmp -s "$CACHE/PolOrgsFullData.zip" "$CACHE/PolOrgsFullData.zip.new" && [ -z "${FORCE:-}" ]; then
  echo "IRS file unchanged since the last run"
  rm "$CACHE/PolOrgsFullData.zip.new"
  exit 0
fi
mv "$CACHE/PolOrgsFullData.zip.new" "$CACHE/PolOrgsFullData.zip"
unzip -o -q "$CACHE/PolOrgsFullData.zip" -d "$CACHE"
# The zip's one file has been named FullDataFile.txt; take whatever .txt it holds.
txt=$(unzip -Z1 "$CACHE/PolOrgsFullData.zip" | grep -i '\.txt$' | head -1)
[ "$txt" = FullDataFile.txt ] || mv "$CACHE/$txt" "$CACHE/FullDataFile.txt"

# FEC committee names, for orgs.py's overlap check: this cycle and the last.
year=$(date +%Y)
cycle=$(( year % 2 == 0 ? year : year + 1 ))
for c in $((cycle - 2)) $cycle; do
  yy=$(printf %02d $((c % 100)))
  curl -sSL --fail -A "$UA" -o "$CACHE/cm$yy.zip" "https://www.fec.gov/files/bulk-downloads/$c/cm$yy.zip"
  unzip -o -q -p "$CACHE/cm$yy.zip" > "$CACHE/cm$yy.txt"
  sleep 2
done

python3 src/scripts/irs527/parse.py
python3 src/scripts/irs527/orgs.py > /dev/null
python3 src/scripts/irs527/build.py

# Every run stamps generatedAt; only push when something else changed.
changed=$(git show HEAD:data/irs527.json > /tmp/old.json 2>/dev/null; python3 -c '
import json, sys
def strip(f):
    try:
        d = json.load(open(f)); d.pop("generatedAt", None); return json.dumps(d, sort_keys=True)
    except Exception:
        return ""
print("yes" if strip("data/irs527.json") != strip("/tmp/old.json") else "")
')
if [ -z "$changed" ]; then
  echo "No changes to data/irs527.json"
  exit 0
fi

if [ -n "${DRY_RUN:-}" ]; then
  echo "Changed; not pushing (DRY_RUN)"
  exit 0
fi
git add data/irs527.json
git -c user.name="contributions.fyi data" -c user.email="data@contributions.fyi" \
  commit --quiet -m "State political groups: monthly refresh from the IRS 527 data"
# Someone may push in between; retry on top of their work.
for attempt in 1 2 3; do
  git pull --quiet --rebase origin main && git push --quiet origin HEAD:main && exit 0
  sleep 30
done
echo "Push failed" >&2
exit 1
