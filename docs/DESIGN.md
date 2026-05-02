# AudioPro v2 — Design Specification

## Vision

Professional voice processing app for educational content. Takes any professor voice recording and delivers podcast-quality output — clean, equalized, leveled, no noise, no peaks, ready for any device.

**Principle:** "Drop files, get podcast quality." Excellent results with zero configuration. Advanced controls available when needed.

## Technical Stack

- **UI:** Electron (HTML/CSS/JS) — 16:10 window, responsive, minimalista
- **Backend:** Node.js main process
- **ML Processing:** Python sidecar (bundled with PyInstaller)
- **Audio Processing:** FFmpeg (bundled binary)
- **Distribution:** Self-contained .dmg — zero external dependencies

## User Flow

1. User opens app
2. Selects one or more folders containing WAV files
3. Clicks "Process" 
4. App processes all files through the pipeline automatically
5. Output appears in `Audio_Pro/` folder next to each input folder
6. User can preview A/B (original vs processed) before/after

## Input/Output Specification

- **Input:** WAV files (any quality, any sample rate)
- **Output:** WAV 24-bit 48kHz, always
- **Output location:** `Audio_Pro/` folder created as sibling of input folder
- **Naming:** Same filename as input, no suffix
- **Multiple queues:** Support adding multiple folders to process queue

## Processing Pipeline

### Step 1: Analysis (~2 seconds)
- FFprobe: detect format, sample rate, bit depth, channels, duration
- Pitch tracking: detect voice fundamental frequency range → auto-select EQ curve
- LUFS measurement: measure current loudness level
- Output: metadata object passed to subsequent steps

### Step 2: Denoising — DeepFilterNet v3 (~30-60s per 20min)
- Full-band noise suppression at 48kHz
- Removes: background noise, fans, AC, street noise, hum
- Rust native binary, ARM64 optimized — runs on CPU, very fast
- Preserves voice character while removing noise floor

### Step 3: Speech Enhancement — Resemble Enhance (~3-5min per 20min)  
- AI-powered speech quality restoration
- Denoiser module: catches remaining noise DeepFilterNet missed
- Enhancer module: restores audio quality, extends bandwidth, improves clarity
- Removes: residual reverb, mic distortion, compression artifacts
- Runs on GPU via PyTorch MPS (Apple Silicon)
- This is the "Adobe Podcast-like" step — the magic

### Step 4: EQ + Filters — FFmpeg (~5 seconds)
- **High Pass Filter:** 80Hz, 12dB/oct (remove rumble)
- **Adaptive EQ:** Based on detected pitch range
  - Auto-selects optimal curve for the voice type
  - No manual "male/female" selection needed
  - Override available: manual 8-band parametric EQ
- **De-esser:** Dynamic attenuation of sibilants (4-8kHz range)
- **De-plosive:** Attenuate plosive transients (< 120Hz)

### Step 5: Dynamics — FFmpeg (~5 seconds)
- **Compressor:** Control dynamic range (ratio ~3:1, threshold ~-20dB)
- **Limiter:** Ceiling at -1dB (prevent clipping)
- **Loudness normalization:** Target -16 LUFS (podcast/streaming standard)
- Result: consistent volume, no peaks, comfortable listening on any device

### Step 6: Output
- Convert to WAV 24-bit 48kHz
- Save to `Audio_Pro/` with same filename
- Log processing report (optional)

## Architecture

