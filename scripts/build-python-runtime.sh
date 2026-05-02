#!/usr/bin/env bash
# Builds the embedded Python runtime that ships inside AudioPro.app.
#
# Output: ./python-runtime/  — a self-contained Python 3.10 install with
#         resemble-enhance, torch, soundfile, and the model weights
#         pre-downloaded.
#
# The runtime is "relocatable": all internal paths inside the venv are
# rewritten to reference the runtime via a launcher script, so it keeps
# working when packaged inside /Applications/AudioPro.app/Contents/Resources.
#
# Total size on disk: ~3 GB.
#
# Requirements on the build machine:
#   - macOS arm64 (must match the target architecture)
#   - pyenv (so we can grab a clean Python 3.10 without Homebrew bugs)
#   - git-lfs (for the resemble-enhance model download)
#   - curl, tar, find, sed, install_name_tool

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="$ROOT/python-runtime"
PY_VERSION="3.10.16"
PYENV_PREFIX="${PYENV_PREFIX:-$HOME/.pyenv/versions/$PY_VERSION}"

echo "▶ Building AudioPro embedded Python runtime"
echo "  root:    $ROOT"
echo "  output:  $RUNTIME"
echo "  python:  $PY_VERSION"

# ── 1. Ensure prerequisites ───────────────────────────────────────────────
if ! command -v pyenv >/dev/null 2>&1; then
  echo "✗ pyenv not found. Install it first: brew install pyenv" >&2
  exit 1
fi
if ! command -v git-lfs >/dev/null 2>&1; then
  echo "✗ git-lfs not found. Install it first: brew install git-lfs" >&2
  exit 1
fi
if [ ! -x "$PYENV_PREFIX/bin/python3.10" ]; then
  echo "▶ Installing Python $PY_VERSION via pyenv..."
  pyenv install -s "$PY_VERSION"
fi

# ── 2. Wipe any previous runtime ──────────────────────────────────────────
if [ -d "$RUNTIME" ]; then
  echo "▶ Removing existing runtime at $RUNTIME"
  rm -rf "$RUNTIME"
fi

# ── 3. Create a fresh venv from the pyenv interpreter ─────────────────────
echo "▶ Creating venv..."
"$PYENV_PREFIX/bin/python3.10" -m venv "$RUNTIME"

# ── 4. Upgrade pip / install dependencies ─────────────────────────────────
echo "▶ Upgrading pip..."
"$RUNTIME/bin/pip" install --upgrade pip wheel setuptools

echo "▶ Installing resemble-enhance + soundfile (this pulls torch ~2 GB)..."
"$RUNTIME/bin/pip" install resemble-enhance soundfile

# ── 5. Pre-download Resemble Enhance models (so first launch is offline) ──
echo "▶ Pre-downloading Resemble Enhance model weights via git-lfs..."
"$RUNTIME/bin/python" - <<'PY'
import os, sys, tempfile, shutil, soundfile as sf, numpy as np
# Importing the inference module triggers the model_repo clone + LFS pull.
from resemble_enhance.enhancer.inference import enhance as re_enhance
import torch

