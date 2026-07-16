'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { runFfmpeg, runFfprobe } = require('./ffmpeg-run');
const binPaths = require('./bin-paths');
const metrics = require('./metrics');
const fusion = require('./fusion');
const { getPreset } = require('./presets');

// ── Base EQ (F6-style) ──
// Cuts happen before dynamics (they shape what the compressor reacts to);
// boosts happen after (so we're not boosting presence/air only to have
// the leveler immediately squash it back down). Manual overrides from the
// EQ editor replace both halves at once, applied at the cuts position —
// that mirrors what the editor's live preview plays back (source + one
// combined curve, no separate dynamics stage), so "Process All" matches
// what the user just auditioned.
const EQ_CUTS = [
  { f: 150, q: 2,   g: -3 },  // mud
  { f: 280, q: 2.5, g: -3 },  // box
  { f: 500, q: 2,   g: -4 },  // honk
];
const EQ_PRESENCE = { f: 3589, q: 1.0, g: 1 };
const EQ_AIR_SHELF = { f: 10000, g: 1.5 };
const DEFAULT_HPF_HZ = 80;

const DENOISE_WORKING_SR = 48000; // the bundled RNNoise model expects 48 kHz
const HUM_NOTCH_WIDTH_Q = 24;
const HUM_HARMONIC_MULT = 2;
const SILENCE_TRIM_PAD_SEC = 0.3;
const PAIR_DURATION_TOLERANCE_SEC = 0.5;

function hasFlag(qc, code) { return qc != null && qc.flags.some(f => f.code === code); }
function getFlag(qc, code) { return qc == null ? undefined : qc.flags.find(f => f.code === code); }

function buildEqCutsChain(settings) {
  const hpfF = settings.hpfFrequency ?? DEFAULT_HPF_HZ;
  const parts = [`highpass=f=${hpfF}:poles=2`];
  for (const b of EQ_CUTS) parts.push(`equalizer=f=${b.f}:width_type=q:width=${b.q}:g=${b.g}`);
  return parts.join(',');
}

function buildEqBoostsChain(qc, settings) {
  const parts = [`equalizer=f=${EQ_PRESENCE.f}:width_type=q:width=${EQ_PRESENCE.q}:g=${EQ_PRESENCE.g}`];
  if (!hasFlag(qc, 'NO_AIR')) parts.push(`highshelf=f=${EQ_AIR_SHELF.f}:g=${EQ_AIR_SHELF.g}`);
  return parts.join(',');
}

function buildToneChain(qc, settings) {
  if (settings.manualEqApply === true && typeof settings.manualEqChain === 'string' && settings.manualEqChain.trim()) {
    return { cuts: settings.manualEqChain.trim(), boosts: null };
  }
  return { cuts: buildEqCutsChain(settings), boosts: buildEqBoostsChain(qc, settings) };
}

// ── Conditional repair ──
// adeclick runs unconditionally (cheap, safe defaults, catches mouth
// clicks/plosive pops the analysis pass doesn't explicitly flag).
function buildRepairChain(qc, settings) {
  const parts = ['adeclick'];
  if (hasFlag(qc, 'CLIP')) parts.push('adeclip');
  for (const fl of (qc?.flags ?? [])) {
    if (fl.code === 'HUM') {
      parts.push(`bandreject=f=${fl.hz}:width_type=q:w=${HUM_NOTCH_WIDTH_Q}`);
      parts.push(`bandreject=f=${fl.hz * HUM_HARMONIC_MULT}:width_type=q:w=${HUM_NOTCH_WIDTH_Q}`);
    }
  }
  return parts.join(',');
}

function buildTrimSpec(qc, duration, settings) {
  if (settings.trimSilence === false || qc == null) return null;
  const head = getFlag(qc, 'SILENCE_HEAD');
  const tail = getFlag(qc, 'SILENCE_TAIL');
  if (!head && !tail) return null;
  const start = head ? Math.max(0, head.end - SILENCE_TRIM_PAD_SEC) : 0;
  const end = tail != null
    ? (duration != null ? Math.min(duration, tail.start + SILENCE_TRIM_PAD_SEC) : tail.start + SILENCE_TRIM_PAD_SEC)
    : null;
  if (start <= 0.001 && end == null) return null;
  const endArg = end != null ? `:end=${end.toFixed(3)}` : '';
  return `atrim=start=${start.toFixed(3)}${endArg},asetpts=PTS-STARTPTS`;
}

