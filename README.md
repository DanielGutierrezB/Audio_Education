# AudioPro

Professional voice processing for educational audio content. Drop the raw
recording, or the raw recording **plus** its Adobe Podcast Enhance Speech
counterpart, and get course-ready output with consistent loudness and a
polished, full-bodied voice.

Current version: **v0.3.1** (macOS arm64 · Windows x64).

## Purpose

AudioPro accepts **two entry modes** (see `docs/PLAN.md` for the full design
rationale):

1. **Mode 1 — Original only.** Drop the raw take with no Adobe Podcast step.
   AudioPro analyzes it, applies conditional local denoise (RNNoise) only when
   the measured noise floor calls for it, repairs whatever the detectors
   actually flag (clipping, hum, clicks, silence padding), then masters it.
2. **Mode 2 — Original + Adobe Podcast at 100%.** Drop a folder containing the
   raw recordings **and** the `Enhanced/` subfolder that
   [`adobe-podcast-batch`](https://github.com/DanielGutierrezB/adobe-podcast-batch)
   writes when its "Voz limpia" slider is left at 100%. AudioPro pairs each
   file by name automatically, **fuses** the two signals to the ideal balance
   (by default: low end from the original, mids/highs from the enhanced
   track — restoring body and breaths that heavy AI denoise thins out), and
   masters from that best-of-both starting point.

In both modes the same finishing chain applies: conditional repair → tone
(EQ) → dynamics (leveler + optional parallel "body" compression) → dynamic
de-esser → two-pass loudness normalization to a delivery preset → true-peak
limiter → a fast re-measure to verify the render landed on target.

FFmpeg (+ its native `arnndn`/RNNoise filter) is the only processing runtime;
there is no Python and no external ML service. The Adobe Podcast step itself
stays a separate, manual run of `adobe-podcast-batch` — AudioPro auto-detects
its `Enhanced/` output folder convention, but does not (yet) drive Adobe's
API directly (see `docs/PLAN.md` §3.1 "Nivel 2 — Enhance embebido", not
implemented in this version).

## Pipeline

```
Mode 1: original ─────────────────────────────────────────────┐
Mode 2: original + enhanced ─▶ 0. Fuse (bands / bed crossover) ┤
                                                                ▼
                1. Analyze — one read-only ffmpeg pass: loudness (I/LRA/TP),
                   spectral rolloff, band energies, silence edges → QC flags
                                   │
                2. Clean — Mode 1 only: RNNoise, gated by measured noise
                   floor, strength scaled to how far over threshold it is
                                   │
                3. Repair — only the filters whose detector actually fired:
                   de-click (always, cheap) / de-clip / hum notch / silence trim
                                   │
                4. Tone + dynamics — HPF → EQ cuts (mud/box/honk) → leveling
                   compressor (skipped if already dense) → parallel "body"
                   compression → presence/air boosts (air skips on
                   band-limited sources) → dynamic de-esser (sibilance-gated)
                                   │
                5. Loudness — two-pass loudnorm to the selected delivery
                   preset, then a true-peak safety limiter
                                   │
                6. Verify — re-measure the render, badge ok/warn on the log
```

Nothing fires unless its detector actually flagged the input — already-clean
material takes the same path with the conditional stages skipped, not a
different code path.

## QC flags & artifact catalogue

Every file gets one read-only analysis pass before anything is written. The
detectors (thresholds documented in `src/metrics.js`, calibrated against the
synthetic fixtures in `test/fixtures.js`) surface as chips next to each queued
file:

| Flag | Meaning | Repair triggered |
|---|---|---|
| `CLIP` | Inter-sample or source clipping | `adeclip` |
| `HUM` | 50/60 Hz mains hum (+ 2nd harmonic) | `bandreject` notches |
| `SIBILANT` | Harsh/over-bright esses | dynamic de-esser |
| `NOISY` | Noise floor above threshold (Mode 1 only) | RNNoise, mix scaled to excess |
| `NO_AIR` | Band-limited source (rolloff < ~7 kHz) | air shelf skipped |
| `FLAT_DYNAMICS` | Already squashed (LRA < 3 LU) | leveler compression skipped |
| `DC_OFFSET` | DC bias | reported (HPF already removes it) |
| `SILENCE_HEAD` / `SILENCE_TAIL` | ≥1s of dead air at start/end | trimmed with a small pad |

See `docs/PLAN.md` §1.4 for the full A1–A14 catalogue, including artifacts
specific to Adobe Podcast's AI enhancement (robotic timbre, broken esses,
muffled starts/ends) and how Mode 2's fusion counteracts them.

