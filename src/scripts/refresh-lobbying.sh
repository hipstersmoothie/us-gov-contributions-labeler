#!/bin/sh
# Rebuild data/revolving-door.json and data/fara.json from main's data and push
# them back to main when they changed. Run by the refresh-lobbying cron service
# (src/refresh-lobbying.Dockerfile); .cache is its volume.
set -eu

REPO=git@github.com:hipstersmoothie/us-gov-contributions-labeler.git
FILES="data/revolving-door.json data/fara.json"

mkdir -p ~/.ssh
printf '%s\n' "$DEPLOY_KEY" > ~/.ssh/id_ed25519
chmod 600 ~/.ssh/id_ed25519
ssh-keyscan -t ed25519 github.com >> ~/.ssh/known_hosts 2>/dev/null

rm -rf /tmp/repo
git clone --quiet --depth 50 "$REPO" /tmp/repo
mkdir -p data
cp /tmp/repo/data/organizations.json /tmp/repo/data/congress-committees.json data/

# A cold cache is a whole Congress of filings, about four hours at lda.gov's rate limit.
pnpm ingest --steps=revolving,fara --legislation-minutes=600

# Every run stamps generatedAt; only push when something else changed.
changed=$(node -e '
  const fs = require("fs");
  const strip = (f) => { try { const d = JSON.parse(fs.readFileSync(f, "utf8")); delete d.generatedAt; return JSON.stringify(d); } catch { return ""; } };
  console.log(process.argv.slice(1).filter((f) => strip(f) !== strip("/tmp/repo/" + f)).join(" "));
' $FILES)
if [ -z "$changed" ]; then
  echo "No changes to $FILES"
  exit 0
fi
echo "Changed: $changed"

cp $FILES /tmp/repo/data/
cd /tmp/repo
git add $FILES
git -c user.name="contributions.fyi data" -c user.email="data@contributions.fyi" \
  commit --quiet -m "Lobbying data: weekly refresh of the revolving door and FARA"
# Someone may push in between; retry on top of their work.
for attempt in 1 2 3; do
  git pull --quiet --rebase origin main && git push --quiet origin HEAD:main && exit 0
  sleep 30
done
echo "Push failed" >&2
exit 1