// Local conditional denoise (Mode 1 only — Mode 2 relies on Adobe's own
// enhancement for the noise floor). Returns null when there's nothing to
// do, or { filter, cwd } — cwd must be the model's own directory because
// embedding an absolute path with a drive-letter colon (Windows) or
// spaces directly in an FFmpeg filter option is unreliable across
// escaping layers; spawning with cwd + a bare filename sidesteps that
// entirely (see docs/PLAN.md §6 for the empirical trail).
function buildDenoiseSpec(qc, settings, mode) {
  if (mode !== 1 || settings.denoiseMode === 'off') return null;
  if (!hasFlag(qc, 'NOISY')) return null;
  const modelPath = binPaths.rnnoiseModel();
  if (!modelPath) return null;
  const mix = metrics.denoiseMixFor(qc.noiseFloor);
  if (mix <= 0) return null;
  return {
    filter: `arnndn=m=${path.basename(modelPath)}:mix=${mix.toFixed(2)}`,
    cwd: path.dirname(modelPath),
  };
}

function buildLevelerChain(qc, settings) {
  if (settings.compressionMode === 'off') return null;
  if (hasFlag(qc, 'FLAT_DYNAMICS')) return null;
  // Gentle, voice-appropriate leveling — not a limiter. Evens out
  // sentence-to-sentence loudness swings before the final loudnorm pass.
  return 'acompressor=threshold=-24dB:ratio=3:attack=15:release=250:makeup=3:knee=6';
}

function buildDeesserChain(qc, settings) {
  if (!settings.deEsserEnabled && !hasFlag(qc, 'SIBILANT')) return null;
  return 'adynamicequalizer=dfrequency=6500:dqfactor=1.5:tfrequency=6500:tqfactor=1.5:threshold=15:ratio=6:range=18:mode=0';
}

function buildExciterChain(settings) {
  if (!settings.airExtraEnabled) return null;
  return 'aexciter=amount=1.2:drive=6:blend=0.3:freq=7500:ceil=15000';
}

function buildOutputCodecArgs(settings) {
  const format = settings.outputFormat ?? 'wav24';
  const sr = String(settings.sampleRate ?? 48000);
  switch (format) {
    case 'wav16': return ['-acodec', 'pcm_s16le', '-ar', sr];
    case 'flac':  return ['-acodec', 'flac', '-ar', sr];
    default:      return ['-acodec', 'pcm_s24le', '-ar', sr];
  }
}

function resolveOutputPath(inputPath, settings) {
  const format = settings.outputFormat ?? 'wav24';
  const ext = format === 'flac' ? '.flac' : '.wav';
  const baseName = path.basename(inputPath, path.extname(inputPath)) + ext;
  const customDir = settings.customOutputDir;
  if (typeof customDir === 'string' && customDir) {
    fs.mkdirSync(customDir, { recursive: true });
    return path.join(customDir, baseName);
  }
  const inputDir = path.dirname(inputPath);
  const outputDir = path.join(path.dirname(inputDir), 'Audio_Pro');
  fs.mkdirSync(outputDir, { recursive: true });
  return path.join(outputDir, baseName);
}

function tempPathFor(inputPath, suffix) {
  const rand = crypto.randomBytes(4).toString('hex');
  return path.join(os.tmpdir(), `audiopro-${suffix}-${rand}-${path.basename(inputPath, path.extname(inputPath))}.wav`);
}

