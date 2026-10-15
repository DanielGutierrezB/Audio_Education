# AudioPro — how it works, and how to drive it from Premiere

Two documents in one, because the second needs the first:

1. **§1–§8 — the processing model in full.** Every stage, every threshold,
   every condition, with the measurements behind them. This is the reference
   for anyone changing the audio or reimplementing it elsewhere.
2. **§9–§14 — the Premiere integration.** How the existing CEP panel
   (`com.danielgutierrez.adobepodcastpremiere`) goes from "Adobe Podcast and
   drop it on the timeline" to running this whole chain, without a second
   copy of the pipeline that drifts from this one.

Line references are to this repo at v0.8.0. When the code and this document
disagree, the code is right and this document is a bug.

---

## 1. What the tool is for

Course voice recordings arrive inconsistent: different rooms, different mics,
different teachers, and — once Adobe Podcast has been through them — different
amounts of low end added on top. AudioPro turns a folder of those into masters
that sound like the same course: one tonal balance, one loudness, with the
per-file damage (hum, clipping, noise, sibilance) repaired only where it
actually exists.

The operating principle is that **the amount of correction is measured, not
assumed**. A fixed curve applied to everything is what produced the "Adobe
gives too much bass, the voice lacks clarity" complaint in the first place: a
dark source came out exactly as dark, because nothing in the chain was looking
at the source.

## 2. The two entry modes

| | Input | What it assumes |
|---|---|---|
| **Mode 1** | one recording | Nothing has cleaned it yet. Conditional RNNoise denoise is available. |
| **Mode 2** | original **+** its Adobe Podcast Enhance pass at 100% | Adobe already handled noise and reverb. Local denoise is skipped entirely (`src/pipeline.js` `buildDenoiseSpec` returns `null` unless `mode === 1`). |

Mode 2 is detected by `src/pairing.js` `findPairs`: audio files in the selected
folder, matched by basename against an `Enhanced/` subfolder beside them
(optionally one level deeper under `Clean voice/`). Extension-insensitive, so
`clase-01.wav` pairs with `Enhanced/clase-01.mp3`.

Files with no counterpart come back as `singles` and run Mode 1. **For the
Premiere integration this pairing step is irrelevant** — the panel already
knows which two files it has, and passes the pair explicitly (§11).

AppleDouble sidecars (`._name.wav`, which macOS writes on exFAT drives — the
filesystem course audio travels on) are filtered out. They carry a real audio
name but a few KB of metadata, so without that filter they queue up and fail at
the first ffmpeg pass.

## 3. The render is two passes over one chain

This is the part that surprises people reading the code, so it comes first.

`loudnorm` needs to know the integrated loudness of the signal it is
normalizing. The signal it normalizes is not the source — it is the source
*after* high-pass, EQ cuts, repair, denoise, leveling, presence, air, exciter
and de-essing. Measuring the source would produce a number that no longer
describes anything by the time the chain is done with it.

So:

- **Pass 1 (`measureLoudness`)** — the full chain runs with
  `loudnorm=...:print_format=json` appended, output to `-f null -`. Nothing is
  written. The JSON gives `input_i`, `input_lra`, `input_tp`, `input_thresh`,
  `target_offset`.
- **Pass 2 (`renderFile`)** — the identical chain, with `loudnorm` now fed
  `measured_I/LRA/TP/thresh/offset` from pass 1, plus a safety `alimiter`.
  This one writes the file.

Everything before `loudnorm` is bit-identical between the passes; the only
difference is how `loudnorm` is configured and where the output goes. Budget
roughly 2× the decode cost of one pass per file.

`normalizeMode: 'raiseOnly'` skips `loudnorm` on files already at or above the
target (`applyLoudnorm` in `processFile`); `'both'`, the default, always
applies it.

## 4. The analysis pass, and what each flag switches on

`src/metrics.js` `analyzeFile` runs `astats` + `ebur128` + per-band RMS
(`BAND_DEFS`, each band a bandpass pair) over the working file, and returns
loudness, band energies, a flag list and the tilt.

