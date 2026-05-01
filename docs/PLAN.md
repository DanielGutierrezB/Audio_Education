# AudioPro v2 — Implementation Plan

## Phase 1: Project Skeleton & Build System
**Goal:** Electron app that opens, shows a window, and can be built into a .dmg

### Tasks:
1. Initialize npm project with package.json
2. Set up Electron with main.js, preload.js, renderer
3. Configure electron-builder for macOS arm64 DMG
4. Set up HTML/CSS/JS structure (no frameworks, vanilla)
5. Create 16:10 window (960×600) with vibrancy, hiddenInset titlebar
6. Dark theme base CSS
7. Basic navigation: Processing | Preview | About tabs
8. electron-store for preferences
9. Git init + first commit

## Phase 2: File Management & Queue
**Goal:** Users can add folders, see files queued

### Tasks:
1. "Add Folders" button with native folder dialog (multi-select)
2. Drag & drop folders onto app window
3. Scan folders for WAV files recursively (only .wav)
4. Display file queue grouped by folder
5. Show file metadata (name, duration, size) — use FFprobe
6. Queue state management: queued → processing → done → error
7. "Remove" button per folder
8. Persist last used folders in settings
9. Bundle FFmpeg + FFprobe static binaries for arm64 macOS

## Phase 3: FFmpeg Processing Pipeline (CPU-only, no ML)
**Goal:** Basic processing that works without Python — EQ, dynamics, normalization

### Tasks:
1. Create pipeline orchestrator in main process
2. Step 1 - Analysis: FFprobe to get audio metadata + LUFS measurement
3. Step 4 - EQ: HPF 80Hz + parametric EQ + de-esser via FFmpeg filters
4. Step 5 - Dynamics: compressor + limiter + loudness normalization to -16 LUFS
5. Step 6 - Output: convert to WAV 24-bit 48kHz, save to Audio_Pro/ folder
6. Progress reporting via IPC (current step, percentage, ETA)
7. Sequential file processing with queue advancement
8. Error handling: skip failed files, continue queue, report errors
9. Processing complete notification

## Phase 4: Python Sidecar & ML Models
**Goal:** DeepFilterNet + Resemble Enhance running as a local service

### Tasks:
1. Create Python FastAPI sidecar app
2. Health check endpoint: GET /health
3. DeepFilterNet integration:
   - Install deepfilternet package
   - POST /denoise endpoint: accepts WAV, returns denoised WAV
   - Test with sample audio files
4. Resemble Enhance integration:
   - Install resemble-enhance package  
   - POST /enhance endpoint: accepts WAV, returns enhanced WAV
   - Configure for MPS (Metal) GPU acceleration
   - Fallback to CPU if MPS unavailable
5. Pitch detection endpoint: POST /analyze-pitch
   - Returns fundamental frequency range
   - Used to auto-select EQ curve
6. Bundle Python sidecar with PyInstaller into single executable
7. Electron main process: start/stop/monitor sidecar lifecycle
8. Sidecar auto-starts on app launch, stops on quit
9. First-run: download models if not present (with progress UI)

## Phase 5: Full Pipeline Integration
**Goal:** All steps connected end-to-end

### Tasks:
1. Connect pipeline orchestrator to Python sidecar
2. Full pipeline flow: Analysis → DeepFilterNet → Resemble Enhance → FFmpeg EQ → FFmpeg Dynamics → Output
3. Adaptive EQ based on pitch detection results
4. Per-step progress tracking with accurate ETA
5. Parallel file processing option (configurable, default 1)
6. A/B preview: play original vs processed audio in renderer
7. Waveform visualization for preview (Web Audio API)
8. Processing mode setting: "Quality" (full pipeline) vs "Fast" (skip Resemble Enhance)

## Phase 6: UI Polish & About Tab
**Goal:** Tooltips, hover states, About tab, final polish

### Tasks:
1. Tooltips on every interactive element
2. Hover states and transitions
3. About tab: pipeline explanation with visual diagram
4. Settings panel: LUFS target, HPF freq, de-esser toggle, parallel files
5. EQ override view: 8-band parametric with curve visualization
6. Custom preset save/load
7. Drag & drop visual feedback
8. Error states and recovery UI
9. Responsive layout testing (resize behavior)

## Phase 7: Packaging & Distribution
**Goal:** Self-contained .dmg that works on any Apple Silicon Mac

### Tasks:
1. Bundle FFmpeg arm64 binary inside app
2. Bundle Python sidecar (PyInstaller onefile) inside app
3. Bundle all ML models inside app
4. Code signing considerations (ad-hoc for now)
5. DMG creation with electron-builder
6. Test on clean macOS installation
7. App icon design
8. README for the project

## Estimated Timeline

| Phase | Effort |
|-------|--------|
| 1. Skeleton | 2-3 hours |
| 2. File Management | 3-4 hours |
| 3. FFmpeg Pipeline | 4-5 hours |
| 4. Python Sidecar | 6-8 hours |
| 5. Full Integration | 4-6 hours |
| 6. UI Polish | 3-4 hours |
| 7. Packaging | 3-4 hours |
| **Total** | **~25-34 hours** |