# Generate a tiny silent wav and run a 1-step enhance to force the lazy
# model loader to materialise the checkpoint files. We use nfe=1 to keep
# this cheap (~10s on CPU instead of ~60s).
with tempfile.TemporaryDirectory() as td:
    sr = 48000
    sig = np.zeros(sr // 4, dtype=np.float32)  # 250 ms of silence
    src = os.path.join(td, "in.wav")
    sf.write(src, sig, sr)
    audio = torch.from_numpy(sig)
    print("Warming up resemble-enhance...", flush=True)
    out, out_sr = re_enhance(audio, sr, "cpu", nfe=1, solver="midpoint", lambd=1.0, tau=0.1)
    print(f"  ok: out_sr={out_sr}, shape={tuple(out.shape)}", flush=True)
PY

# ── 6. Strip __pycache__ to shave size ────────────────────────────────────
echo "▶ Pruning __pycache__ + tests..."
find "$RUNTIME" -type d -name '__pycache__' -prune -exec rm -rf {} +
find "$RUNTIME" -type d -name 'tests'        -prune -exec rm -rf {} + 2>/dev/null || true
find "$RUNTIME" -type d -name 'test'         -prune -exec rm -rf {} + 2>/dev/null || true

# ── 7. Make the runtime relocatable ───────────────────────────────────────
# pyvenv stores the original interpreter path in `pyvenv.cfg` and embeds
# absolute paths into the activate scripts and the python shim. We replace
# the python shim with a launcher that resolves its own location, so the
# runtime can be moved anywhere (specifically: into Resources/ at build time
# and into /Applications/... at install time on the user machine).
echo "▶ Making runtime relocatable..."

# Replace bin/python3.10, bin/python3, bin/python with a shell launcher
# that re-execs the real interpreter from the user's $RUNTIME location.
# We achieve this by symlinking python -> python3 -> python3.10, then
# replacing python3.10 with a portable shim that uses $0 to find itself.
REAL_PY="$RUNTIME/bin/python3.10-real"

# The original python3.10 is currently a symlink into $PYENV_PREFIX. We
# need a *copy* of the actual binary, not a symlink, so the runtime works
# even after the user moves it off the build machine.
if [ -L "$RUNTIME/bin/python3.10" ]; then
  cp -f "$(readlink "$RUNTIME/bin/python3.10")" "$REAL_PY"
elif [ -f "$RUNTIME/bin/python3.10" ]; then
  cp -f "$RUNTIME/bin/python3.10" "$REAL_PY"
else
  echo "✗ Could not locate venv python3.10" >&2
  exit 1
fi
chmod +x "$REAL_PY"

# Wrapper script — sets PYTHONHOME so torch + friends find their data.
cat > "$RUNTIME/bin/python3.10" <<'SHIM'
#!/usr/bin/env bash
# AudioPro Python launcher — relocatable.
# Resolves $RUNTIME from its own filesystem location instead of relying
# on the absolute paths electron-builder will rewrite at packaging time.
set -e
SELF="${BASH_SOURCE[0]}"
while [ -L "$SELF" ]; do
  SELF="$(readlink "$SELF")"
done
RUNTIME_BIN="$(cd "$(dirname "$SELF")" && pwd)"
RUNTIME_ROOT="$(cd "$RUNTIME_BIN/.." && pwd)"
export PYTHONHOME="$RUNTIME_ROOT"
unset PYTHONPATH
exec "$RUNTIME_BIN/python3.10-real" "$@"
SHIM
chmod +x "$RUNTIME/bin/python3.10"

# Re-link python3 / python to point at the shim.
ln -sf python3.10 "$RUNTIME/bin/python3"
ln -sf python3.10 "$RUNTIME/bin/python"

# Rewrite pyvenv.cfg so it's path-agnostic. Without this, removing the
# build-time pyenv would break the runtime.
cat > "$RUNTIME/pyvenv.cfg" <<EOF
home = bin
include-system-site-packages = false
version = $PY_VERSION
EOF

# ── 8. Rewrite hard-coded shebangs in scripts (pip, etc.) ─────────────────
# The console scripts in $RUNTIME/bin/ have absolute /Users/... shebangs.
# Replace them with a portable "/usr/bin/env python3.10" so the launcher
# wins. We only touch real text files (skip binaries / data).
echo "▶ Patching shebangs..."
"$RUNTIME/bin/python3.10-real" - "$RUNTIME" <<'PY'
import os, sys
runtime = sys.argv[1]
bin_dir = os.path.join(runtime, "bin")
new_shebang = b"#!/usr/bin/env python3.10\n"
for name in os.listdir(bin_dir):
    full = os.path.join(bin_dir, name)
    if not os.path.isfile(full) or os.path.islink(full):
        continue
    try:
        with open(full, "rb") as f:
            head = f.read(2)
        if head != b"#!":
            continue
        with open(full, "rb") as f:
            data = f.read()
        nl = data.find(b"\n")
        if nl == -1:
            continue
        old_shebang = data[:nl + 1]
        if b"python" not in old_shebang:
            continue
        rewritten = new_shebang + data[nl + 1:]
        with open(full, "wb") as f:
            f.write(rewritten)
    except (PermissionError, OSError):
        continue
print("  shebangs patched")
PY

# ── 9. Smoke test: import resemble_enhance from the relocatable runtime ──
echo "▶ Smoke-testing relocatable runtime..."
"$RUNTIME/bin/python3.10" -c "import resemble_enhance, torch, soundfile; print(f'OK  torch={torch.__version__}  resemble_enhance={resemble_enhance.__file__}')"

# ── 10. Done ──────────────────────────────────────────────────────────────
SIZE=$(du -sh "$RUNTIME" | cut -f1)
echo
echo "✓ Done. Runtime ready at: $RUNTIME"
echo "  size: $SIZE"
echo "  to test:  $RUNTIME/bin/python3.10 src/python/enhance.py <in.wav> <out.wav> preset=ultra_subtle"