**Bands** (`src/metrics.js`):

| Key | Range |
|---|---|
| `body` | 100–300 Hz |
| `mud` | 300–600 Hz |
| `presence` | 2–5 kHz |
| `sibilance` | 5–9 kHz |
| `air` | 10–16 kHz |
| `hum50` / `hum60` | bandpass at 50 / 60 Hz, Q 10 |

**Flags and their consequences** — this table is the whole adaptive behaviour:

| Flag | Fires when | What it changes |
|---|---|---|
| `CLIP` | `astats` Flat_factor > 1 **and** peak > −1 dBFS | adds `adeclip` |
| `HUM` | 50 or 60 Hz band RMS − full RMS > −12 dB | adds `bandreject` at that frequency **and its 2nd harmonic**, Q 24 |
| `NOISY` | noise floor > −50 dBFS | adds RNNoise (`arnndn`) — **Mode 1 only** |
| `SIBILANT` | sibilance − presence > **+1 dB** | turns the de-esser on at 50% if the user left it at 0 |
| `NO_AIR` | air − presence < **−11 dB** | **removes** the 10 kHz air shelf |
| `FLAT_DYNAMICS` | LRA < 3 LU | removes the leveler |
| `DC_OFFSET` | abs(DC) > 0.003 | reported only; the high-pass already removes it |
| `SILENCE_HEAD` / `SILENCE_TAIL` | > 1.0 s at either end | adds `atrim` with 0.3 s of pad — **see §13, this one desyncs Premiere** |
| `PAIR_REALIGNED` / `PAIR_MISMATCH` | Mode 2 alignment (§6) | reporting only |

Two of these thresholds were wrong until v0.7.0 and are worth knowing about,
because they are the kind of thing that looks arbitrary in a diff:

- `sibilanceRatioDb` was **−2**, which fired on **22 of 28** real course files.
  It was reading normal speech as harsh esses. Real files span −4.1…+0.4 dB, so
  **+1** clears the loudest real one by 0.6 dB and still catches the synthetic
  fixture at +2.3 dB.
- `NO_AIR` used to be an absolute spectral-rolloff test at 7000 Hz, which fired
  on **28 of 28** real files — meaning no real voice ever received the air
  shelf. Rolloff tracks content more than bandwidth: normal voice measured
  4.8 kHz, a deliberately lowpassed copy of that *same* voice 3.1 kHz, and the
  broadband synthetic fixtures 17 kHz. The relative air−presence measure
  separates cleanly: normal −3.1…−9.1 dB, genuinely band-limited −12.3…−21.1 dB.

If analysis fails, `qc` stays `null` and the file still renders with the
baseline chain. Every `hasFlag` check treats null as "flag absent".

## 5. The filter chain, in order

One ffmpeg graph. `prefixParts` and `suffixParts` in `processFile`, joined by
commas, or promoted to a real `filter_complex` when the parallel body branch is
active (`assembleGraph`).

