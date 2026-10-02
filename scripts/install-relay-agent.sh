#!/bin/sh
# Installs the LaunchAgent that keeps scripts/tunnel-relay.mjs running on the Mac: it starts at
# login (RunAtLoad) and comes back if it dies (KeepAlive). Run it from wherever the repo is
# cloned; run it again after moving the clone, changing Node or changing the lists, and it
# replaces the agent each time.
#
#   sh scripts/install-relay-agent.sh
#   ALLOW_DOMAINS=a.org BROWSER_ALLOW_DOMAINS=b.gov.au sh scripts/install-relay-agent.sh
#
# ALLOW_DOMAINS, BROWSER_ALLOW_DOMAINS, RELAY_PROFILE and CHROME_PATH are written into the plist
# as they are when this runs; unset ones are left out. Normal output goes to /dev/null, so nothing
# on disk records which URLs were fetched; errors go to /tmp/tunnel-relay.err.
#
#   launchctl kickstart -k gui/$(id -u)/local.tunnel-relay   restart it, e.g. after a git pull
#   launchctl bootout gui/$(id -u)/local.tunnel-relay        stop it until the next login
#   rm ~/Library/LaunchAgents/local.tunnel-relay.plist       ...and for good
set -eu

LABEL=local.tunnel-relay
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
RELAY="$(cd "$(dirname "$0")" && pwd)/tunnel-relay.mjs"
# launchd gives the job no shell PATH, so Node goes in by its full path.
NODE="$(command -v node)" || {
  echo "node is not on PATH: install Node 18 or later first" >&2
  exit 1
}
[ -f "$RELAY" ] || {
  echo "no relay at $RELAY" >&2
  exit 1
}

esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

ENV=""
for name in ALLOW_DOMAINS BROWSER_ALLOW_DOMAINS RELAY_PROFILE CHROME_PATH; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then
    ENV="$ENV    <key>$name</key><string>$(esc "$value")</string>
"
  fi
done
if [ -n "$ENV" ]; then
  ENV="  <key>EnvironmentVariables</key><dict>
$ENV  </dict>
"
fi

mkdir -p "$(dirname "$PLIST")"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$(esc "$NODE")</string><string>$(esc "$RELAY")</string></array>
$ENV  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/tmp/tunnel-relay.err</string>
</dict></plist>
EOF
plutil -lint "$PLIST" >/dev/null

# An agent from an earlier run has to go first; bootstrap refuses a label that is loaded.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && sleep 1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

sleep 1
if curl -fsS http://127.0.0.1:8811/health; then
  echo " - $LABEL is running $RELAY"
else
  echo "the relay is not answering on 8811: see /tmp/tunnel-relay.err, and lsof -i :8811 for" \
    "anything else holding the port" >&2
  exit 1
fi