// ── ffprobe basic metadata ──
async function probeBasic(filePath) {
  const out = await runFfprobe(['-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath]);
  const probe = JSON.parse(out);
  const audio = probe.streams?.find(s => s.codec_type === 'audio');
  return {
    duration:   parseFloat(probe.format?.duration) || null,
    sampleRate: parseInt(audio?.sample_rate) || null,
    channels:   parseInt(audio?.channels) || 1,
  };
}

function buildPreEqChain(meta, targetSr) {
  const parts = ['aformat=channel_layouts=mono'];
  if (meta.sampleRate !== targetSr) parts.push(`aresample=${targetSr}:filter_size=64`);
  return parts.join(',');
}

// ── Assemble the render-time filter graph ──
// Plain comma chain when there's no parallel (body) branch — cheapest
// and matches what most files need. A body weight > 0 needs a real
// filter_complex graph: split the tone-shaped signal, compress one leg,
// mix it back under the dry signal (parallel/"New York" compression),
// then continue into the boosts + loudness stage.
function assembleGraph(prefixParts, bodyPct, suffixParts) {
  const prefix = prefixParts.filter(Boolean).join(',');
  const suffix = suffixParts.filter(Boolean).join(',');
  if (!bodyPct || bodyPct <= 0) {
    return { chain: [prefix, suffix].filter(Boolean).join(',') };
  }
  const weight = (bodyPct / 100).toFixed(3);
  const tail = suffix ? `[bodyd]${suffix}[out]` : '[bodyd]acopy[out]';
  const graph =
    `[0:a]${prefix}[dry];` +
    `[dry]asplit=2[dry1][dry2];` +
    `[dry2]acompressor=threshold=-28dB:ratio=6:attack=8:release=280:makeup=8[wet];` +
    `[dry1][wet]amix=inputs=2:weights=1 ${weight}:normalize=0[bodyd];` +
    tail;
  return { graph, mapOut: '[out]' };
}

function runGraph(inputPath, outputArgs, assembled, opts) {
  const args = ['-y', '-i', inputPath];
  if (assembled.graph) args.push('-filter_complex', assembled.graph, '-map', assembled.mapOut);
  else args.push('-af', assembled.chain);
  args.push(...outputArgs);
  return runFfmpeg(args, opts);
}

// ── Measure loudness after the full processing chain (minus loudnorm/limiter) ──
async function measureLoudness(inputPath, prefixParts, bodyPct, suffixParts, preset, duration, onProgress, setCurrent, cwd) {
  const measureSuffix = [...suffixParts, `loudnorm=I=${preset.i}:TP=${preset.tp}:LRA=${preset.lra}:print_format=json`];
  const assembled = assembleGraph(prefixParts, bodyPct, measureSuffix);
  const stderr = await runGraph(inputPath, ['-f', 'null', '-'], assembled, { duration, onProgress, setCurrent, cwd });
  const m = stderr.match(/\{[\s\S]*?"input_i"[\s\S]*?\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return {
      inputI:       parseFloat(j.input_i),
      inputLra:     parseFloat(j.input_lra),
      inputTp:      parseFloat(j.input_tp),
      inputThresh:  parseFloat(j.input_thresh),
      targetOffset: parseFloat(j.target_offset ?? '0'),
    };
  } catch {
    return null;
  }
}

// ── Render: full chain + (optional) loudnorm + safety limiter ──
async function renderFile(inputPath, outputPath, prefixParts, bodyPct, suffixParts, stats, applyLoudnorm, preset, settings, duration, onProgress, setCurrent, cwd) {
  const codecArgs = buildOutputCodecArgs(settings);
  const renderSuffix = [...suffixParts];
  if (applyLoudnorm && stats) {
    renderSuffix.push(
      `loudnorm=I=${preset.i}:TP=${preset.tp}:LRA=${preset.lra}:` +
      `measured_I=${stats.inputI}:measured_LRA=${stats.inputLra}:` +
      `measured_TP=${stats.inputTp}:measured_thresh=${stats.inputThresh}:` +
      `offset=${stats.targetOffset}`
    );
  }
  // Safety net regardless of loudnorm's own TP handling — loudnorm's
  // dynamic mode (used when linear gain would exceed the TP ceiling) can
  // still leave the odd transient a fraction over, and files that skip
  // loudnorm entirely (already at/above target) never got a TP check.
  renderSuffix.push(`alimiter=limit=${dbToLinear(preset.tp)}:attack=3:release=50:level=false`);
  const assembled = assembleGraph(prefixParts, bodyPct, renderSuffix);
  await runGraph(inputPath, [...codecArgs, outputPath], assembled, { duration, onProgress, setCurrent, cwd });
}

function dbToLinear(db) { return Math.min(1, Math.pow(10, db / 20)); }

// ── Quick post-render verification ──
async function verifyOutput(outputPath, preset) {
  try {
    const stderr = await runFfmpeg(['-i', outputPath, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'], { timeout: 2 * 60 * 1000 });
    const iMatch  = stderr.match(/I:\s+(-?[\d.]+) LUFS/);
    const tpMatch = stderr.match(/Peak:\s+(-?[\d.]+) dBFS/);
    const i  = iMatch ? parseFloat(iMatch[1]) : null;
    const tp = tpMatch ? parseFloat(tpMatch[1]) : null;
    const iOk  = i == null  || Math.abs(i - preset.i) <= 0.7;
    const tpOk = tp == null || tp <= preset.tp + 0.3;
    return { i, tp, badge: iOk && tpOk ? 'ok' : 'warn' };
  } catch {
    return { i: null, tp: null, badge: 'warn' };
  }
}

// ── ETA ──
function calcEta(startMs, done, total) {
  if (done === 0) return null;
  const elapsed = (Date.now() - startMs) / 1000;
  return Math.round(elapsed / done * (total - done));
}

// ── Per-file processing ──
async function processFile(file, settings, { emit, isCancelled, setCurrent, t0, done, total }) {
  const preset = getPreset(settings.platformPreset);
  const tempFiles = [];
  const cleanup = () => { for (const f of tempFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } } };

  try {
    let workingPath = file.path;
    let mode = 1;
    let stepTotal = 4;
    let stepIndex = 0;

    if (file.pairPath && settings.fusionEnabled !== false) {
      stepTotal = 5;
      stepIndex = 1;
      emit('progress', { file: file.path, step: 'Checking alignment', stepIndex, stepTotal, pct: 1, eta: calcEta(t0, done, total) });
      const [origMeta, enhMeta] = await Promise.all([probeBasic(file.path), probeBasic(file.pairPath)]);
      const durOk = origMeta.duration != null && enhMeta.duration != null &&
        Math.abs(origMeta.duration - enhMeta.duration) <= PAIR_DURATION_TOLERANCE_SEC;
      if (durOk) {
        mode = 2;
        emit('progress', { file: file.path, step: 'Fusing sources', stepIndex, stepTotal, pct: 4, eta: calcEta(t0, done, total) });
        const fusedPath = tempPathFor(file.path, 'fused');
        tempFiles.push(fusedPath);
        await fusion.runFusion(file.path, file.pairPath, fusedPath, settings, {
          duration: origMeta.duration, setCurrent,
          onProgress: frac => emit('progress', { file: file.path, step: 'Fusing sources', stepIndex, stepTotal, pct: Math.round(4 + frac * 8), eta: calcEta(t0, done, total) }),
        });
        workingPath = fusedPath;
      } else {
        emit('loudness', { file: file.path, message: `Pair duration mismatch (orig ${origMeta.duration?.toFixed(1)}s vs enhanced ${enhMeta.duration?.toFixed(1)}s) — processing original only` });
      }
    }

    stepIndex++;
    emit('progress', { file: file.path, step: 'Reading metadata', stepIndex, stepTotal, pct: mode === 2 ? 14 : 2, eta: calcEta(t0, done, total) });
    const meta = await probeBasic(workingPath);
    const duration = meta.duration ?? file.duration ?? null;
    if (isCancelled()) return;

    stepIndex++;
    emit('progress', { file: file.path, step: 'Analyzing audio', stepIndex, stepTotal, pct: mode === 2 ? 20 : 8, eta: calcEta(t0, done, total) });
    let qc = null;
    try {
      qc = await metrics.analyzeFile(workingPath);
    } catch (err) {
      emit('loudness', { file: file.path, message: `Analysis failed (${err.message}) — continuing with baseline processing` });
    }
    if (qc) {
      emit('qc', { file: file.path, mode, flags: qc.flags.map(f => ({ code: f.code, detail: f.detail })), loudnessIn: qc.loudness });
    }
    if (isCancelled()) return;

    const denoiseSpec = buildDenoiseSpec(qc, settings, mode);
    const targetSr = denoiseSpec ? DENOISE_WORKING_SR : parseInt(settings.sampleRate ?? 48000, 10);
    const preChain = buildPreEqChain(meta, targetSr);
    const trimChain = buildTrimSpec(qc, duration, settings);
    const repairChain = buildRepairChain(qc, settings);
    const tone = buildToneChain(qc, settings);
    const levelerChain = buildLevelerChain(qc, settings);
    const deesserChain = buildDeesserChain(qc, settings);
    const exciterChain = buildExciterChain(settings);
    const bodyPct = Math.max(0, Math.min(100, settings.bodyPct ?? 0));

    // tone.boosts is null only when a manual EQ override is active (it
    // already carries its own presence/air shaping) — exciter and the
    // dynamic de-esser are independent stages and still apply on top.
    const prefixParts = [preChain, trimChain, denoiseSpec?.filter, repairChain, tone.cuts, levelerChain];
    const suffixParts = [tone.boosts, exciterChain, deesserChain];
    const cwd = denoiseSpec?.cwd;

    stepIndex++;
    emit('progress', { file: file.path, step: 'Measuring loudness', stepIndex, stepTotal, pct: mode === 2 ? 26 : 14, eta: calcEta(t0, done, total) });
    const stats = await measureLoudness(workingPath, prefixParts, bodyPct, suffixParts, preset, duration,
      frac => { if (!isCancelled()) emit('progress', { file: file.path, step: 'Measuring loudness', stepIndex, stepTotal, pct: Math.round((mode === 2 ? 26 : 14) + frac * 30), eta: calcEta(t0, done + frac * 0.4, total) }); },
      setCurrent, cwd);
    if (isCancelled()) return;

    const raiseOnly = settings.normalizeMode === 'raiseOnly';
    const applyLoudnorm = stats !== null && (!raiseOnly || stats.inputI < preset.i);
    const verb = stats === null
      ? 'measure failed — render with EQ only'
      : applyLoudnorm
        ? `→ loudnorm to ${preset.i} LUFS, TP ≤ ${preset.tp} dBTP (${preset.label})`
        : `already at/above ${preset.i} LUFS — keep as-is`;
    const summary = stats === null
      ? 'loudness measure failed'
      : `I=${stats.inputI.toFixed(1)} LUFS, TP=${stats.inputTp.toFixed(1)} dBFS, LRA=${stats.inputLra.toFixed(1)} LU ${verb}`;
    console.log(`[AudioPro] ${path.basename(file.path)} [Mode ${mode}]: ${summary}`);
    emit('loudness', { file: file.path, message: summary });

    const outputPath = resolveOutputPath(file.path, settings);

    stepIndex++;
    emit('progress', { file: file.path, step: 'Rendering', stepIndex, stepTotal, pct: mode === 2 ? 58 : 46, eta: calcEta(t0, done + 0.5, total) });
    await renderFile(workingPath, outputPath, prefixParts, bodyPct, suffixParts, stats, applyLoudnorm, preset, settings, duration,
      frac => { if (!isCancelled()) emit('progress', { file: file.path, step: 'Rendering', stepIndex, stepTotal, pct: Math.round((mode === 2 ? 58 : 46) + frac * 44), eta: calcEta(t0, done + 0.5 + frac * 0.5, total) }); },
      setCurrent, cwd);

    const verify = await verifyOutput(outputPath, preset);
    emit('file:done', { file: file.path, outputPath, mode, verify });
  } finally {
    cleanup();
  }
}

// ── Queue runner ──
async function processQueue(files, { emit, isCancelled, setCurrent, settings = {} }) {
  const total = files.length;
  let done = 0;
  const t0 = Date.now();

  for (const file of files) {
    if (isCancelled()) break;

    try { fs.accessSync(file.path, fs.constants.R_OK); } catch {
      emit('file:error', { file: file.path, error: 'File not readable or not found' });
      done++;
      continue;
    }

    emit('file:start', { file: file.path, index: done, total });

    try {
      await processFile(file, settings, { emit, isCancelled, setCurrent, t0, done, total });
      done++;
    } catch (err) {
      done++;
      emit('file:error', { file: file.path, error: err.message });
    }
  }

  emit('batch:done', { total, done });
}

module.exports = { processQueue };