| # | Stage | Filter | When |
|---|---|---|---|
| 1 | Mono fold | `aformat=channel_layouts=mono` | always |
| 2 | Resample | `aresample=<sr>:filter_size=64` | sample rate ≠ target |
| 3 | Edge trim | `atrim=start=…:end=…,asetpts=PTS-STARTPTS` | `SILENCE_HEAD`/`TAIL` and `trimSilence` |
| 4 | Denoise | `arnndn=m=rnnoise-model.rnnn` | `NOISY`, Mode 1, `denoiseMode ≠ off` |
| 5 | Declick | `adeclick` | always |
| 6 | Declip | `adeclip` | `CLIP` |
| 7 | Hum notch | `bandreject=f=<50\|60>:width_type=q:w=24` ×2 | `HUM` |
| 8 | High-pass | `highpass=f=80:poles=2` | always (`hpfFrequency`) |
| 9 | Mud / box / honk | `equalizer` at 150 Hz Q2 −3 dB, 280 Hz Q2.5 −3 dB, 500 Hz Q2 −4 dB | always |
| 10 | **Tilt shelf** | `lowshelf=f=300:g=<measured>` | adaptive, §7 |
| 11 | Leveler | `acompressor=threshold=-24dB:ratio=2:attack=15:release=250:makeup=2:knee=6` | unless `FLAT_DYNAMICS` or LRA < 4 |
| 12 | Body (parallel) | `asplit` → `acompressor=threshold=-28dB:ratio=6:…:makeup=8` → `amix=weights=1 <bodyPct>` | `bodyPct > 0` |
| 13 | Presence | `equalizer=f=3589:width_type=q:width=1:g=1` | always |
| 14 | Air | `highshelf=f=10000:g=1.5` | unless `NO_AIR` |
| 15 | Exciter | `aexciter=amount=…:drive=6:blend=…:freq=7500:ceil=15000` | `airExtraAmount > 0` (legacy `airExtraEnabled` ⇒ 60%) |
| 16 | **De-esser** | `adynamicequalizer` at 7.5 kHz, §8 | `SIBILANT` or set manually |
| 17 | Loudness | `loudnorm=I=<preset>:TP=<preset>:LRA=8` | per §3 |
| 18 | Limiter | `alimiter=limit=<preset TP>:attack=3:release=50:level=false` | always |

Stage 18 is unconditional on purpose. `loudnorm`'s dynamic mode (used when
linear gain would breach the true-peak ceiling) can still let the odd transient
through, and files that skip `loudnorm` entirely never got a true-peak check at
all.

Setting `manualEqApply: true` replaces stages 8–10 with `manualEqChain` and
**drops 13–14 entirely** (`buildToneChain` returns `boosts: null`, on the
grounds that a manual curve carries its own presence and air shaping). The
exciter and de-esser still apply on top — they are independent stages, not part
of the EQ curve.

## 6. Mode 2: alignment, then fusion

**Alignment** (`src/align.js`, new in v0.8.0). Durations are compared with a
0.5 s tolerance. A mismatch used to drop silently to Mode 1, throwing away the
Adobe pass the user spent credits on. Now:

1. Both files are decoded to an 8 kHz mono envelope at 100 Hz.
2. Cross-correlation over ±15 s finds the best lag, over the first 180 s.
3. Accepted when correlation ≥ 0.6 **and** envelope contrast ≥ 0.25. The
   contrast guard exists because two constant tones correlate perfectly at
   every lag and would otherwise report a confident alignment.
4. Accepted → the extra head is trimmed off whichever file starts later, flag
   `PAIR_REALIGNED`. Rejected → `PAIR_MISMATCH` and Mode 1, but now it says so
   on the file row and in the report.

Recovers an injected 3.5 s offset exactly, at 0.96–0.98 correlation.

**Fusion** (`src/fusion.js`). Three strategies, `bands` by default:

- **`bands`** — `acrossover=split=200:order=4th` on both inputs; keeps the
  **low band of the original** and the **high band of the enhanced**. Adobe
  cleans the top end well but thins out body and room tone, so the bottom comes
  from the untouched original.
- **`bed`** — enhanced at full strength with the original mixed underneath at
  `fusionOriginalPct` (capped at 40%).
- **`bands_bed`** — bands, then a light original bed on top.

Output is an intermediate `pcm_s24le` 48 kHz mono file, which then runs the
identical Mode 1 path. Keeping the two-input step in its own render is what
lets the rest of the pipeline assume a single input.

## 7. Adaptive tilt — the headline of v0.8.0

**Tilt** is `body − presence` (100–300 Hz minus 2–5 kHz) in dB. Higher is
darker. `src/metrics.js` `tiltOf`.

```
excess  = tilt − toneTiltTarget          // target default 14 dB
gain    = clamp(−excess / 0.65, ±6 dB)   // 0.65 dB of tilt per dB of shelf
                                         // null when |gain| < 0.2
```

applied as `lowshelf=f=300:g=<gain>` at stage 10.

