#!/bin/zsh
# Install the weekly sponsored-travel refresh as a launchd job for this user:
#
#   ~/Library/Application Support/contributions-fyi/travel-refresh/
#     repo/        a clone of the repo, used only by the job (its .cache/travel holds the filings)
#     run.sh       updates the clone to main, then runs src/scripts/travel/refresh.sh
#     logs/        one log per run
#   ~/Library/LaunchAgents/fyi.contributions.travel-refresh.plist   Mondays at 7:00
#
# launchd runs a missed job when the Mac next wakes. To move an existing
# .cache/travel into the clone instead of downloading everything again:
#   zsh src/scripts/travel/install-refresh.sh /path/to/.cache/travel
set -eu

HOME_DIR="$HOME/Library/Application Support/contributions-fyi/travel-refresh"
REPO_URL=https://github.com/hipstersmoothie/us-gov-contributions-labeler
LABEL=fyi.contributions.travel-refresh
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$HOME_DIR/logs"
[[ -d "$HOME_DIR/repo/.git" ]] || git clone --quiet "$REPO_URL" "$HOME_DIR/repo"
if [[ -n "${1:-}" && ! -e "$HOME_DIR/repo/.cache/travel" ]]; then
  mkdir -p "$HOME_DIR/repo/.cache"
  mv "$1" "$HOME_DIR/repo/.cache/travel"
fi

# Outside the repo, so updating the clone never rewrites the script that's running.
cat > "$HOME_DIR/run.sh" <<'EOF'
#!/bin/zsh
set -eu
NODE_BIN=$(ls -d "$HOME"/.local/share/mise/installs/node/*/bin | sort -V | tail -1)
export PATH="$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
DIR="$HOME/Library/Application Support/contributions-fyi/travel-refresh"
# One run at a time (a lock left by a crash expires after a day).
find "$DIR/lock" -maxdepth 0 -mmin +1440 -exec rmdir {} \; 2>/dev/null || true
mkdir "$DIR/lock" 2>/dev/null || { echo "already running"; exit 0; }
trap 'rmdir "$DIR/lock"' EXIT
cd "$DIR/repo"
git fetch --quiet origin main
git reset --quiet --hard origin/main
zsh src/scripts/travel/refresh.sh
# Keep the last 12 logs.
ls -t "$DIR"/logs/*.log 2>/dev/null | tail -n +13 | while read -r f; do rm -f "$f"; done
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
    <string>"\$HOME/Library/Application Support/contributions-fyi/travel-refresh/run.sh" &gt; "\$HOME/Library/Application Support/contributions-fyi/travel-refresh/logs/\$(date +%Y-%m-%d).log" 2&gt;&amp;1</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>1</integer><key>Hour</key><integer>7</integer><key>Minute</key><integer>0</integer></dict>
  <key>LowPriorityIO</key><true/>
  <key>Nice</key><integer>10</integer>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed $LABEL (Mondays 7:00). Run now: launchctl kickstart gui/$(id -u)/$LABEL"
