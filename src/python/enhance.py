#!/usr/bin/env python3
"""Resemble Enhance speech regeneration for AudioPro.

Usage: python3 enhance.py <input.wav> <output.wav> [options]

Options (key=value):
  preset=light|balanced|broadcast|aggressive   (default: broadcast)
  lambd=<float>                                 (overrides preset; 0.0..1.0)
  tau=<float>                                   (overrides preset; 0.0..1.0)
  nfe=<int>                                     (overrides preset; 1..128)
  device=cpu|cuda                               (default: cpu — MPS is BUGGY)

Notes:
  - Uses soundfile (avoids torchaudio/torchcodec dependency hell).
  - Defaults to CPU. MPS produces near-silent output on Apple Silicon
    (resemble-enhance bug). CUDA works fine when available.
  - Sanity check: aborts with exit code 3 if the model produces near-silent
    output (RMS < 0.005), which would amplify noise downstream when
    loudness-normalized.
"""

import math
import sys


# Presets are tuned for QUALITY first, with speed as a secondary concern.
# Each preset has a base (nfe=128, the upstream maximum, max quality) and a
# 'fast' variant (nfe=64, ~1.7x faster, very similar diffusion output).
#
# nfe controls the number of diffusion sampler steps. Lower = faster but the
# diffusion output diverges more from the maximum-quality reference.
# midpoint solver is what upstream uses by default and is the most stable.
PRESETS = {
    # Quality presets (upstream nfe=128, recommended default)
    "light":      {"lambd": 0.9, "tau": 0.5, "nfe": 128, "solver": "midpoint"},
    "balanced":   {"lambd": 0.7, "tau": 0.5, "nfe": 128, "solver": "midpoint"},
    "broadcast":  {"lambd": 0.4, "tau": 0.5, "nfe": 128, "solver": "midpoint"},  # default; ~60% regen
    "aggressive": {"lambd": 0.2, "tau": 0.7, "nfe": 128, "solver": "midpoint"},
    # Fast presets (nfe=64; ~1.7x speed, near-identical diffusion output)
    "light_fast":      {"lambd": 0.9, "tau": 0.5, "nfe": 64, "solver": "midpoint"},
    "balanced_fast":   {"lambd": 0.7, "tau": 0.5, "nfe": 64, "solver": "midpoint"},
    "broadcast_fast":  {"lambd": 0.4, "tau": 0.5, "nfe": 64, "solver": "midpoint"},
    "aggressive_fast": {"lambd": 0.2, "tau": 0.7, "nfe": 64, "solver": "midpoint"},
}


