#!/usr/bin/env bash
# Fetches a relocatable Python 3.11 distribution (python-build-standalone) and
# installs torch + soundfile + numpy into it. The result is bundled inside the
# .app so BodyGen works out-of-the-box without a system Python.
#
# Sources:
#   - python-build-standalone (Astral): https://github.com/astral-sh/python-build-standalone
#   - PyPI wheels: torch, soundfile, numpy
#
# Usage: bash scripts/setup-python.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin"
PY_DIR="$BIN/python"

PY_RELEASE="20260504"
PY_VERSION="3.11.15"
PY_TARBALL="cpython-${PY_VERSION}+${PY_RELEASE}-aarch64-apple-darwin-install_only.tar.gz"
PY_URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/${PY_TARBALL}"
PY_SHA256="ba215bc68f7f65823cb6c63f6ac2fb1e5d7fc79ebee61492a320060369977224"

# Pin runtime dependencies. Major torch upgrades change ABI and disk size, so
# we hold them stable until we deliberately bump them.
TORCH_VERSION="2.11.0"
SOUNDFILE_VERSION="0.13.1"
NUMPY_VERSION="2.4.4"

verify_sha256() {
  local file="$1" expected="$2"
  local actual
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    echo "✗ SHA256 mismatch for $file" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}

if [ -x "$PY_DIR/bin/python3" ]; then
  echo "▶ Bundled Python already at $PY_DIR — skipping (delete $PY_DIR to reinstall)"
  exit 0
fi

echo "▶ Bundling Python ${PY_VERSION} into $PY_DIR"
mkdir -p "$BIN"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "  Downloading $PY_TARBALL"
curl -fL --progress-bar "$PY_URL" -o "$TMP/python.tar.gz"
verify_sha256 "$TMP/python.tar.gz" "$PY_SHA256"

tar -xzf "$TMP/python.tar.gz" -C "$TMP"
mv "$TMP/python" "$PY_DIR"
xattr -dr com.apple.quarantine "$PY_DIR" 2>/dev/null || true

echo "▶ Installing torch ${TORCH_VERSION} + soundfile ${SOUNDFILE_VERSION} + numpy ${NUMPY_VERSION}"
"$PY_DIR/bin/python3" -m pip install \
  --no-cache-dir --disable-pip-version-check --quiet \
  "torch==${TORCH_VERSION}" \
  "soundfile==${SOUNDFILE_VERSION}" \
  "numpy==${NUMPY_VERSION}"

echo "▶ Trimming Python tree (tests, caches, unused stdlib, dist-info)"
# Order matters: trim BEFORE smoke test, otherwise the test regenerates __pycache__.
# Each step is wrapped so a missing match never aborts the script under `set -e`.
trim() { "$@" 2>/dev/null || true; }
trim find "$PY_DIR" -type d -name "__pycache__" -prune -exec rm -rf {} +
trim find "$PY_DIR" -type d \( -name "test" -o -name "tests" \) -prune -exec rm -rf {} +
trim find "$PY_DIR/lib/python3.11/site-packages" -type d -name "*.dist-info" -prune -exec rm -rf {} +
trim rm -rf "$PY_DIR/lib/python3.11/site-packages/pip" \
            "$PY_DIR/lib/python3.11/site-packages/_distutils_hack" \
            "$PY_DIR/lib/python3.11/site-packages/distutils-precedence.pth" \
            "$PY_DIR/lib/python3.11/site-packages/setuptools" \
            "$PY_DIR/lib/python3.11/site-packages/pkg_resources"
trim rm -rf "$PY_DIR/lib/python3.11/idlelib" \
            "$PY_DIR/lib/python3.11/turtledemo" \
            "$PY_DIR/lib/python3.11/tkinter" \
            "$PY_DIR/lib/python3.11/ensurepip"
# Note: keep torchgen — torch.utils._python_dispatch imports it at runtime.
# torch/include is C++ headers, safe to drop. onnx/benchmark/bottleneck are
# tooling that bodygen does not exercise, safe to drop. Verify with the smoke
# test below — if it fails, restore the directory and reduce the trim list.
trim rm -rf "$PY_DIR/lib/python3.11/site-packages/torch/include" \
            "$PY_DIR/lib/python3.11/site-packages/torch/utils/benchmark" \
            "$PY_DIR/lib/python3.11/site-packages/torch/utils/bottleneck" \
            "$PY_DIR/lib/python3.11/site-packages/torch/onnx"
# Also drop the standalone Python C headers — only used to compile extensions.
trim rm -rf "$PY_DIR/include"

echo "▶ Smoke test (will regenerate small __pycache__; that's expected)"
"$PY_DIR/bin/python3" -c "import torch, soundfile, numpy; print('  ✓ torch', torch.__version__, '| soundfile', soundfile.__version__, '| numpy', numpy.__version__)"

# Real bytes (not block-aligned du), since the dev SSD may be exFAT.
REAL_MB="$(find "$PY_DIR" -type f -exec stat -f "%z" {} + 2>/dev/null | awk '{s+=$1} END {printf "%.0f", s/1024/1024}')"
SIZE="${REAL_MB} MB"
echo
echo "✓ Bundled Python ready at $PY_DIR ($SIZE)"