Both constants are measured, not chosen. The 300 Hz shelf moves tilt by
0.65 dB per dB of gain, linearly and consistently across the three classes
tested (15.1 → 11.2 dB over a 6 dB shelf). The 14 dB reference is where the
fixed curve was implicitly calibrated: the four real classes measure
12.9–14.7 dB at that point, so a file arriving at the reference gets no shelf
and renders exactly as the previously validated chain did. Everything else is
pulled toward it.

The ±6 dB cap is deliberate. Past roughly 4 dB of tilt correction the source
is not "a bit dark" — it is a different problem (wrong mic, proximity effect, a
lowpassed take) that a shelf should not paper over.

Measured over 4 real classes with their originals and Adobe passes:

| | tilt (body − presence) | spread across classes |
|---|---|---|
| original | 14.4 … 15.9 | 1.5 dB |
| Adobe Podcast 100% | 16.5 … 18.1 | 1.6 dB |
| AudioPro ≤ v0.6.x | 17.5 … 20.5 | **3.0 dB** |
| AudioPro v0.8.0 | **10.9 … 11.4** | **0.5 dB** |

The master goes from *darker* than the source it started from to brighter, and
the spread across a course collapses — which is the part that matters for a
course, since it means classes stop inheriting whatever Adobe did to each take.

## 8. The de-esser

Worth its own section because every version up to v0.7.0 shipped it inverted,
and the failure mode is instructive.

```
adynamicequalizer=dfrequency=7500:dqfactor=2:
                  tfrequency=7500:tqfactor=3.5:
                  ratio=6:range=<2 + amount/100 × 10>:mode=1:auto=4
```

Three things:

- **`mode=1` (cutabove), not `0`.** Mode 0 is `cutbelow`, which attenuates
  while the detection band is *below* threshold — the inverse of a de-esser.
- **`threshold` is linear amplitude, not dB.** The old `threshold=15` sat above
  full scale, so the stage attenuated every sample. Measured on a real class:
  a near-constant **−17.5 dB out of 5–9 kHz** plus −6 dB of collateral presence
  loss. The "muddy, no clarity" complaint was substantially this stage.
- **`auto=4` (adaptive), not a fixed threshold.** This stage runs *before*
  `loudnorm`, so it sees raw source level. Same class at −12 / 0 / +12 dB input
  gain: a fixed threshold reduced sibilance by −0.3 / −2.6 / −4.2 dB; adaptive
  held −5.5 dB throughout.

`mode` and `auto` are written numerically because the named spellings
(`cutabove`, `adaptive`) are rejected by ffmpeg 6.1. See §12 — this is a real
constraint for the panel's own ffmpeg.

7.5 kHz with `tqfactor=3.5` was chosen by measurement: at 6.5 kHz / `tqfactor=1.5`
the bell's skirt reached into the presence band and cost 2.6 dB there to get
9.4 dB of sibilance reduction; 7.5 kHz gets 5.7 dB for 1.2 dB of presence.

ffmpeg's dedicated `deesser` filter was measured and rejected: at +12 dB input
on real audio it *added* 30–47 dB.

## 9. Where the Premiere panel stands today

`~/Library/Application Support/Adobe/CEP/extensions/com.danielgutierrez.adobepodcastpremiere`

Its loop (`js/main.js` `processItems`) is already the right shape:

1. `ppExportAudio(seqId, tmpExport, presetPath, workArea)` — renders the
   sequence (or the In→Out region) to a WAV via a Premiere export preset, and
   returns `{ ok, outPath, inPoint }`.
2. `enhanceToFile(tmpExport, finalOut, { token, cleanVoice, ffmpeg })` —
   uploads to Adobe Podcast, polls, downloads. At `cleanVoice < 100` it blends
   dry/wet locally with a flat `amix`.
3. `ppPlaceEnhanced(seqId, finalOut, muteOthers, startSeconds)` — drops the
   result on a new track at `inPoint`, optionally muting the others.

It already has what the integration needs: **Node is enabled**
(`--enable-nodejs --mixed-context` in `CSXS/manifest.xml`) and it already
ships and shells out to **ffmpeg**.

