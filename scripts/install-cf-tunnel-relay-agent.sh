#!/bin/sh
# Installs the LaunchAgent that keeps scripts/cf-tunnel-relay.mjs running on the Mac, and with it
# cloudflared for tunnel WMac: both start at login (RunAtLoad) and come back if they die
# (KeepAlive). Run it from wherever the repo is cloned; run it again after moving the clone,
# changing Node or cloudflared, or changing the lists, and it replaces the agent each time.
#
#   sh scripts/install-cf-tunnel-relay-agent.sh            install, or reinstall
#   sh scripts/install-cf-tunnel-relay-agent.sh --token    ...asking for a new tunnel token first
#   sh scripts/install-cf-tunnel-relay-agent.sh off        stop both until `on` or the next login
#   sh scripts/install-cf-tunnel-relay-agent.sh on         start them again
#
#   ALLOW_DOMAINS=a.org BROWSER_ALLOW_DOMAINS=b.gov.au sh scripts/install-cf-tunnel-relay-agent.sh
#
# The tunnel token is asked for the first time, checked to be a whole one, and kept in the login
# Keychain as the item `cf-tunnel-relay`, without ever appearing on a command line. The relay reads
# it from there each time it starts cloudflared.
#
# ALLOW_DOMAINS, BROWSER_ALLOW_DOMAINS, CF_TUNNEL_RELAY_PROFILE and CHROME_PATH are written into the
# plist as they are when this runs; unset ones are left out. Normal output goes to /dev/null, so
# nothing on disk records which URLs were fetched; errors go to /tmp/cf-tunnel-relay.err.
#
#   launchctl kickstart -k gui/$(id -u)/local.cf-tunnel-relay   restart both, e.g. after a git pull
#   rm ~/Library/LaunchAgents/local.cf-tunnel-relay.plist       after `off`, to remove it for good
set -eu

LABEL=local.cf-tunnel-relay
KEYCHAIN_ITEM=cf-tunnel-relay
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  off)
    launchctl bootout "$DOMAIN/$LABEL"
    echo "$LABEL stopped: cf-tunnel-relay and cloudflared are off until \`on\` or the next login"
    exit 0
    ;;
  on)
    [ -f "$PLIST" ] || {
      echo "no $PLIST: run this script without \`on\` to install it" >&2
      exit 1
    }
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "$LABEL started"
    exit 0
    ;;
  --token | "") ;;
  *)
    echo "usage: sh $0 [--token | on | off]" >&2
    exit 2
    ;;
esac

CF_TUNNEL_RELAY="$(cd "$(dirname "$0")" && pwd)/cf-tunnel-relay.mjs"
# launchd gives the job no shell PATH, so Node and cloudflared go in by their full paths.
NODE="$(command -v node)" || {
  echo "node is not on PATH: install Node 18 or later first" >&2
  exit 1
}
CLOUDFLARED="$(command -v cloudflared)" || {
  echo "cloudflared is not on PATH: brew install cloudflared (only the program; no service)" >&2
  exit 1
}
[ -f "$CF_TUNNEL_RELAY" ] || {
  echo "no cf-tunnel-relay at $CF_TUNNEL_RELAY" >&2
  exit 1
}

# A cloudflared service of its own would connect the Mac to WMac a second time, or keep failing in
# the background; the one `cloudflared service install` makes keeps the token in plain text too.
for old in /Library/LaunchDaemons/com.cloudflare.cloudflared.plist \
  "$HOME/Library/LaunchAgents/com.cloudflare.cloudflared.plist"; do
  if [ -f "$old" ]; then
    echo "note: $old is a separate cloudflared service; remove it with" \
      "\`sudo cloudflared service uninstall\` (no sudo for the one in your home folder)" >&2
  fi
done
for old in /Library/LaunchDaemons/homebrew.mxcl.cloudflared.plist \
  "$HOME/Library/LaunchAgents/homebrew.mxcl.cloudflared.plist" \
  /Library/LaunchDaemons/sh.brew.cloudflared.plist "$HOME/Library/LaunchAgents/sh.brew.cloudflared.plist"; do
  if [ -f "$old" ]; then
    echo "note: $old is Homebrew's cloudflared service; remove it with" \
      "\`brew services stop cloudflared\` (with sudo for one in /Library)" >&2
  fi
done

