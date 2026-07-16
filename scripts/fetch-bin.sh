#!/usr/bin/env bash
# Fetches the arm64-native binaries that AudioPro bundles (ffmpeg,
# ffprobe) plus the RNNoise model used for Mode 1's conditional local
# denoise. The bin/ directory is gitignored, so this script is what
# populates it after a fresh clone, before `npm run build`.
#
# Source:
#   - ffmpeg / ffprobe 8.1 arm64 (static, only system frameworks):
#       https://www.osxexperts.net/
#   - RNNoise model "somnolent-hogwash" (public domain, ~290 KB):
#       https://github.com/GregorR/rnnoise-models
#
# Usage: bash scripts/fetch-bin.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin"

# Pinned SHA256 hashes for the artefacts we trust. If osxexperts.net ever
# serves different bytes, we abort instead of silently shipping a different
# binary inside the .app/.dmg.
FFMPEG_ZIP_SHA256="ebb82529562b71170807bbc6b0e7eb4f0b13af8cbb0e085bb9e8f6fe709598ad"
FFPROBE_ZIP_SHA256="a6640a77d38a6f0527c5b597e599cb36a3427a6931444ed80bc62542421950a1"
RNNOISE_MODEL_SHA256="70bb6685eb0c2a1d18e2918dca3fbfbd39317010b1802eb1b6ea73a92f3fdec0"

echo "▶ Populating $BIN with arm64 binaries"
mkdir -p "$BIN"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

verify_sha256() {
  local file="$1" expected="$2"
  local actual
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    echo "✗ SHA256 mismatch for $file" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    echo "  Refusing to install — upstream artefact may have been tampered with." >&2
    exit 1
  fi
}

# ── ffmpeg + ffprobe (osxexperts.net static arm64 builds) ─────────────────
fetch_osxexperts() {
  local name="$1" expected_sha="$2"
  local zip_url="https://www.osxexperts.net/${name}81arm.zip"
  echo "▶ Downloading $name ($zip_url)"
  curl -fsSL "$zip_url" -o "$TMP/$name.zip"
  verify_sha256 "$TMP/$name.zip" "$expected_sha"
  unzip -q -o "$TMP/$name.zip" -d "$TMP" "$name"
  install -m 0755 "$TMP/$name" "$BIN/$name"
  xattr -d com.apple.quarantine "$BIN/$name" 2>/dev/null || true
  local arch
  arch="$(file "$BIN/$name" | grep -oE 'arm64|x86_64' || echo unknown)"
  echo "  ✓ $name → $BIN/$name ($arch, sha256 verified)"
}

fetch_osxexperts ffmpeg "$FFMPEG_ZIP_SHA256"
fetch_osxexperts ffprobe "$FFPROBE_ZIP_SHA256"

# ── RNNoise model (GregorR/rnnoise-models, public domain) ─────────────────
fetch_rnnoise_model() {
  local dest="$BIN/rnnoise-model.rnnn"
  local url="https://raw.githubusercontent.com/GregorR/rnnoise-models/master/somnolent-hogwash-2018-09-01/sh.rnnn"
  echo "▶ Downloading RNNoise model ($url)"
  curl -fsSL "$url" -o "$TMP/rnnoise-model.rnnn"
  verify_sha256 "$TMP/rnnoise-model.rnnn" "$RNNOISE_MODEL_SHA256"
  install -m 0644 "$TMP/rnnoise-model.rnnn" "$dest"
  echo "  ✓ rnnoise-model.rnnn → $dest (sha256 verified)"
}

fetch_rnnoise_model

echo
echo "✓ All bundled binaries ready:"
ls -lh "$BIN"
