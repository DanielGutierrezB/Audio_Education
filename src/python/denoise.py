#!/usr/bin/env python3
"""DeepFilterNet3 denoiser for AudioPro.

Usage: python3 denoise.py <input.wav> <output.wav>

Reads a WAV file, runs DeepFilterNet3, writes the enhanced version.
Expects mono 48kHz input. Converts if needed.
"""

import sys
import time

def main():
    if len(sys.argv) < 3:
        print("Usage: denoise.py <input.wav> <output.wav>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    try:
        import torch
        import torchaudio as ta
    except ImportError as e:
        print(f"Error: Missing dependency — {e}. Run: pip install torch torchaudio", file=sys.stderr)
        sys.exit(2)

    try:
        from df.enhance import enhance, init_df
    except ImportError as e:
        print(f"Error: DeepFilterNet not installed — {e}. Run: pip install deepfilter", file=sys.stderr)
        sys.exit(2)

    # Prefer MPS (Apple Silicon GPU) → CUDA → CPU
    if torch.backends.mps.is_available():
        device = torch.device('mps')
    elif torch.cuda.is_available():
        device = torch.device('cuda')
    else:
        device = torch.device('cpu')

    print("DFN:loading", flush=True)
    model, df_state, _ = init_df()
    target_sr = df_state.sr()

    print("DFN:reading", flush=True)
    try:
        audio, sr = ta.load(input_path)
    except Exception as e:
        print(f"Error: Could not read input file — {e}", file=sys.stderr)
        sys.exit(1)

    # Convert to mono if stereo
    if audio.shape[0] > 1:
        audio = audio.mean(dim=0, keepdim=True)

    # Resample if needed
    if sr != target_sr:
        audio = ta.functional.resample(audio, sr, target_sr)

    duration = audio.shape[1] / target_sr
    print(f"DFN:processing:{duration:.1f}", flush=True)

    t0 = time.time()
    enhanced = enhance(model, df_state, audio)
    elapsed = time.time() - t0

    print(f"DFN:saving:{elapsed:.1f}", flush=True)
    try:
        ta.save(output_path, enhanced, target_sr)
    except Exception as e:
        print(f"Error: Could not write output file — {e}", file=sys.stderr)
        sys.exit(1)

    print(f"DFN:done:{elapsed:.1f}", flush=True)


if __name__ == "__main__":
    main()