## Delivery presets

Loudness target is a toolbar selector, not a fixed constant:

| Preset | Integrated loudness | True peak | Notes |
|---|---|---|---|
| **Platzi** (default) | −16 LUFS | ≤ −2 dBTP | Spoken-word convention; Platzi has no published spec (see `docs/PLAN.md` §5 D1/D2 — pending empirical validation against a published class) |
| **YouTube** | −14 LUFS | ≤ −1.5 dBTP | Matches YouTube's own normalization reference |
| **Podcast** | −16 LUFS | ≤ −1 dBTP | Apple Podcasts spec (ITU-R BS.1770-5) |

"Normalize" can raise-and-lower to match every class in a course to the exact
target, or "raise only" as a conservative legacy mode.

## EQ controls

- **EQ tab** — drag bands on a canvas with real-time Web Audio preview of the
  *source* file. On file selection the three cut bands auto-fit to the local
  spectral peaks of that voice (FFT analysis, ±1/3 octave). Every tweak
  auto-saves; **Process All** always renders what the editor shows.
- **Reset** returns to the base curve; **Bypass** A/Bs the preview without
  touching saved state.
- A manual EQ override replaces the built-in cuts+boosts curve entirely; the
  dynamic de-esser and optional exciter still apply on top of it.
- **Level-matched A/B** — a live "level-matched (±N dB)" readout next to
  Bypass shows the makeup gain needed so the EQ'd preview and the raw source
  play back at the same perceived loudness, derived from the same offline FFT
  used for auto-fit (not a fixed number). It recomputes whenever you switch
  source or move a band, so A/B comparisons can't be fooled by "louder sounds
  better".
- **Three-way A/B for Mode 2 pairs** — when the selected file has an
  `Enhanced/` pair, a second toggle (**Original / Enhanced / Fusion**)
  appears. "Fusion" renders an on-demand preview through the same filter
  graph `Process All` would use (cached per file + fusion settings), and
  switching sources hot-swaps the audio element in place, preserving
  playback position so you can A/B the exact same passage.

## QC tools

- **Spectrogram viewer** — right-click any queued file → **View
  spectrogram** to open a modal with an `showspectrumpic` render, useful for
  visually spotting hum lines, clipping, or musical-noise speckle from
  over-aggressive denoise.
- **Export QC report** — the toolbar button writes a Markdown summary of the
  whole batch (per-file mode, duration, QC flags, output verification badge,
  and a flagged-files detail section) to a location you choose, ready to
  attach to a course deliverable.

## Output

- WAV 24-bit (default), WAV 16-bit, or FLAC — 48 kHz or 44.1 kHz.
- Files land in **`Audio_Pro/`** next to the source folder, or in a custom
  folder picked from the toolbar.

## Requirements

- **macOS** 10.12+ on Apple Silicon (M1/M2/M3), or **Windows 10+** x64
- Node.js 18+ (development)

`ffmpeg` / `ffprobe` and the RNNoise model are downloaded as static,
SHA256-verified artifacts by the setup scripts — no Homebrew, no Rosetta, no
system installs.

## Setup

```bash
npm install          # install Node deps
npm run setup:bin    # macOS: fetch arm64 ffmpeg/ffprobe/RNNoise model into bin/
npm start            # run the app
```

On Windows:

```powershell
npm install
npm run setup:bin:win   # fetch ffmpeg.exe/ffprobe.exe/RNNoise model into bin/
npm start
```

> **Heads-up for Cursor / VSCode users:** the integrated terminal sets `ELECTRON_RUN_AS_NODE=1`, which breaks Electron startup. Either `unset ELECTRON_RUN_AS_NODE` first, or launch from a regular Terminal.app window.

## Testing

```bash
npm test    # node:test — generates synthetic fixtures on the fly, no bin/ needed
```

