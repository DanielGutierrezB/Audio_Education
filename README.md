# AudioPro

Professional voice processing for educational audio content. Drop WAV files, get podcast-quality output in seconds.

Current version: **v0.1.2** (macOS arm64).

## Requirements

- macOS 10.12+ on Apple Silicon (M1 / M2 / M3)
- Node.js 18+
- _Optional_ — Python 3.10+ with `torch` and `torchaudio` for the BodyGen harmonic exciter step. Without these, BodyGen is silently skipped and the rest of the pipeline runs unaffected.

`ffmpeg`, `ffprobe`, and `deep-filter` are downloaded as **arm64-native, statically-linked binaries** by `npm run setup:bin` (no Homebrew, no Rosetta).

## Setup

```bash
npm install          # install Node deps
npm run setup:bin    # fetch arm64 ffmpeg / ffprobe / deep-filter into bin/ (SHA256-verified)
npm start            # run the app
```

> **Heads-up for Cursor / VSCode users:** the integrated terminal sets `ELECTRON_RUN_AS_NODE=1`, which breaks Electron startup. Either `unset ELECTRON_RUN_AS_NODE` first, or launch from a regular Terminal.app window.

## Build (macOS arm64 DMG)

```bash
npm run build
```

The output `.dmg` lands in `dist/`. The DMG is unsigned — first-time users need to right-click → **Open** to bypass Gatekeeper.

## Pipeline

Each file passes through up to 6 steps:

| Step | What it does |
|------|-------------|
| **Smart Analyze** | Measures loudness, noise floor, sibilance, reverb, dynamic range, plus an FFT voice-profile (pitch + resonant peaks). The analyzer can recommend per-file settings in Auto mode. |
| **Canonical Input** | Locks the file into AudioPro's working format: mono / 48 kHz / 16-bit pcm. Every downstream stage operates on this. |
| **AI Denoise** | DeepFilterNet3 neural denoise (Quality / Auto mode). Defaults to a soft `--atten-lim-db 18` to avoid the robotic / over-processed sound. Falls back to FFmpeg `afftdn` in Fast mode. |
| **Pre-process** | Stereo→Mono, noise gate, silence trim. |
| **BodyGen** | Harmonic exciter + sub-harmonic synthesis via analog-style waveshaping. Adds body and fullness to thin voice recordings. Requires Python with torch / torchaudio at runtime; skipped silently otherwise. |
| **EQ Measure → Render** | Voice-warm EQ chain (calibrated against Adobe Podcast spectral profile) → optional adaptive notches from voice-profile → optional manual override → 3-band compressor → limiter → two-pass `loudnorm` → output file. |

Output files land in **`Audio_Pro/`** next to the source folder, or in a custom folder if the user picks one in the toolbar.

## Processing Modes

- **Quality** — DeepFilterNet AI denoise + full pipeline.
- **Fast** — FFmpeg `afftdn` denoise + full pipeline.
- **Auto** — Smart analyzer chooses Quality or Fast per file based on measured noise floor.

## EQ controls

Three layers, in priority order:

1. **Manual EQ override** (EQ tab) — drag bands on a canvas with real-time Web Audio preview, then **Apply to all** to persist the FFmpeg filter chain. Replaces the entire built-in EQ when active.
2. **Adaptive EQ** (settings → EQ → "Adaptive EQ (per-file)") — appends per-file resonant notches derived from the voice-profile FFT to the static voice-warm curve. OFF by default.
3. **Voice-warm static curve** (always-on baseline) — HPF → +4 dB @120 Hz warmth → −2 dB @300 Hz boxiness cut → mild presence boosts → optional de-esser. Calibrated against Adobe Podcast spectral matching.

## Output

- WAV 24-bit 48 kHz (default)
- WAV 16-bit 48 kHz
- FLAC

Custom output directory configurable from the toolbar; the default is a sibling `Audio_Pro/` folder next to each source folder.

## Settings

All settings persist across sessions via `electron-store`. Defaults match podcast production standards (−16 LUFS, 48 kHz, WAV 24-bit, voice-warm EQ on, adaptive EQ off, manual EQ off).

## Architecture

```
main.js                       Electron main process, IPC handlers, electron-store
preload.js                    Context bridge (renderer ↔ main)
renderer/
  index.html                  UI markup (Processing / Preview / EQ / About tabs)
  js/app.js                   Renderer logic — queue, settings, processing UI
  js/eq-editor.js             Canvas EQ editor with Web Audio preview
  styles/app.css              Styling
src/
  pipeline.js                 Processing orchestration (FFmpeg + Python sidecars)
  analyzer.js                 Smart audio analysis (parallel measurements + voice profile)
  voice-profile.js            FFT-based pitch + resonant-peak detection
  bin-paths.js                Resolves paths to bundled binaries (dev vs packaged)
  logger.js                   Structured logging (copyable from the app)
  python/
    bodygen.py                Harmonic exciter (used in main pipeline)
    denoise.py                Legacy DFN wrapper (not used by current pipeline)
    enhance.py                Resemble Enhance wrapper (deferred, not wired up)
scripts/
  fetch-bin.sh                Downloads arm64 ffmpeg / ffprobe / deep-filter
bin/                          (gitignored) populated by fetch-bin.sh
```

## Known limitations

- DMG is not code-signed. Distribute over a trusted channel and instruct users to right-click → Open the first time.
- Resemble Enhance speech regeneration is **deferred** to a follow-up release. The infrastructure exists in `src/python/enhance.py` but is not wired to the pipeline. Tracked in repo issues.
