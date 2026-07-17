# AudioPro

Professional voice processing for educational audio content. Drop the raw
recording and get course-ready output with consistent loudness and a
polished, full-bodied voice — including the Adobe Podcast Enhance Speech
step, now embedded: the whole process runs from one interface.

Current version: **v0.6.0** (macOS arm64 · Windows x64).

## Purpose

AudioPro accepts **three entry paths** (see `docs/PLAN.md` for the full
design rationale):

1. **Mode 1 — Original only.** Drop the raw take with no Adobe Podcast step.
   AudioPro analyzes it, applies conditional local denoise (RNNoise) only when
   the measured noise floor calls for it, repairs whatever the detectors
   actually flag (clipping, hum, silence padding — mouth clicks get a safe,
   unconditional de-click pass since there's no reliable detector for those),
   then masters it.
2. **Mode 2 — Original + Adobe Podcast at 100%.** Drop a folder containing the
   raw recordings **and** an `Enhanced/` subfolder — written either by
   AudioPro's own embedded Enhance (below) or by a manual run of
   [`adobe-podcast-batch`](https://github.com/DanielGutierrezB/adobe-podcast-batch)
   with its "Voz limpia" slider left at 100%. AudioPro pairs each file by
   name automatically, **fuses** the two signals to the ideal balance
   (by default: low end from the original, mids/highs from the enhanced
   track — restoring body and breaths that heavy AI denoise thins out), and
   masters from that best-of-both starting point.
3. **Embedded Enhance — the whole process in one click.** Turn on
   **Enhance with Adobe** in Settings, connect your Adobe account once, and
   drop just the raw takes. On **Process All**, AudioPro uploads each
   unpaired file to Adobe Podcast Enhance Speech itself (5 in parallel,
   waiting out credit limits automatically), saves the 100% clean voice to
   `Enhanced/` next to the original, then continues as Mode 2 — fusion +
   mastering — with no manual handoff between tools.

In all paths the same finishing chain applies: conditional repair → tone
(EQ) → dynamics (leveler + optional parallel "body" compression) → dynamic
de-esser → two-pass loudness normalization to a delivery preset → true-peak
limiter → a fast re-measure to verify the render landed on target.

FFmpeg (+ its native `arnndn`/RNNoise filter) is the only local processing
runtime; there is no Python and no external ML service. The embedded Enhance
stage reuses the proven client from `adobe-podcast-batch` (ported into
`src/enhance/`, see `docs/PLAN.md` §3.1 "Nivel 2 — Enhance embebido") and
talks to Adobe's internal Enhance Speech endpoint with your own Adobe
session. Running `adobe-podcast-batch` separately still works exactly as
before — its output folders are detected and never re-uploaded.

## Pipeline

```
Mode 1: original ────────────────────────────────────────────────┐
Embedded Enhance: original ─▶ −1. Enhance (upload to Adobe,      │
   save 100% clean voice to Enhanced/, wait out credit limits) ─┐│
Mode 2: original + enhanced ─▶ 0. Fuse (bands / bed crossover) ─┴┤
                                                                ▼
                1. Analyze — one read-only ffmpeg pass: loudness (I/LRA/TP),
                   spectral rolloff, band energies, silence edges → QC flags
                                   │
                2. Clean — Mode 1 only: RNNoise, gated by measured noise
                   floor, strength scaled to how far over threshold it is
                                   │
                3. Repair — de-click always runs (cheap, no reliable click
                   detector exists); de-clip / hum notch / silence trim only
                   when their own detector actually fired
                                   │
                4. Tone + dynamics — HPF → EQ cuts (mud/box/honk) → leveling
                   compressor (skipped if already dense) → parallel "body"
                   compression → presence/air boosts (air skips on
                   band-limited sources) → dynamic de-esser (sibilance-gated)
                                   │
                5. Loudness — two-pass loudnorm to the selected delivery
                   preset, then a true-peak safety limiter
                                   │
                6. Verify — re-measure the render, badge ok/warn on the file row
```

Nothing else fires unless its detector actually flagged the input (de-click above
is the one always-on exception) — already-clean material takes the same path
with the conditional stages skipped, not a different code path.

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

## Embedded Adobe Enhance

The `adobe-podcast-batch` engine now lives inside AudioPro (`src/enhance/`),
so the full raw-take → clean voice → fusion → master run happens without
leaving the app:

- **Connect once.** Settings → Adobe Enhance → **Connect** opens Adobe's own
  login (`podcast.adobe.com`) in a window; the session token is extracted
  in-memory and stored encrypted with the OS keychain (`safeStorage`). The
  session persists across restarts and re-authenticates silently when the
  token expires mid-batch.
- **Enhance with Adobe** (toggle). When on, **Process All** first uploads
  every queued file that doesn't already have an `Enhanced/` pair — 5 in
  parallel, the same ceiling Adobe applies per account. When Adobe runs out
  of credits the whole batch pauses with a visible countdown and resumes by
  itself; nothing is lost and nothing needs re-clicking.
- **Every intermediate is saved**, not just the final master:
  - the **original** is never touched;
  - the **100% clean voice** ("generated with Enhance") persists in
    `Enhanced/` next to the original — the exact folder convention
    `adobe-podcast-batch` uses, so the pair keeps working with either tool;
  - an optional **percentage mix** (N% clean + (100−N)% original, the
    "Clean voice mix" slider) is rendered locally with FFmpeg into
    `Enhanced/Mix N/` — no extra Adobe credits;
  - the **mastered output** lands in `Audio_Pro/` as always.
- **No double spending.** Files that already have an `Enhanced/<name>.wav`
  on disk (from a previous run of AudioPro or of `adobe-podcast-batch`) skip
  the upload entirely and go straight to fusion. Fusion always works from
  the two pure signals (original + 100% clean), never from a pre-blended
  mix — so you can re-fuse with different settings forever without paying
  Adobe again.
- **Risk note:** the Enhance endpoint is Adobe-internal and unofficial (the
  same one `adobe-podcast-batch` has always used); it can change without
  notice. If it does, Mode 2 with a manually produced `Enhanced/` folder and
  Mode 1 keep working as fallbacks.

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
  *source* file (scroll over a band to change its Q, shift-click to toggle it
  on/off). On file selection the three cut bands auto-fit to the local
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

## Updating the app

The version pill in the titlebar (⟳ v0.6.0) is the updater. Same
architecture as the Sync app (`sync-app` → `sync-releases`): the source
repo stays private, and built artifacts + update metadata are published to
the **public releases-only repo**
[`audiopro-releases`](https://github.com/DanielGutierrezB/audiopro-releases),
so installed apps never need a token or login to update. The pill checks at
launch and every 30 minutes; when a newer version exists it highlights and
shows `v0.6.0 → v0.7.0`, clicking downloads the update (with a live
percentage on the pill) and relaunches into the new version.

- **Packaged install (DMG / installer)** — `electron-updater` reads
  `latest-mac.yml` / `latest.yml` from the latest `audiopro-releases`
  release, verifies the artifact's SHA-512, and installs the full new
  build (macOS: zip swap via Squirrel; Windows: silent NSIS). Because the
  whole app is replaced, updates that change dependencies or the bundled
  ffmpeg binaries are fine — no more "needs a fresh DMG" cases.
- **Dev checkout (has `.git`)** — `git fetch` + compare against `origin/main`;
  applying runs `git reset --hard origin/main`, and refuses to run at all if
  the checkout is on any branch other than `main` (so it can't wipe
  feature-branch work). Uses your own git credentials, so the private
  source repo is not an issue.
- **Publishing flow (CI)** — pushing a `v*.*.*` tag makes the macOS and
  Windows workflows build and `--publish always` to `audiopro-releases`
  via the `RELEASES_TOKEN` repo secret (a PAT with Contents read/write on
  `audiopro-releases` only). Nothing is published to this repo's own
  Releases anymore.

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
- Masters land in **`Audio_Pro/`** next to the source folder, or in a custom
  folder picked from the toolbar.
- With embedded Enhance on, the clean voices land in **`Enhanced/`** and the
  optional percentage mixes in **`Enhanced/Mix N/`**, both next to the
  originals (see "Embedded Adobe Enhance" above).

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
pairing (`Enhanced/` convention), the fusion filter graph, the embedded
enhance orchestration (credits gate, auth retry, `Enhanced/` reuse, the
`Mix N/` render — with the Adobe network client stubbed), and full Mode
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

`.github/workflows/build-macos-dmg.yml` and `.github/workflows/build-windows.yml`
build the zip+DMG and the NSIS installer on a macOS / Windows Actions runner
respectively (`windows-latest` is real Windows, so this is an actual build+
package smoke test, not a cross-compile guess) and publish both — plus the
`latest-mac.yml` / `latest.yml` metadata the in-app updater reads — to the
public [`audiopro-releases`](https://github.com/DanielGutierrezB/audiopro-releases)
repo whenever a `v*.*.*` tag is pushed (or upload as workflow artifacts on
a manual `workflow_dispatch` run, without publishing anything). Publishing
needs the `RELEASES_TOKEN` secret on this repo: a fine-grained PAT with
**Contents read/write on `audiopro-releases`** only.

## Settings

All settings persist across sessions via `electron-store`:

- **Delivery preset** (toolbar) — Platzi / YouTube / Podcast, see above.
- **Output** — format (WAV24/WAV16/FLAC), sample rate, custom output dir.
- **EQ** — HPF frequency, force de-esser on.
- **Dynamics & Body** — leveler (auto/off), local denoise (auto/off, Mode 1
  only), body amount (parallel compression blend), presence extra
  (`aexciter`, off by default), trim silence, normalize mode (both
  directions / raise only).
- **Adobe Enhance** — "Enhance with Adobe" toggle (embedded Enhance stage on
  Process All), "Clean voice mix" percentage (extra `Enhanced/Mix N/`
  deliverable; 100% = no extra file), and the Adobe account
  connect/sign-out. The session token is stored encrypted per machine, not
  in `electron-store`.
- **Fusion · Mode 2** — enable/disable, strategy (bands / bed / bands+bed),
  crossover frequency, original blend percentage.
- Manual EQ chain override (set from the EQ tab, not directly exposed as a
  toggle here).
- `showNotifications` (default on) — desktop notification when a batch
  finishes. Store-only for now; there's no toggle in the Settings panel yet.

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
  enhance/
    phonos.js                 Adobe Enhance Speech client (ported from adobe-podcast-batch)
    batch.js                  Embedded-enhance workers + shared credits gate; saves Enhanced/ + Mix N/
  adobe-auth.js               Adobe login window, token persistence (safeStorage), silent reauth
  metrics.js                  QC analysis pass (loudness, bands, rolloff, silences) → flags
  pairing.js                  Detects original ↔ Enhanced/ pairs (adobe-podcast-batch convention)
  fusion.js                   Mode 2 blend (bands / bed / bands+bed filter graphs)
  presets.js                  Delivery loudness/TP/LRA targets per platform
  ffmpeg-run.js               Shared ffmpeg/ffprobe spawn helper (timeout, progress, cancellation)
  bin-paths.js                Resolves paths to bundled binaries + RNNoise model (dev vs packaged)
  logger.js                   Structured logging (copyable from the app)
  spectrogram.js              showspectrumpic PNG render for the QC spectrogram modal
  qc-report.js                Markdown QC report builder for the batch export button
  updater.js                  Self-update helpers (git reset path for dev checkouts; packaged
                               installs use electron-updater against audiopro-releases, wired in main.js)
test/
  fixtures.js                 Synthetic WAV generator (ffmpeg lavfi) for the corpus below
  *.test.js                   node:test suite — metrics, pairing, fusion, presets, pipeline,
                               enhance (embedded), ffmpeg-run, spectrogram, qc-report, updater
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
- The embedded Enhance talks to Adobe's internal, unofficial endpoint (the
  same one `adobe-podcast-batch` uses) — it can change or break without
  notice, and it consumes your Adobe account's Enhance credits. Mode 2 with
  a manually produced `Enhanced/` folder and Mode 1 remain the fallbacks
  (`docs/PLAN.md` §3.1).
- Installs older than v0.6.0 carry the previous updater, which read this
  (private) repo's `main` anonymously and therefore could never see an
  update — they must be updated by installing a release DMG/installer
  manually once. From v0.6.0 on, updates come from the public
  `audiopro-releases` repo and need no token.
- `electron-updater` on unsigned macOS builds relies on the same ad-hoc
  arm64 signing the Sync app ships with; if a macOS update ever fails to
  apply, the fallback is simply installing the release DMG over the app.