What it does *not* have is everything in §4–§8: no analysis, no conditional
repair, no tilt correction, no de-esser, no loudness normalization, no
verification. Its `cleanVoice` blend is a flat `amix` of the two full-range
signals — **not** AudioPro's band-split fusion, which is a different and
better-reasoned operation (§6).

## 10. How to wire it: pick one, and don't copy the pipeline

Three options. The thing to avoid is a second copy of `src/` inside the panel:
a broken de-esser already survived months in this repo *with* tests, and two
diverging copies is how that becomes permanent.

| | Approach | Verdict |
|---|---|---|
| **A** | Vendor `src/` into the panel | **No.** Two copies that drift. This is the failure mode to design against. |
| **B** | Extract `src/` into a shared npm package used by both | Right long-term shape, but it needs a package, a version policy and a release process before anything ships. |
| **C** | **Panel spawns a headless CLI that ships inside AudioPro** | **Start here.** One implementation, one ffmpeg, and the app's existing auto-updater distributes pipeline fixes to the panel for free. |

C also fixes something the panel can't fix on its own: **the chain requires a
specific ffmpeg**, and the panel currently downloads its own (`ensureFfmpeg`).
See §12.

The CLI does not exist yet. It is the first task, and it is small — the
pipeline already runs headless. Verified on this repo at v0.8.0, from plain
Node with no Electron:

```
eventos: file:start → progress → qc → progress → loudness → progress → file:done → batch:done
flags de QC: NOISY | tilt: 5.2
verificación: {"i":-16.1,"tp":-2.9,"badge":"ok"}
```

`src/bin-paths.js` already degrades gracefully outside Electron (it try/catches
the `electron` require and falls back to the project `bin/`), which is why this
works at all.

## 11. The CLI contract to build

Add it as **`src/cli.js`**, not `bin/audiopro-cli.js`. Two reasons, both from
`package.json` → `build`: the repo's `bin/` is `extraResources` and lands in
`Resources/bin` alongside the ffmpeg binaries, and `files` already includes
`src/**/*`. So `src/cli.js` ships at

```
AudioPro.app/Contents/Resources/app/src/cli.js        # macOS
resources\app\src\cli.js                              # Windows
```

with **no build configuration change at all**. `asar` is off, so the file is
there on disk, readable and runnable as-is.

Run it with the panel's own Node — the pipeline has no native dependencies, so
there is nothing to rebuild per-Electron-version.

**Invocation**

```bash
node "/Applications/AudioPro.app/Contents/Resources/app/src/cli.js" render \
  --input   /tmp/ppx_seq12_1760000000.wav \
  --pair    /tmp/ppx_seq12_adobe.wav      \  # omit for Mode 1
  --out-dir "/Users/dg/Project/Audio_Process" \
  --settings '{"trimSilence":false,"platformPreset":"platzi"}' \
  --json
```

**stdout: one JSON object per line**, so the panel can stream progress without
a parser. These map 1:1 onto `processQueue`'s existing `emit` calls, so the CLI
is mostly a translation layer:

| Event | Payload | Panel uses it for |
|---|---|---|
| `file:start` | `file`, `index`, `total` | row goes to "processing" |
| `progress` | `step`, `stepIndex`, `stepTotal`, `pct`, `eta` | the progress label and bar |
| `qc` | `flags[]`, `loudnessIn`, `tilt`, `mode` | show what was detected and repaired |
| `loudness` | `message` | the one-line "I=… TP=… LRA=… → loudnorm to −16" log |
| `file:done` | `outputPath`, `mode`, `verify: {i, tp, badge}` | **the path to place, and the badge to show** |
| `file:skipped` | `outputPath`, `reason` | already rendered (§13) |
| `file:error` | `error` | row goes to error |
| `batch:done` | `total`, `done` | re-enable the buttons |

Exit non-zero only on a failure to start. Per-file failures are `file:error`
events, because a batch of sequences should not die on one bad file.

