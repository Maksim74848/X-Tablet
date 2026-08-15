#!/usr/bin/env bash
set -euo pipefail
PREFIX="${HOME}/.local"
APPDIR="${PREFIX}/bin"
mkdir -p "$APPDIR"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
install -m 0755 "$SCRIPT_DIR/../../client/dist/linux/X-Tablet" "$APPDIR/X-Tablet"
printf '\nX-Tablet установлен: %s\n' "$APPDIR/X-Tablet"
