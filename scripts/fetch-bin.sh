#!/usr/bin/env bash
# Fetches the arm64-native binaries that AudioPro bundles (ffmpeg, ffprobe,
# deep-filter). The bin/ directory is gitignored, so this script is what
# populates it after a fresh clone, before `npm run build`.
#
# Sources:
#   - ffmpeg / ffprobe 8.1 arm64 (static, only system frameworks):
#       https://www.osxexperts.net/
#   - deep-filter 0.5.6 arm64 (DeepFilterNet CLI):
#       https://github.com/Rikorose/DeepFilterNet/releases
#
# Usage: bash scripts/fetch-bin.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin"
DF_VERSION="0.5.6"

echo "▶ Populating $BIN with arm64 binaries"
mkdir -p "$BIN"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── ffmpeg + ffprobe (osxexperts.net static arm64 builds) ─────────────────
fetch_osxexperts() {
  local name="$1"  # ffmpeg or ffprobe
  local zip_url="https://www.osxexperts.net/${name}81arm.zip"
  echo "▶ Downloading $name ($zip_url)"
  curl -fsSL "$zip_url" -o "$TMP/$name.zip"
  unzip -q -o "$TMP/$name.zip" -d "$TMP" "$name"
  install -m 0755 "$TMP/$name" "$BIN/$name"
  xattr -d com.apple.quarantine "$BIN/$name" 2>/dev/null || true
  local arch
  arch="$(file "$BIN/$name" | grep -oE 'arm64|x86_64' || echo unknown)"
  echo "  ✓ $name → $BIN/$name ($arch)"
}

fetch_osxexperts ffmpeg
fetch_osxexperts ffprobe

# ── deep-filter (DeepFilterNet CLI, GitHub releases) ──────────────────────
DF_URL="https://github.com/Rikorose/DeepFilterNet/releases/download/v${DF_VERSION}/deep-filter-${DF_VERSION}-aarch64-apple-darwin"
echo "▶ Downloading deep-filter ${DF_VERSION} ($DF_URL)"
curl -fsSL "$DF_URL" -o "$BIN/deep-filter"
chmod 0755 "$BIN/deep-filter"
xattr -d com.apple.quarantine "$BIN/deep-filter" 2>/dev/null || true
DF_ARCH="$(file "$BIN/deep-filter" | grep -oE 'arm64|x86_64' || echo unknown)"
echo "  ✓ deep-filter → $BIN/deep-filter ($DF_ARCH)"

echo
echo "✓ All bundled binaries ready:"
ls -lh "$BIN"