**Where to splice it in `processItems`** — between the Adobe return and the
placement, replacing nothing:

```js
// 2. Adobe Podcast — unchanged, but ALWAYS at 100% now.
//    The dry/wet blend moves to AudioPro, which does it as a 200 Hz band
//    split rather than a flat amix (docs/PREMIERE-INTEGRATION.md §6).
const adobeOut = path.join(os.tmpdir(), 'ppx_' + id + '_adobe.wav');
await enhanceToFile(tmpExport, adobeOut, { token, cleanVoice: 100, ffmpeg: null, onStatus });

// 2b. NEW — the AudioPro chain. The sequence export is the original, the
//     Adobe return is the pair: that is exactly Mode 2.
setSt(id, 'masterizando…', 'work');
const master = await runAudioPro({
  input: tmpExport,
  pair:  adobeOut,
  outDir,
  settings: { trimSilence: false, skipUnchanged: false, platformPreset: 'platzi' },
  onEvent: ev => {
    if (ev.type === 'progress') setSt(id, ev.step + ' ' + ev.pct + '%', 'work');
    if (ev.type === 'qc')       log('  · QC: ' + ev.flags.map(f => f.code).join(', '));
    if (ev.type === 'loudness') log('  · ' + ev.message);
  },
});
log('  · master: ' + master.verify.i + ' LUFS / ' + master.verify.tp + ' dBTP [' + master.verify.badge + ']');

// 3. Placement — unchanged except for the path.
const pl = JSON.parse(await evalES('ppPlaceEnhanced(' + esStr(id) + ', ' + esStr(master.outputPath) + ', ' + effMute + ', ' + esStr(String(startAt)) + ')'));
```

Note what happens to `cleanVoice`. Today it is the panel's dry/wet slider. In
the new flow Adobe should always be called at **100%** and the blend becomes
AudioPro's `fusionMode` / `fusionCrossoverHz` / `fusionOriginalPct`. Keeping
both blends would mean mixing the same two signals twice, in two different ways.
Either relabel the slider to drive `fusionOriginalPct` (0–40%) or drop it; it
should not keep feeding `enhanceToFile`.

## 12. The ffmpeg the panel downloads is not good enough

The panel's `ensureFfmpeg` fetches a build on demand. That is fine for a flat
`amix`. It is **not** fine for this chain, and the repo has already been bitten
by exactly this:

CI used to install ffmpeg from apt (6.1) while the app shipped a newer build.
The de-esser's `mode=cutabove` and `auto=adaptive` are rejected by 6.1, and
`auto=4` returned "Numerical result out of range" — so the test suite was
green against an ffmpeg that *was not the one that shipped*. The fix was to
move CI to `macos-15` + `npm run setup:bin` so it tests the same binary. A
panel that downloads its own ffmpeg reintroduces that exact gap.

Filters the chain requires: `adynamicequalizer` (with working `mode`/`auto`),
`arnndn`, `acrossover`, `aexciter`, `adeclick`, `adeclip`, `loudnorm`,
`alimiter`, `acompressor`, `astats`, `ebur128`, `axcorrelate`.

**So: option C in §10, and the CLI uses AudioPro's bundled ffmpeg via
`src/bin-paths.js`.** Do not pass the panel's ffmpeg path in. If the panel must
keep its own binary for its other features, that is fine — just not for this.

`arnndn` additionally needs `bin/rnnoise-model.rnnn` beside the binary. It is
only reachable in Mode 1, so a Premiere flow that always pairs with Adobe never
touches it, but the CLI should not silently lose it either.

## 13. What will bite you, in order of likelihood

**1. Silence trimming desyncs the timeline.** `atrim` + `asetpts=PTS-STARTPTS`
shifts the audio earlier. The panel places the clip at a known `startSeconds`
from `ex.inPoint`, so any trimmed head silence puts the whole master out of
sync by that much. **`trimSilence: false` is mandatory for this path.** It is
the single most important line in the settings object.

