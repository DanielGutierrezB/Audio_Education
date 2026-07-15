# AudioPro

Professional voice processing for educational audio content. Drop WAV files (typically exported from Adobe Podcast), get course-ready output with consistent loudness and a polished voice EQ.

Current version: **v0.2.0** (macOS arm64 · Windows x64).

## Purpose

The intended workflow is:

1. Record and clean the voice with **Adobe Podcast** (or any clean source).
2. Drop the resulting WAV files into **AudioPro**.
3. AudioPro applies a fixed, transparent finishing chain — voice EQ + loudness
   normalization — so every class lands at **−16 LUFS** with the same tonal
   character and good presence, without re-denoising or re-generating audio
   that is already clean.

The app deliberately does **not** run ML denoise/enhancement: those stages
degraded already-clean Adobe Podcast material. FFmpeg is the only runtime
dependency; there is no Python and no neural network involved.

## Pipeline

Each file goes through 3 steps:

| Step | What it does |
|------|-------------|
| **Probe** | FFprobe reads duration / sample rate / channels. |
| **Measure** | Runs mono mixdown + EQ + `loudnorm` in measurement mode to capture integrated loudness (LUFS), true peak, LRA and threshold. |
| **Render** | Mono mixdown → resample (if needed) → EQ chain → `loudnorm` in linear mode to −16 LUFS / TP ≤ −2 dBTP. Files already at or above −16 LUFS skip loudnorm (only raise, never attenuate). |

The base EQ replicates a Waves F6 voice reference: HPF 80 Hz + three surgical
low-mid cuts (mud 150 Hz, box 280 Hz, honk 500 Hz) + presence peak (3.6 kHz)
+ air shelf (10 kHz), with an optional de-esser.

## EQ controls

- **EQ tab** — drag bands on a canvas with real-time Web Audio preview of the
  *source* file. On file selection the three cut bands auto-fit to the local
  spectral peaks of that voice (FFT analysis, ±1/3 octave). Every tweak
  auto-saves; **Process All** always renders what the editor shows.
- **Reset** returns to the base curve; **Bypass** A/Bs the preview without
  touching saved state.

## Output

- WAV 24-bit (default), WAV 16-bit, or FLAC — 48 kHz or 44.1 kHz.
- Files land in **`Audio_Pro/`** next to the source folder, or in a custom
  folder picked from the toolbar.

## Requirements

- **macOS** 10.12+ on Apple Silicon (M1/M2/M3), or **Windows 10+** x64
- Node.js 18+ (development)

`ffmpeg` / `ffprobe` are downloaded as static binaries by the setup scripts —
no Homebrew, no Rosetta, no system installs.

## Setup

```bash
npm install          # install Node deps
npm run setup:bin    # macOS: fetch arm64 ffmpeg/ffprobe into bin/ (SHA256-verified)
npm start            # run the app
```

On Windows:

```powershell
npm install
npm run setup:bin:win   # fetch ffmpeg.exe/ffprobe.exe into bin/
npm start
```

> **Heads-up for Cursor / VSCode users:** the integrated terminal sets `ELECTRON_RUN_AS_NODE=1`, which breaks Electron startup. Either `unset ELECTRON_RUN_AS_NODE` first, or launch from a regular Terminal.app window.

## Build

```bash
npm run build        # macOS arm64 DMG → dist/
npm run build:win    # Windows x64 NSIS installer → dist/
```

The artifacts are unsigned — first-time macOS users need to right-click →
**Open** to bypass Gatekeeper.

## Settings

All settings persist across sessions via `electron-store`: HPF frequency,
de-esser on/off, output format, sample rate, custom output dir, manual EQ
chain. Loudness target is fixed at −16 LUFS / TP ≤ −2 dBTP (podcast standard).

## Architecture

```
main.js                       Electron main process, IPC handlers, electron-store
preload.js                    Context bridge (renderer ↔ main)
renderer/
  index.html                  UI markup (Processing / EQ / About tabs)
  js/app.js                   Renderer logic — queue, settings, processing UI
  js/eq-editor.js             Canvas EQ editor + spectrum auto-fit + Web Audio preview
  styles/app.css              Styling
src/
  pipeline.js                 Probe → measure → render orchestration (FFmpeg)
  bin-paths.js                Resolves paths to bundled binaries (dev vs packaged)
  logger.js                   Structured logging (copyable from the app)
scripts/
  fetch-bin.sh                Downloads macOS arm64 ffmpeg / ffprobe (SHA256-pinned)
  fetch-bin.ps1               Downloads Windows x64 ffmpeg / ffprobe
bin/                          (gitignored) populated by the fetch scripts
```

## Known limitations

- Installers are not code-signed. Distribute over a trusted channel and
  instruct users to right-click → Open the first time (macOS).
