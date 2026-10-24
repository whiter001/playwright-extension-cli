#!/usr/bin/env bash
# Prepares an isolated Chrome instance that has the Playwright Extension
# installed, so the manual-path test can run without touching the user's
# daily-driver browser.
#
#   scripts/setup-test-chrome.sh [profile-dir] [debug-port]
#
# The extension keeps its id (mmlmfjhmonkocbjadbfplnigmagldckm) because the
# manifest pins it via the "key" field.

set -euo pipefail

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
SRC="${CHROME_SRC:-$HOME/Library/Application Support/Google/Chrome}"
DST="${1:-/tmp/pw-test-profile}"
PORT="${2:-9333}"
EXT_ID="mmlmfjhmonkocbjadbfplnigmagldckm"

if [[ ! -x "$CHROME" ]]; then
  echo "Chrome not found at $CHROME (set CHROME=...)" >&2
  exit 1
fi

echo "==> preparing $DST"
rm -rf "$DST"
mkdir -p "$DST/Default/Extensions" "$DST/Default/Local Storage"

# The extension is only enabled when the profile records it, so copy the
# preference blobs and the unpacked extension along with the profile.
cp "$SRC/Local State" "$DST/" 2>/dev/null || true
cp "$SRC/Default/Preferences" "$DST/Default/" 2>/dev/null || true
cp "$SRC/Default/Secure Preferences" "$DST/Default/" 2>/dev/null || true
cp -R "$SRC/Default/Extensions/$EXT_ID" "$DST/Default/Extensions/"
cp -R "$SRC/Default/Local Storage/leveldb" "$DST/Default/Local Storage/" 2>/dev/null || true

# The original profile is locked by the running browser.
rm -f "$DST"/Singleton* "$DST/Default/LOCK"

echo "==> launching Chrome on port $PORT"
nohup "$CHROME" \
  --user-data-dir="$DST" \
  --profile-directory=Default \
  --remote-debugging-port="$PORT" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  "https://example.com" >/tmp/chrome-test.log 2>&1 &

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/json/version" >/dev/null; then
    echo "==> ready: http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 0.5
done

echo "Chrome did not come up; see /tmp/chrome-test.log" >&2
exit 1
