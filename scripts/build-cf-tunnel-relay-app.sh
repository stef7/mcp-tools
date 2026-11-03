#!/bin/sh
# Builds CF Tunnel Relay.app into ~/Applications and opens it. The app is the whole of the Mac
# end: a menu bar switch that runs scripts/cf-tunnel-relay.mjs, which runs cloudflared for tunnel
# WMac. It asks for the tunnel token itself the first time, puts itself in Open at Login, and
# quitting it stops both. No LaunchAgent, no background item.
#
#   sh scripts/build-cf-tunnel-relay-app.sh
#
# Run it again after moving the clone or a change to scripts/cf-tunnel-relay-menu.swift. A
# `git pull` that changes only the relay needs no rebuild: "Restart relay and cloudflared" in the
# menu picks it up. It also removes the LaunchAgent local.cf-tunnel-relay that earlier versions
# installed, which the app replaces.
#
# Needs macOS 13 or later and the Xcode Command Line Tools (`xcode-select --install`), plus Node
# 18 or later and `brew install cloudflared` (the program only; no service) for the app to run.
set -eu

APP="$HOME/Applications/CF Tunnel Relay.app"
BIN=CFTunnelRelay
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/cf-tunnel-relay-menu.swift"
RELAY="$HERE/cf-tunnel-relay.mjs"

major=$(sw_vers -productVersion | cut -d. -f1)
[ "$major" -ge 13 ] || {
  echo "CF Tunnel Relay.app needs macOS 13 or later" >&2
  exit 1
}
xcrun --find swiftc >/dev/null 2>&1 || {
  echo "no Swift compiler: install the Command Line Tools with \`xcode-select --install\`" >&2
  exit 1
}

# Noted in the app as where to look first; it searches again if they move.
NODE="$(command -v node || true)"
CLOUDFLARED="$(command -v cloudflared || true)"
[ -n "$NODE" ] || echo "note: node is not on PATH; the app will ask for it to be installed" >&2
[ -n "$CLOUDFLARED" ] || echo "note: cloudflared is not on PATH: brew install cloudflared" >&2

# The LaunchAgent earlier versions installed would run a second relay and cloudflared.
OLD="$HOME/Library/LaunchAgents/local.cf-tunnel-relay.plist"
if [ -f "$OLD" ]; then
  launchctl bootout "gui/$(id -u)/local.cf-tunnel-relay" 2>/dev/null || true
  rm -f "$OLD"
  echo "removed the old LaunchAgent local.cf-tunnel-relay"
fi

# A running copy goes first; its relay and cloudflared stop with it.
pkill -x "$BIN" 2>/dev/null && sleep 2 || true

esc() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"
xcrun swiftc -swift-version 5 -O -o "$APP/Contents/MacOS/$BIN" "$SRC"
cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleIdentifier</key><string>local.cf-tunnel-relay</string>
  <key>CFBundleName</key><string>CF Tunnel Relay</string>
  <key>CFBundleExecutable</key><string>$BIN</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleVersion</key><string>1</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
  <key>CFTunnelRelay</key><dict>
    <key>Script</key><string>$(esc "$RELAY")</string>
    <key>Node</key><string>$(esc "$NODE")</string>
    <key>Cloudflared</key><string>$(esc "$CLOUDFLARED")</string>
  </dict>
</dict></plist>
EOF
plutil -lint "$APP/Contents/Info.plist" >/dev/null
# Signed as a whole (ad hoc), so the Info.plist is part of what macOS checks.
codesign --force --sign - "$APP"

open "$APP"
echo "ok - built $APP and opened it: look for the cloud in the menu bar"
