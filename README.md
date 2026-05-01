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

Each file passes through up to 5 steps:

| Step | What it does |
|------|-------------|
| **Smart Analyze** | Measures loudness, noise floor, sibilance, reverb, and dynamic range to auto-configure the rest of the pipeline |
| **AI Denoise** | DeepFilterNet3 neural network removes background noise (Quality / Auto mode). Falls back to `afftdn` in Fast mode |
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
