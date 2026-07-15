# AudioPro — Design

## Vision

Finishing tool for course voice recordings. The voice is cleaned upstream by
**Adobe Podcast**; AudioPro takes that clean WAV and delivers the final,
consistent master for courses: fixed voice EQ with good presence + loudness
normalization to −16 LUFS. Zero configuration required, advanced EQ control
available when needed.

**Principle:** "Drop files, get course-ready audio." The app must never make
clean source material worse — which is why there is no ML denoise/enhancement
stage (DeepFilterNet and Resemble Enhance were evaluated and removed: they
degraded already-clean Adobe Podcast material).

## Technical stack

- **UI:** Electron (vanilla HTML/CSS/JS) — dark theme, Processing / EQ / About tabs
- **Backend:** Node.js main process, IPC via contextBridge
- **Audio processing:** bundled static FFmpeg / FFprobe (no other runtime deps)
- **Distribution:** unsigned DMG (macOS arm64) and NSIS installer (Windows x64)

## User flow

1. Export clean voice WAVs from Adobe Podcast.
2. Drop folders or files into AudioPro (or pick via dialog).
3. Optionally open the EQ tab: the three cut bands auto-fit to the file's
   spectrum; drag bands with real-time preview if the voice needs tweaks.
4. Click **Process All**.
5. Output appears in `Audio_Pro/` next to each source folder (or a custom dir).

## Processing pipeline (per file)

1. **Probe** — FFprobe metadata: duration, sample rate, channels.
2. **Measure** — mono mixdown + EQ + `loudnorm` in measurement mode; parses
   integrated LUFS, true peak, LRA, threshold from the JSON summary.
3. **Render** — mono mixdown → resample to target rate if needed → EQ chain →
   `loudnorm` linear mode with measured stats, targeting **−16 LUFS,
   TP ≤ −2 dBTP**. Files already at/above −16 LUFS render with EQ only
   ("only raise, never attenuate").

### Base EQ (Waves F6 voice reference)

| Band | Freq | Q | Gain |
|------|------|---|------|
| HPF | 80 Hz | — | 12 dB/oct |
| Mud cut | 150 Hz | 2.0 | −3 dB |
| Box cut | 280 Hz | 2.5 | −3 dB |
| Honk cut | 500 Hz | 2.0 | −4 dB |
| Presence | 3.6 kHz | 1.0 | +1 dB |
| Air shelf | 10 kHz | shelf | +1.5 dB |
| De-esser (opt-in) | 6.5 kHz | 3.25 | −2 dB |

The EQ editor auto-fits the three cut bands to the local spectral peak of the
selected file (16384-point Hann FFT, ±1/3 octave search) so cuts land on each
voice's actual resonances. Manual edits auto-save and override the base curve
wholesale.

## Settings (electron-store)

- `hpfFrequency` (default 80)
- `deEsserEnabled` (default false)
- `outputFormat`: wav24 (default) | wav16 | flac
- `sampleRate`: 48000 (default) | 44100
- `manualEqChain` / `manualEqApply` (managed by the EQ editor)
- `customOutputDir` ('' = sibling `Audio_Pro/`)
- `showNotifications` (default true)

## Non-goals

- ML denoise / speech regeneration — handled upstream by Adobe Podcast.
- Python runtime — removed with the ML stages; FFmpeg covers everything.
- Per-file "smart" auto-adaptation beyond the EQ spectrum auto-fit — a fixed,
  predictable chain is preferred so all classes in a course sound identical.
