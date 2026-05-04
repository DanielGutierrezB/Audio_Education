#!/usr/bin/env python3
"""
Speech enhancement using Resemble Enhance.
Downloads model on first run, then processes audio files.
Usage: python enhance.py <input.wav> <output.wav> [--denoise-only] [--device mps|cpu]
"""
import sys
import os
import types
import argparse
import time

# ── Mock deepspeed completely (only needed for training, not inference) ──
def _mock_deepspeed():
    """Create comprehensive deepspeed mock to avoid import errors."""
    import torch.nn as nn
    
    # Create all submodule mocks
    ds = types.ModuleType('deepspeed')
    ds_accel = types.ModuleType('deepspeed.accelerator')
    ds_runtime = types.ModuleType('deepspeed.runtime')
    ds_engine = types.ModuleType('deepspeed.runtime.engine')
    ds_utils = types.ModuleType('deepspeed.runtime.utils')
    
    # Accelerator
    def get_accelerator():
        return type('Accel', (), {
            'device_name': lambda self: 'cpu',
            'device': lambda self: 'cpu',
        })()
    ds_accel.get_accelerator = get_accelerator
    
    # DeepSpeedEngine — inherit from nn.Module so model methods work
    class MockEngine(nn.Module):
        def __init__(self, *args, **kwargs):
            super().__init__()
    ds_engine.DeepSpeedEngine = MockEngine
    
    # clip_grad_norm_
    ds_utils.clip_grad_norm_ = lambda *a, **kw: 0.0
    
    ds_runtime.engine = ds_engine
    ds_runtime.utils = ds_utils
    ds.runtime = ds_runtime
    ds.accelerator = ds_accel
    ds.DeepSpeedConfig = type('DeepSpeedConfig', (), {})
    
    # Register all in sys.modules
    for name, mod in [
        ('deepspeed', ds),
        ('deepspeed.accelerator', ds_accel),
        ('deepspeed.runtime', ds_runtime),
        ('deepspeed.runtime.engine', ds_engine),
        ('deepspeed.runtime.utils', ds_utils),
    ]:
        sys.modules[name] = mod

_mock_deepspeed()

# Now we can safely import
import torch
import torchaudio
from resemble_enhance.enhancer.inference import denoise, enhance


def main():
    parser = argparse.ArgumentParser(description='Enhance speech audio')
    parser.add_argument('input', help='Input WAV file')
    parser.add_argument('output', help='Output WAV file')
    parser.add_argument('--denoise-only', action='store_true',
                        help='Only denoise, skip enhancement')
    parser.add_argument('--device', default='auto',
                        help='Device: auto, mps, cpu')
    parser.add_argument('--lambd', type=float, default=0.9,
                        help='Denoise strength (0.0-1.0, higher=more denoise)')
    parser.add_argument('--tau', type=float, default=0.5,
                        help='CFM prior temperature (0.0-1.0)')
    parser.add_argument('--nfe', type=int, default=64,
                        help='Number of function evaluations (quality vs speed)')
    args = parser.parse_args()

    # Resolve device
    if args.device == 'auto':
        if torch.backends.mps.is_available():
            device = 'mps'
        elif torch.cuda.is_available():
            device = 'cuda'
        else:
            device = 'cpu'
    else:
        device = args.device
    
    print(f'[enhance] Device: {device}', file=sys.stderr)
    print(f'[enhance] Loading: {args.input}', file=sys.stderr)
    
    t0 = time.time()
    
    # Load audio
    dwav, sr = torchaudio.load(args.input)
    dwav = dwav.mean(0)  # mono
    
    print(f'[enhance] Input: {sr}Hz, {dwav.shape[-1]/sr:.1f}s', file=sys.stderr)
    
    if args.denoise_only:
        print('[enhance] Mode: denoise only', file=sys.stderr)
        hwav, out_sr = denoise(dwav=dwav, sr=sr, device=device)
    else:
        print(f'[enhance] Mode: full enhancement (lambd={args.lambd}, tau={args.tau}, nfe={args.nfe})', file=sys.stderr)
        hwav, out_sr = enhance(
            dwav=dwav, sr=sr, device=device,
            nfe=args.nfe, solver='midpoint',
            lambd=args.lambd, tau=args.tau,
        )
    
    # Save output
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    torchaudio.save(args.output, hwav[None], out_sr)
    
    elapsed = time.time() - t0
    print(f'[enhance] Done in {elapsed:.1f}s → {args.output}', file=sys.stderr)


if __name__ == '__main__':
    main()