def parse_kv(args):
    """Parse key=value pairs from command-line args."""
    out = {}
    for a in args:
        if "=" in a:
            k, v = a.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def main():
    if len(sys.argv) < 3:
        print("Usage: enhance.py <input.wav> <output.wav> [preset=broadcast] "
              "[lambd=...] [tau=...] [nfe=...] [device=cpu]", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    opts = parse_kv(sys.argv[3:])

    preset_name = opts.get("preset", "broadcast")
    if preset_name not in PRESETS:
        print(f"Error: unknown preset '{preset_name}'. "
              f"Valid: {', '.join(PRESETS)}", file=sys.stderr)
        sys.exit(1)

    params = dict(PRESETS[preset_name])
    if "lambd" in opts:  params["lambd"]  = float(opts["lambd"])
    if "tau" in opts:    params["tau"]    = float(opts["tau"])
    if "nfe" in opts:    params["nfe"]    = int(opts["nfe"])
    if "solver" in opts: params["solver"] = opts["solver"]

    requested_device = opts.get("device", "cpu")

    # ── Imports (lazy) ──
    try:
        import numpy as np
        import soundfile as sf
        import torch
    except ImportError as e:
        print(f"Error: Missing dependency — {e}. "
              "Run: pip install torch soundfile numpy", file=sys.stderr)
        sys.exit(2)

    try:
        from resemble_enhance.enhancer.inference import enhance as re_enhance
    except ImportError as e:
        print(f"Error: resemble-enhance not installed — {e}. "
              "Run: pip install resemble-enhance", file=sys.stderr)
        sys.exit(2)

    # Resolve device, with MPS warning + fallback
    if requested_device == "mps":
        print("Warning: MPS is buggy in resemble-enhance "
              "(near-silent output). Forcing CPU.", file=sys.stderr)
        requested_device = "cpu"
    if requested_device == "cuda" and not torch.cuda.is_available():
        print("Warning: CUDA not available, falling back to CPU.", file=sys.stderr)
        requested_device = "cpu"
    device = requested_device

    print(f"RE:loading device={device} preset={preset_name} "
          f"lambd={params['lambd']} tau={params['tau']} nfe={params['nfe']}",
          flush=True)

    # ── Read input (soundfile, robust across formats) ──
    try:
        data, sr = sf.read(input_path, always_2d=True)
    except Exception as e:
        print(f"Error: Could not read input file — {e}", file=sys.stderr)
        sys.exit(1)

    if data.shape[1] > 1:
        data = data.mean(axis=1, keepdims=True)
    mono = data[:, 0].astype(np.float32)

    duration_s = len(mono) / float(sr)
    print(f"RE:processing duration={duration_s:.2f}s sr={sr}", flush=True)

    audio = torch.from_numpy(mono)

    # ── Hook tqdm.trange in the modules that resemble-enhance actually uses.
    # Two places matter for chunk-level progress:
    #   - resemble_enhance.inference            (top-level chunk loop)
    #   - resemble_enhance.enhancer.lcfm.cfm    (diffusion inner steps)
    # Both do `from tqdm import trange`, so they capture a reference at import
    # time. We must rebind the symbol on the module objects themselves.
    import time
    try:
        import tqdm as _tqdm_mod

        # Channel labels so the Node side can show meaningful sub-progress
        def _mk_trange(label):
            def _trange(*args, **kwargs):
                # Force disabling tqdm's own bar (keeps our stdout clean)
                kwargs.setdefault("disable", True)
                # Build a plain range and yield items while emitting progress
                if len(args) == 1:
                    start, stop, step = 0, int(args[0]), 1
                elif len(args) == 2:
                    start, stop, step = int(args[0]), int(args[1]), 1
                else:
                    start, stop, step = int(args[0]), int(args[1]), int(args[2])
                total = max(0, (stop - start + step - 1) // step) if step > 0 else 0

                class _Iter:
                    def __iter__(self_inner):
                        for idx, i in enumerate(range(start, stop, step)):
                            print(f"RE:progress {label} {idx}/{total}", flush=True)
                            yield i
                        # Emit a final tick so UI lands on 100%
                        print(f"RE:progress {label} {total}/{total}", flush=True)
                    # Some callers wrap it directly; emulate the basic API
                    def __len__(self_inner):
                        return total
                return _Iter()
            return _trange

        # Patch on the modules that already imported `trange` at import time
        import resemble_enhance.inference as _ri_top
        _ri_top.trange = _mk_trange("chunk")

        import resemble_enhance.enhancer.lcfm.cfm as _ri_cfm
        _ri_cfm.trange = _mk_trange("diffusion")

        # The diffusion sampler lives in the `Solver` base class (CFM inherits
        # from it). It picks one of these static methods via the `_step`
        # property:  _euler_step, _midpoint_step, _rk4_step.
        # We wrap the property to (a) reset our counter at the start of each
        # solve() and (b) return wrapped step functions that emit progress.
        try:
            import resemble_enhance.enhancer.lcfm.cfm as _cfm_mod
            _Solver = _cfm_mod.Solver

            # Module-level counter — simple and resilient across instances
            _cfm_mod._progress_count = {"cur": 0, "total": 0}

            _orig_euler    = _Solver._euler_step
            _orig_midpoint = _Solver._midpoint_step
            _orig_rk4      = _Solver._rk4_step

            def _make_wrapped(orig_fn):
                def wrapped(*args, **kwargs):
                    state = _cfm_mod._progress_count
                    cur = state["cur"]
                    total = state["total"]
                    if total > 0:
                        print(f"RE:progress diffusion {cur}/{total}", flush=True)
                    state["cur"] = cur + 1
                    return orig_fn(*args, **kwargs)
                return wrapped

            _wrapped_euler    = _make_wrapped(_orig_euler)
            _wrapped_midpoint = _make_wrapped(_orig_midpoint)
            _wrapped_rk4      = _make_wrapped(_orig_rk4)

            def _patched_step_picker(self):
                # Reset counter at the start of each solve() invocation
                if _cfm_mod._progress_count["total"] != self.n_steps or \
                   _cfm_mod._progress_count["cur"] >= self.n_steps:
                    _cfm_mod._progress_count["cur"]   = 0
                    _cfm_mod._progress_count["total"] = self.n_steps
                if self.method == "euler":
                    return _wrapped_euler
                if self.method == "midpoint":
                    return _wrapped_midpoint
                if self.method == "rk4":
                    return _wrapped_rk4
                # Unknown method — fall back to original behaviour
                return getattr(_Solver, f"_{self.method}_step")

            _Solver._step = property(_patched_step_picker)
        except Exception as _e:
            print(f"RE:progress-cfm-step-wrap-disabled {_e}", file=sys.stderr, flush=True)
    except Exception as e:
        # Progress hook is best-effort — don't fail the whole run if it breaks
        print(f"RE:progress-hook-disabled {e}", file=sys.stderr, flush=True)

    # ── Run model ──
    t0 = time.time()
    try:
        result, new_sr = re_enhance(
            dwav=audio,
            sr=sr,
            device=device,
            nfe=params["nfe"],
            solver=params.get("solver", "midpoint"),
            lambd=params["lambd"],
            tau=params["tau"],
        )
    except Exception as e:
        print(f"Error: Resemble Enhance failed — {e}", file=sys.stderr)
        sys.exit(2)
    elapsed = time.time() - t0

    out = result.detach().cpu().numpy().astype(np.float32)

    # ── Sanity check: catch the MPS-style silent-output bug ──
    rms = float(math.sqrt((out.astype("float64") ** 2).mean()))
    if rms < 0.005:
        print(f"Error: Resemble produced near-silent output (RMS={rms:.5f}). "
              "Likely a model or device bug. Aborting so caller can fall back.",
              file=sys.stderr)
        sys.exit(3)

    # ── Save (float WAV, preserve precision; downstream may resample/quantize) ──
    print(f"RE:saving rms={rms:.4f} out_sr={new_sr} elapsed={elapsed:.1f}s",
          flush=True)
    try:
        sf.write(output_path, out, new_sr, subtype="FLOAT")
    except Exception as e:
        print(f"Error: Could not write output file — {e}", file=sys.stderr)
        sys.exit(1)

    print(f"RE:done elapsed={elapsed:.1f}s", flush=True)


if __name__ == "__main__":
    main()