The suite (`test/`) builds its own WAV fixtures with ffmpeg's `lavfi` sources
(clean, noisy, hum, sibilant, clipped, band-limited, silence-padded, DC-biased
voice-like signals) and asserts on: every QC detector, preset conformity,
pairing (`Enhanced/` convention), the fusion filter graph, and full Mode
1/Mode 2 end-to-end renders (duration match, cancellation). Runs against
whatever `ffmpeg`/`ffprobe` is on `PATH` — no bundled binaries required. CI
runs it on every push/PR via `.github/workflows/test.yml`.

## Build

```bash
npm run build        # macOS arm64 DMG → dist/
npm run build:win    # Windows x64 NSIS installer → dist/
```

The artifacts are unsigned — first-time macOS users need to right-click →
**Open** to bypass Gatekeeper.

`.github/workflows/build-macos-dmg.yml` builds the same DMG on a macOS Actions
runner and attaches it to a GitHub Release whenever a `v*.*.*` tag is pushed
(or uploads it as a workflow artifact on a manual `workflow_dispatch` run,
without publishing a release).

## Settings

All settings persist across sessions via `electron-store`:

- **Delivery preset** (toolbar) — Platzi / YouTube / Podcast, see above.
- **Output** — format (WAV24/WAV16/FLAC), sample rate, custom output dir.
- **EQ** — HPF frequency, force de-esser on.
- **Dynamics & Body** — leveler (auto/off), local denoise (auto/off, Mode 1
  only), body amount (parallel compression blend), presence extra
  (`aexciter`, off by default), trim silence, normalize mode (both
  directions / raise only).
- **Fusion · Mode 2** — enable/disable, strategy (bands / bed / bands+bed),
  crossover frequency, original blend percentage.
- Manual EQ chain override (set from the EQ tab, not directly exposed as a
  toggle here).

## Architecture

```
main.js                       Electron main process, IPC handlers, electron-store
preload.js                    Context bridge (renderer ↔ main)
renderer/
  index.html                  UI markup (Processing / EQ / About tabs)
  js/app.js                   Renderer logic — queue, settings, processing UI, QC chips
  js/eq-editor.js             Canvas EQ editor + spectrum auto-fit + Web Audio preview
  styles/app.css              Styling
src/
  pipeline.js                 Per-file orchestration: fuse → analyze → repair → tone/dynamics → loudness → verify
  metrics.js                  QC analysis pass (loudness, bands, rolloff, silences) → flags
  pairing.js                  Detects original ↔ Enhanced/ pairs (adobe-podcast-batch convention)
  fusion.js                   Mode 2 blend (bands / bed / bands+bed filter graphs)
  presets.js                  Delivery loudness/TP/LRA targets per platform
  ffmpeg-run.js               Shared ffmpeg/ffprobe spawn helper (timeout, progress, cancellation)
  bin-paths.js                Resolves paths to bundled binaries + RNNoise model (dev vs packaged)
  logger.js                   Structured logging (copyable from the app)
  spectrogram.js              showspectrumpic PNG render for the QC spectrogram modal
  qc-report.js                Markdown QC report builder for the batch export button
test/
  fixtures.js                 Synthetic WAV generator (ffmpeg lavfi) for the corpus below
  *.test.js                   node:test suite — metrics, pairing, fusion, presets, pipeline,
                               ffmpeg-run, spectrogram, qc-report
scripts/
  fetch-bin.sh                Downloads macOS arm64 ffmpeg/ffprobe/RNNoise model (SHA256-pinned)
  fetch-bin.ps1                Downloads Windows x64 ffmpeg/ffprobe/RNNoise model
docs/
  PLAN.md                      Design doc + phased implementation plan + status
  DESIGN.md                    Earlier design notes
bin/                          (gitignored) populated by the fetch scripts
```

## Known limitations

- Installers are not code-signed. Distribute over a trusted channel and
  instruct users to right-click → Open the first time (macOS).
- The Platzi loudness target (−16 LUFS) is the general spoken-word/podcast
  convention, not a measured spec — see `docs/PLAN.md` §5 D1/D2 for the
  pending validation experiment (measure a published class's actual level).
- QC thresholds are calibrated against the synthetic corpus in `test/`, not
  yet against real course recordings (`docs/PLAN.md` §5 D4).
- Mode 2 relies on running `adobe-podcast-batch` separately and dropping its
  output folder; there is no embedded Adobe login/upload yet (`docs/PLAN.md`
  §3.1 Nivel 2 / Fase 10).