```
┌─────────────────────────────────────┐
│         Electron App (UI)           │
│  HTML/CSS/JS                        │
│  - Folder selector / file queue     │
│  - Processing progress per file     │
│  - A/B Preview player               │
│  - EQ override (8-band parametric)  │
│  - Settings & presets               │
│  - "About" tab with pipeline info   │
│  - Tooltips/hovers on everything    │
└──────────────┬──────────────────────┘
               │ IPC (contextBridge)
┌──────────────▼──────────────────────┐
│       Node.js Main Process          │
│  - Pipeline orchestration           │
│  - FFmpeg/FFprobe subprocess calls  │
│  - Python sidecar management        │
│  - File I/O & queue management      │
│  - electron-store (preferences)     │
└──────────┬────────┬─────────────────┘
           │        │
    FFmpeg  │        │  HTTP localhost
   (binary) │        │
           │  ┌─────▼─────────────────┐
           │  │  Python Sidecar       │
           │  │  (FastAPI, bundled)    │
           │  │  - DeepFilterNet      │
           │  │  - Resemble Enhance   │
           │  │  - Pitch detection    │
           │  │  - GPU accel (MPS)    │
           │  └───────────────────────┘
           │
    ┌──────▼──────┐
    │   FFmpeg    │
    │  (bundled)  │
    │  EQ/Dyn/Out │
    └─────────────┘
```

## Bundled Dependencies (all inside .app)

| Component | Size | Purpose |
|-----------|------|---------|
| Electron | ~150MB | App shell |
| FFmpeg binary (arm64) | ~80MB | Audio processing |
| Python runtime (3.9) | ~30MB | ML inference |
| DeepFilterNet model | ~5MB | Denoising |
| Resemble Enhance models | ~500MB | Speech enhancement |
| PyTorch (MPS) | ~200MB | ML framework |
| **Total estimated** | **~1GB** | |

## UI Design

### Window
- 16:10 aspect ratio, default ~960×600
- Responsive: min 720×450, resizable
- macOS: vibrancy, hiddenInset titlebar
- Dark theme, clean typography

### Layout (two main views)

**View 1: Processing (default)**
```
┌──────────────────────────────────────────┐
│  [📁 Add Folders]  [▶ Process All]       │
│──────────────────────────────────────────│
│  Queue:                                   │
│  ┌──────────────────────────────────┐    │
│  │ 📂 /path/to/Curso_React/         │    │
│  │    clase_01.wav  ✅ Done (4:32)   │    │
│  │    clase_02.wav  🔄 Processing... │    │
│  │    clase_03.wav  ⏳ Queued        │    │
│  │                                    │    │
│  │ 📂 /path/to/Curso_Python/         │    │
│  │    intro.wav     ⏳ Queued        │    │
│  └──────────────────────────────────┘    │
│──────────────────────────────────────────│
│  Current: clase_02.wav                    │
│  [████████░░░░░░░░] 52% — Enhancement    │
│  Step 3/5 · ETA: 2:15                    │
└──────────────────────────────────────────┘
```

**View 2: Preview & EQ (per-file, optional)**
```
┌──────────────────────────────────────────┐
│  clase_01.wav                             │
│  ┌─────────────┐  ┌─────────────┐       │
│  │ ▶ Original  │  │ ▶ Processed │       │
│  │  [waveform]  │  │  [waveform]  │       │
│  └─────────────┘  └─────────────┘       │
│──────────────────────────────────────────│
│  EQ Override (optional):                  │
│  [curve visualization]                    │
│  60Hz  150  400  1k  2.5k  6k  12k  16k │
│  Presets: [Auto] [Save Custom]           │
└──────────────────────────────────────────┘
```

**View 3: About / Pipeline Info**
- Explains what each step does
- Shows which models are being used
- Version info

### Interactions
- Tooltips on every control explaining what it does
- Drag & drop folders onto the app
- Progress shows current step name + ETA
- Notification when batch completes

## Settings (persisted via electron-store)

- `processingMode`: "quality" (default) | "fast" (skip Resemble Enhance)
- `lufsTarget`: -16 (default)
- `hpfFrequency`: 80 (default)
- `deEsserEnabled`: true (default)
- `parallelFiles`: 1 (default, adjustable based on hardware)
- `customEqPresets`: [] (user-saved presets)
- `showNotifications`: true

## Future Considerations (not in v1)

- Custom fine-tuned model trained on Platzi data
- Auphonic API integration as "cloud enhanced" option
- Batch scheduling / watch folders
- Export to MP3/AAC
- Per-professor EQ profiles
