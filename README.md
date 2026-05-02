# AudioPro

Professional voice processing for educational audio content. Drop WAV files, get podcast-quality 24-bit output in seconds.

## Requirements

- macOS (Apple Silicon recommended)
- Node.js 18+
- FFmpeg and FFprobe available on `$PATH` (`brew install ffmpeg`)
- Python 3.10+ with pip

### Optional — AI Denoising (Quality mode)

```bash
pip install deepfilter torch torchaudio
```

Without these, AudioPro falls back to FFmpeg's `afftdn` denoise in Quality mode.

### Optional — Speech Regeneration (Adobe Enhance Speech style)

```bash
pip install resemble-enhance soundfile
```

This enables Step 3 (Speech Regeneration) using Resemble Enhance. The model
regenerates degraded voice using a diffusion model, similar to what Adobe
Podcast Enhance does. Off by default; auto-enabled by Smart Analyze when
the audio has heavy noise + reverb, or can be forced from the UI.

> **macOS note:** Resemble Enhance has a known bug on MPS (Apple Silicon GPU)
> where it produces near-silent output. AudioPro forces CPU on macOS for safety.
> First run downloads ~680 MB of model weights to `~/.cache/resemble-enhance/`.
>
> If you need a different Python interpreter, set `AUDIOPRO_PYTHON=/path/to/python3.12`.

#### Speed/quality tradeoff

AudioPro **prioritizes quality** and uses upstream `nfe=128` with the midpoint
solver as the default for all main presets. For users who want a faster pass,
every preset has a `_fast` variant (`broadcast_fast`, `aggressive_fast`, etc.)
which uses `nfe=64` — about 1.7x faster with near-identical diffusion output.

Empirical numbers on a 60s clip on Apple Silicon CPU:

| Config                  | nfe | Time  | Speedup | Notes                          |
|-------------------------|-----|-------|---------|--------------------------------|
| **AudioPro default**     | 128 | ~116s | 1.0x    | upstream max quality (default) |
| `*_fast` variants        | 64  | ~70s  | 1.7x    | near-identical to default       |
| `nfe=32` (not exposed)   | 32  | ~46s  | 2.5x    | noticeable diffusion divergence |

(A multi-process parallel runner was tested but removed. PyTorch CPU is
already multi-threaded internally, and per-worker model loading (~3-5s)
wiped most of the gains. Speedup was only ~1.2x for the added complexity.)

## Setup

```bash
npm install
npm start
```

## Build (macOS arm64 DMG)

```bash
npm run build
```

The output `.dmg` will be in `dist/`.

## Pipeline

Each file passes through up to 6 steps (Speech Regeneration is opt-in):

| Step | What it does |
|------|-------------|
| **Smart Analyze** | Measures loudness, noise floor, sibilance, reverb, and dynamic range to auto-configure the rest of the pipeline |
| **AI Denoise** | DeepFilterNet3 neural network removes background noise (Quality / Auto mode). Falls back to `afftdn` in Fast mode |
| **Speech Regen.** *(opt-in)* | Resemble Enhance regenerates degraded voice with a diffusion model. Auto-enabled for heavily degraded audio, otherwise off |
| **Pre-process** | Stereo→Mono, noise gate, silence trim |
| **EQ Measure** | Applies full EQ+dynamics chain in null output mode to gather loudness stats for two-pass normalization |
| **Render** | EQ → 3-band compressor → limiter → loudnorm → output file |

Output files land in `Audio_Pro/` next to the source folder.

## Processing Modes

- **Quality** — DeepFilterNet AI denoise + full pipeline (~0.75× realtime)
- **Fast** — FFmpeg `afftdn` denoise + full pipeline (~0.12× realtime)
- **Auto** — Smart analyzer chooses quality or fast per file based on measured noise floor

## Output Formats

- WAV 24-bit 48 kHz (default, best quality)
- WAV 16-bit 48 kHz (smaller files)
- FLAC (lossless compression)

## Settings

All settings persist across sessions via `electron-store`. Defaults match podcast production standards (−16 LUFS, 48 kHz, WAV 24-bit).

## Architecture

```
main.js          — Electron main process, IPC handlers, electron-store
preload.js       — Context bridge (renderer ↔ main)
renderer/
  index.html     — UI markup
  js/app.js      — Renderer logic (queue, preview, settings)
  styles/app.css — Styling
src/
  pipeline.js    — Processing orchestration (FFmpeg calls)
  analyzer.js    — Smart audio analysis (6 parallel measurements)
  python/
    denoise.py   — DeepFilterNet3 wrapper script
```
