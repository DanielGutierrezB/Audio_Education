#!/usr/bin/env python3
"""DeepFilterNet3 denoiser for AudioPro.

Usage: python3 denoise.py <input.wav> <output.wav>

Reads a WAV file, runs DeepFilterNet3, writes the enhanced version.
Expects mono 48kHz input. Converts if needed.
"""

import sys
import time
import torch
import torchaudio as ta

def main():
    if len(sys.argv) < 3:
        print("Usage: denoise.py <input.wav> <output.wav>", file=sys.stderr)
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]

    # Import after args check to fail fast on bad usage
    from df.enhance import enhance, init_df

    print("DFN:loading", flush=True)
    model, df_state, _ = init_df()
    target_sr = df_state.sr()

    print("DFN:reading", flush=True)
    audio, sr = ta.load(input_path)

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
    ta.save(output_path, enhanced, target_sr)

    print(f"DFN:done:{elapsed:.1f}", flush=True)


if __name__ == "__main__":
    main()
