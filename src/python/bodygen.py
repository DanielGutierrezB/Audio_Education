#!/usr/bin/env python3
"""Harmonic body generator for AudioPro.

Generates new harmonic and sub-harmonic content via analog-style waveshaping,
giving voice recordings more body and fullness — similar to what Adobe Podcast
achieves with ML but using deterministic DSP that preserves naturalness.

Usage: python3 bodygen.py <input.wav> <output.wav> [--mix 0.12] [--sub-mix 0.06]

Expects mono WAV input. Output is same sample rate/format.
"""

import sys
import os
import argparse
import time


def parse_args():
    parser = argparse.ArgumentParser(description='Harmonic body generator')
    parser.add_argument('input', help='Input WAV file path')
    parser.add_argument('output', help='Output WAV file path')
    parser.add_argument('--mix', type=float, default=0.12,
                        help='Harmonic exciter mix level (0.0-0.5, default 0.12)')
    parser.add_argument('--sub-mix', type=float, default=0.06,
                        help='Sub-harmonic mix level (0.0-0.3, default 0.06)')
    parser.add_argument('--low-freq', type=float, default=80,
                        help='Lower frequency bound for exciter (default 80)')
    parser.add_argument('--high-freq', type=float, default=350,
                        help='Upper frequency bound for exciter (default 350)')
    return parser.parse_args()


def main():
    args = parse_args()

    try:
        import torch
        import torchaudio
    except ImportError as e:
        print(f"Error: Missing dependency — {e}. Run: pip install torch torchaudio",
              file=sys.stderr)
        sys.exit(2)

    t0 = time.time()

    # Load audio
    waveform, sr = torchaudio.load(args.input)

    # Convert to mono if needed
    if waveform.shape[0] > 1:
        waveform = waveform.mean(dim=0, keepdim=True)

    n = waveform.shape[-1]

    # ── Harmonic Exciter ──
    # Extract the body frequency range, apply waveshaping to generate harmonics,
    # then mix back. This creates NEW frequency content (not just EQ boost).
    fft = torch.fft.rfft(waveform)
    freqs = torch.fft.rfftfreq(n, d=1.0 / sr)

    # Smooth bandpass mask for body range
    mask = torch.zeros_like(freqs)
    lo, hi = args.low_freq, args.high_freq
    transition = 20.0  # Hz crossfade width

    in_band = (freqs >= lo) & (freqs <= hi)
    mask[in_band] = 1.0

    # Smooth low edge
    lo_edge = (freqs >= lo - transition) & (freqs < lo)
    if lo_edge.any():
        mask[lo_edge] = (freqs[lo_edge] - (lo - transition)) / transition

    # Smooth high edge
    hi_edge = (freqs > hi) & (freqs <= hi + transition)
    if hi_edge.any():
        mask[hi_edge] = 1.0 - (freqs[hi_edge] - hi) / transition

    # Extract band
    band_fft = fft * mask
    band_audio = torch.fft.irfft(band_fft, n=n)

    # Waveshaping: soft saturation (generates odd harmonics — warm, tube-like)
    saturated = torch.tanh(band_audio * 3.0) / 3.0

    # Even harmonics (asymmetric clipping — more musical, tape-like)
    even_harm = torch.tanh(band_audio * 2.0 + 0.3) / 2.0 - 0.15

    # Blend odd + even harmonics
    harmonics = saturated * 0.6 + even_harm * 0.4

    # Mix with original
    result = waveform + harmonics * args.mix

    # ── Sub-Harmonic Synthesis ──
    # Generate sub-octave from voice fundamentals (80-200Hz)
    # Uses half-wave rectification — classic analog sub-bass technique
    if args.sub_mix > 0:
        sub_fft = torch.fft.rfft(waveform)
        sub_mask = torch.zeros_like(freqs)
        sub_band = (freqs >= 80) & (freqs <= 200)
        sub_mask[sub_band] = 1.0

        fund_fft = sub_fft * sub_mask
        fund = torch.fft.irfft(fund_fft, n=n)

        # Half-wave rectification creates sub-octave
        sub = torch.clamp(fund, min=0) * 2 - fund.abs() * 0.5

        # Low pass the sub to keep only the sub-harmonic
        sub_rfft = torch.fft.rfft(sub)
        lp_mask = (freqs <= 150).float()
        sub_filtered = torch.fft.irfft(sub_rfft * lp_mask, n=n)

        result = result + sub_filtered * args.sub_mix

    # Normalize to prevent clipping
    peak = result.abs().max()
    if peak > 0.95:
        result = result * (0.95 / peak)

    # Save — match input format
    torchaudio.save(args.output, result, sr)

    elapsed = time.time() - t0
    print(f"[bodygen] Done in {elapsed:.1f}s — mix={args.mix}, sub={args.sub_mix}", flush=True)


if __name__ == '__main__':
    main()
