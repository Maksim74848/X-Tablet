#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/../../client/dist/macos/X-Tablet.app"
OUT="$ROOT/dist"
mkdir -p "$OUT"
rm -f "$OUT/X-Tablet-macOS.dmg"
hdiutil create -volname "X-Tablet" -srcfolder "$APP" -ov -format UDZO "$OUT/X-Tablet-macOS.dmg"
echo "Created $OUT/X-Tablet-macOS.dmg"