**2. Mono.** Stage 1 folds to mono unconditionally, and the output is a mono
48 kHz file. The panel already exports and places mono, so this matches — but
anyone expecting a stereo return will not get one.

**3. Skip-unchanged will "do nothing".** `skipUnchanged` fingerprints the
source's mtime and size plus the settings. Re-exporting the same sequence to
the same path can look unchanged and return `file:skipped` with no new render.
Pass `skipUnchanged: false` from the panel — it exports to a fresh temp path
each run, so the manifest is pointless there anyway.

**4. Two passes, so expect roughly double the ffmpeg time** versus the current
flat blend, plus the analysis pass. On a long sequence this is minutes, not
seconds. The `progress` events exist precisely so the panel can show it.

**5. `file:done` is not the end of the story.** `verify` re-measures the output
and returns a `badge`. A master that comes back outside the preset's tolerance
should surface in the panel rather than being placed silently.

**6. In→Out regions.** The panel already handles the subtlety that muting other
tracks would silence the whole timeline outside the region. Nothing in AudioPro
changes that, but note that AudioPro measures loudness over whatever it is
given — normalizing a 20-second In→Out region to −16 LUFS normalizes *that
region*, which may not match the rest of the sequence. For partial regions,
consider `normalizeMode: 'raiseOnly'` or skipping `loudnorm` entirely.

## 14. Settings the panel should send

Full list and defaults in `src/settings.js`. `validate(key, value)` is the
trust boundary — `manualEqChain` goes into a filter graph and `customOutputDir`
becomes a write target, so anything arriving from outside goes through it.

Mandatory for Premiere:

```json
{
  "trimSilence": false,
  "skipUnchanged": false,
  "platformPreset": "platzi"
}
```

Worth exposing in the panel UI:

| Key | Default | Why an editor would touch it |
|---|---|---|
| `platformPreset` | `platzi` | −16 LUFS / −2 dBTP. `youtube` is −14/−1.5, `podcast` −16/−1.0 |
| `fusionMode` | `bands` | `bands` / `bed` / `bands_bed` (§6) |
| `fusionOriginalPct` | `20` | how much original sits under the enhanced track (cap 40) |
| `toneTiltTarget` | `14` | raise for a teacher who should sound warmer, lower for brighter |
| `deEsserAmount` | `0` | 0 = automatic from `SIBILANT`; 1–100 forces it |
| `airExtraAmount` | `0` | exciter intensity |
| `bodyPct` | `0` | parallel compression weight |
| `normalizeMode` | `both` | `raiseOnly` for partial regions (§13.6) |

Leave alone unless there is a reason: `hpfFrequency`, `manualEqChain` /
`manualEqApply`, `adaptiveToneEnabled`, `denoiseMode`, `compressionMode`,
`concurrency` (the panel processes one sequence at a time; the pool is for
folder batches).

## 15. How to know it works

The pipeline's own suite is 146 tests (`npm test`) and does not cover any of
this, so the integration needs its own evidence. In rough order of value:

1. **Sync.** Export a sequence that starts with 3 s of silence, run it through,
   place it, and confirm the waveform still lines up with the original clip.
   This is check number one because §13.1 is the easiest mistake to make and
   the hardest to notice in a quick listen.
2. **Loudness.** `ffmpeg -i master.wav -af ebur128 -f null -` on the placed
   file should read within a few tenths of the preset. The CLI already reports
   this in `verify`; confirm the panel is not placing something it flagged.
3. **Tilt.** Run `scripts/calibrate.js` over a few finished classes and check
   the body−presence spread across a course is under ~1 dB (§7). This is the
   actual deliverable: classes that sound like each other.
4. **Mode 2 really engaged.** `file:done` should report `mode: 2`. If it says
   `mode: 1`, the pair was rejected — look for `PAIR_MISMATCH` in the `qc`
   event, which now explains why instead of failing silently.
5. **The ffmpeg actually used.** Log which binary the CLI resolved. If it is
   the panel's download rather than AudioPro's bundle, §12 applies and the
   de-esser is probably a no-op or an error.