if [ "${1:-}" = --token ] || ! security find-generic-password -s "$KEYCHAIN_ITEM" >/dev/null 2>&1; then
  echo "The tunnel token for WMac: in the Cloudflare dashboard, Networking -> Tunnels -> WMac ->"
  echo "Add a replica, copy the install command, and paste only its long eyJ... part here, then"
  echo "press Return. It is not shown as you paste."
  # Read here rather than at security's own prompt, which cuts a paste off at 128 characters.
  stty -echo 2>/dev/null || true
  IFS= read -r TOKEN || TOKEN=""
  stty echo 2>/dev/null || true
  echo
  TOKEN=$(printf '%s' "$TOKEN" | tr -d '[:space:]')
  # A tunnel token is base64 of {"a": account, "t": tunnel id, "s": secret}; a cut-off one is not.
  TUNNEL_ID=$(printf '%s' "$TOKEN" | "$NODE" -e '
    let t = "";
    process.stdin.on("data", (c) => (t += c)).on("end", () => {
      try {
        const j = JSON.parse(Buffer.from(t, "base64").toString());
        if (j.a && j.t && j.s) return console.log(j.t);
      } catch {}
      process.exit(1);
    });') || {
    echo "That is not a whole tunnel token (${#TOKEN} characters, where one is about 180):" \
      "nothing was stored. Run this again with --token and paste the eyJ... part again." >&2
    exit 1
  }
  # Through security's standard input, so the token is never on a command line where ps shows it.
  printf 'add-generic-password -U -s %s -a %s -l %s -w %s\n' \
    "$KEYCHAIN_ITEM" "$(id -un)" "$KEYCHAIN_ITEM" "$TOKEN" | security -i >/dev/null
  if [ "$(security find-generic-password -s "$KEYCHAIN_ITEM" -w 2>/dev/null)" != "$TOKEN" ]; then
    echo "The Keychain item $KEYCHAIN_ITEM does not hold the token just pasted." >&2
    exit 1
  fi
  echo "Stored the token for tunnel $TUNNEL_ID in the Keychain item $KEYCHAIN_ITEM."
fi

esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

CF_TUNNEL_RELAY_CLOUDFLARED="$CLOUDFLARED"
ENV=""
for name in CF_TUNNEL_RELAY_CLOUDFLARED ALLOW_DOMAINS BROWSER_ALLOW_DOMAINS CF_TUNNEL_RELAY_PROFILE \
  CHROME_PATH; do
  eval "value=\${$name:-}"
  if [ -n "$value" ]; then
    ENV="$ENV    <key>$name</key><string>$(esc "$value")</string>
"
  fi
done

mkdir -p "$(dirname "$PLIST")"
cat >"$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$(esc "$NODE")</string><string>$(esc "$CF_TUNNEL_RELAY")</string></array>
  <key>EnvironmentVariables</key><dict>
$ENV  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/tmp/cf-tunnel-relay.err</string>
</dict></plist>
EOF
plutil -lint "$PLIST" >/dev/null

# An agent from an earlier run has to go first; bootstrap refuses a label that is loaded.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null && sleep 1 || true
launchctl bootstrap "$DOMAIN" "$PLIST"

# The relay first, then cloudflared's own count of its connections to Cloudflare.
waited=0
until curl -fsS http://127.0.0.1:8811/health >/dev/null 2>&1; do
  if [ "$waited" -ge 10 ]; then
    echo "cf-tunnel-relay is not answering on 8811: lsof -i :8811 shows anything else holding" \
      "the port. The end of /tmp/cf-tunnel-relay.err:" >&2
    tail -n 20 /tmp/cf-tunnel-relay.err >&2 2>/dev/null
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done
echo "cf-tunnel-relay is answering on 8811; waiting for cloudflared to connect to WMac..."
waited=0
until curl -fsS http://127.0.0.1:8812/metrics 2>/dev/null |
  awk '/^cloudflared_tunnel_ha_connections / && $2 > 0 { found = 1 } END { exit !found }'; do
  if [ "$waited" -ge 20 ]; then
    echo "cloudflared has not connected to WMac after 20 seconds. The end of" \
      "/tmp/cf-tunnel-relay.err:" >&2
    tail -n 20 /tmp/cf-tunnel-relay.err >&2 2>/dev/null
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done
echo "ok - $LABEL is running $CF_TUNNEL_RELAY, and cloudflared is connected to WMac"
