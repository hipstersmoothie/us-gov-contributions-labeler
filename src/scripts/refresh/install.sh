#!/bin/zsh
# Install the weekly main-data refresh as a launchd job for this user:
#
#   ~/Library/Application Support/contributions-fyi/
#     cache/fec/           FEC bulk files and API listings, shared with worktrees
#     main-refresh/
#       repo/              a clone of the repo, used only by the job
#       run.sh             one run: lock, update the clone to main, refresh.sh, notify
#       logs/              one log per run, the last 12 kept
#   ~/Library/LaunchAgents/fyi.contributions.main-refresh.plist   Tuesdays at 1:00
#
# The first time, seed the clone's .cache from a checkout that has run the
# ingest (copied as APFS clones, so it takes no extra space and leaves the
# source alone), and its .env and dm-leads.local.json from there too:
#   zsh src/scripts/refresh/install.sh /path/to/checkout
#
# Uninstall: zsh src/scripts/refresh/install.sh --uninstall (keeps the clone and caches).
set -eu

BASE="$HOME/Library/Application Support/contributions-fyi"
HOME_DIR="$BASE/main-refresh"
SHARED="$BASE/cache/fec"
REPO_URL=https://github.com/hipstersmoothie/us-gov-contributions-labeler
LABEL=fyi.contributions.main-refresh
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "${1:-}" == --uninstall ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$HOME_DIR/run.sh"
  echo "Uninstalled $LABEL. The clone and caches are still in $BASE; delete them by hand if you want the space back."
  exit 0
fi

mkdir -p "$HOME_DIR/logs" "$SHARED"
[[ -d "$HOME_DIR/repo/.git" ]] || git clone --quiet "$REPO_URL" "$HOME_DIR/repo"
REPO="$HOME_DIR/repo"

if [[ -n "${1:-}" ]]; then
  SRC=${1%/}
  [[ -f "$REPO/.env" || ! -f "$SRC/.env" ]] || cp "$SRC/.env" "$REPO/.env"
  [[ -f "$REPO/dm-leads.local.json" || ! -f "$SRC/dm-leads.local.json" ]] || cp "$SRC/dm-leads.local.json" "$REPO/"
  if [[ -d "$SRC/.cache" && ! -e "$REPO/.cache" ]]; then
    mkdir -p "$REPO/.cache"
    # Everything but the FEC cycle directories, which go to the shared cache.
    for f in "$SRC"/.cache/*(N) "$SRC"/.cache/.*(N); do
      [[ $(basename "$f") == fec ]] && continue
      cp -cRL "$f" "$REPO/.cache/" 2>/dev/null || cp -RL "$f" "$REPO/.cache/"
    done
    mkdir -p "$REPO/.cache/fec"
    for f in "$SRC"/.cache/fec/*(N); do
      name=$(basename "$f")
      if [[ -d "$f" ]]; then
        # Cycle directories and raw filings: fill in what the shared cache lacks.
        mkdir -p "$SHARED/$name"
        for g in "$f"/*(N); do
          [[ -e "$SHARED/$name/$(basename "$g")" ]] || cp -cL "$g" "$SHARED/$name/"
        done
      else
        cp -cL "$f" "$REPO/.cache/fec/"
      fi
    done
  fi
fi

# The clone's FEC cycle directories live in the shared cache.
mkdir -p "$REPO/.cache/fec"
for d in "$SHARED"/*(/N); do
  link="$REPO/.cache/fec/$(basename "$d")"
  [[ -L "$link" ]] && continue
  if [[ -d "$link" ]]; then
    for g in "$link"/*(N); do [[ -e "$d/$(basename "$g")" ]] || mv "$g" "$d/"; done
    rm -rf "$link"
  fi
  ln -s "$d" "$link"
done

# Outside the repo, so updating the clone never rewrites the script that's running.
cat > "$HOME_DIR/run.sh" <<'EOF'
#!/bin/zsh
set -u
NODE_BIN=$(ls -d "$HOME"/.local/share/mise/installs/node/*/bin | sort -V | tail -1)
export PATH="$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
DIR="$HOME/Library/Application Support/contributions-fyi/main-refresh"
notify() { osascript -e "display notification \"$2\" with title \"contributions.fyi refresh\" subtitle \"$1\"" 2>/dev/null || true; }
# One run at a time (a lock left by a crash expires after a day).
find "$DIR/lock" -maxdepth 0 -mmin +1440 -exec rmdir {} \; 2>/dev/null || true
mkdir "$DIR/lock" 2>/dev/null || { echo "already running"; exit 0; }
trap 'rmdir "$DIR/lock"' EXIT
cd "$DIR/repo"
echo "$(date '+%Y-%m-%d %H:%M:%S') updating to origin/main"
if git fetch --quiet origin main && git reset --quiet --hard origin/main; then
  zsh src/scripts/refresh/refresh.sh
  code=$?
else
  code=1
fi
summary=$(grep -v '^$' .cache/refresh/summary.txt 2>/dev/null | tail -3 | tr '\n' ' ' | tr -d '"\\' | cut -c1-200)
case $code in
  0) ;;
  3) notify "Label changes held for review" "$summary" ;;
  *) notify "Failed or stopped (exit $code)" "${summary:-see the log} Log: $DIR/logs" ;;
esac
echo "$(date '+%Y-%m-%d %H:%M:%S') exit $code"
# Keep the last 12 logs.
ls -t "$DIR"/logs/*.log 2>/dev/null | tail -n +13 | while read -r f; do rm -f "$f"; done
exit $code
EOF
chmod +x "$HOME_DIR/run.sh"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-c</string>
    <string>"\$HOME/Library/Application Support/contributions-fyi/main-refresh/run.sh" &gt; "\$HOME/Library/Application Support/contributions-fyi/main-refresh/logs/\$(date +%Y-%m-%d-%H%M).log" 2&gt;&amp;1</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>2</integer><key>Hour</key><integer>1</integer><key>Minute</key><integer>0</integer></dict>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL (Tuesdays 1:00). Run now: launchctl kickstart gui/$(id -u)/$LABEL"
