'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const binPaths = require('./bin-paths');

// ── Base EQ ──
// Single fixed curve for voice — replica of the Waves F6 reference:
//   HPF + three surgical low-mid cuts (mud/box/honk) + gentle presence
//   peak + air highshelf. User overrides via the EQ editor →
//   manualEqChain + manualEqApply.
const BASE_EQ_BANDS = [
  // freq, Q, gain (dB) — peaking unless noted
  { f: 150,   q: 2,    g: -3   },  // mud cut
  { f: 280,   q: 2.5,  g: -3   },  // box cut
  { f: 500,   q: 2,    g: -4   },  // honk cut
  { f: 3589,  q: 1.0,  g: 1    },  // presence
];
const AIR_SHELF = { f: 10000, g: 1.5 };  // highshelf
const DEFAULT_HPF_HZ = 80;

// Loudness targets. Files quieter than TARGET_LUFS get normalized via
// FFmpeg's two-pass loudnorm; files already at or above the target are
// passed through untouched (preserves the "only raise, never attenuate"
// contract).
const TARGET_LUFS = -16;
const TARGET_TP_DB = -2;
const TARGET_LRA = 11;

function buildBaseEqChain(settings) {
  const hpfF = settings.hpfFrequency ?? DEFAULT_HPF_HZ;
  const filters = [`highpass=f=${hpfF}:poles=2`];
  for (const b of BASE_EQ_BANDS) {
    filters.push(`equalizer=f=${b.f}:width_type=q:width=${b.q}:g=${b.g}`);
  }
  filters.push(`highshelf=f=${AIR_SHELF.f}:g=${AIR_SHELF.g}`);
  if (settings.deEsserEnabled === true) {
    filters.push('equalizer=f=6500:width_type=q:width=3.25:g=-2');
  }
  return filters.join(',');
}

function buildEqChain(settings) {
  if (settings.manualEqApply === true && typeof settings.manualEqChain === 'string'
      && settings.manualEqChain.trim()) {
    return settings.manualEqChain.trim();
  }
  return buildBaseEqChain(settings);
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

// ── Spawn helper ──
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

function run(cmd, args, opts = {}) {
  if (cmd === 'ffmpeg')  cmd = binPaths.ffmpeg();
  if (cmd === 'ffprobe') cmd = binPaths.ffprobe();
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    if (opts.setCurrent) opts.setCurrent(proc);
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      if (opts.setCurrent) opts.setCurrent(null);
      reject(new Error(`${path.basename(cmd)} timed out after ${RUN_TIMEOUT_MS / 1000}s`));
    }, opts.timeout ?? RUN_TIMEOUT_MS);
    let stderr = '';
    proc.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      if (opts.onProgress && opts.duration) {
        const m = text.match(/time=(\d{2}):(\d{2}):(\d{2})\.(\d+)/);
        if (m) {
          const secs = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / Math.pow(10, m[4].length);
          opts.onProgress(Math.min(secs / opts.duration, 0.99));
        }
      }
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (opts.setCurrent) opts.setCurrent(null);
      if (code === 0 || code === null) resolve(stderr);
      else {
        const tail = stderr.slice(-300).trim();
        reject(new Error(`${path.basename(cmd)} exited ${code}${tail ? ': ' + tail : ''}`));
      }
    });
    proc.on('error', err => {
      clearTimeout(timer);
      if (opts.setCurrent) opts.setCurrent(null);
      reject(err);
    });
  });
}

// ── ffprobe basic metadata ──
async function probeBasic(filePath) {
  const out = await new Promise((resolve, reject) => {
    const proc = spawn(binPaths.ffprobe(), [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath,
    ]);
    let buf = '';
    proc.stdout.on('data', c => { buf += c; });
    proc.on('close', code => code === 0 ? resolve(buf) : reject(new Error('ffprobe failed')));
    proc.on('error', reject);
  });
  const probe = JSON.parse(out);
  const audio = probe.streams?.find(s => s.codec_type === 'audio');
  return {
    duration:   parseFloat(probe.format?.duration) || null,
    sampleRate: parseInt(audio?.sample_rate) || null,
    channels:   parseInt(audio?.channels) || 1,
  };
}

// Shared pre-EQ chain: downmix to mono and resample to target SR if
// needed. Used by both measure and render passes so the EQ sees the same
// sample rate (biquad coefficients are SR-dependent — running EQ at
// 44.1 kHz in measure and 48 kHz in render would produce slightly
// different peaks and break the linear-gain guarantee).
function buildPreEqChain(meta, settings) {
  const targetSr = parseInt(settings.sampleRate ?? 48000, 10);
  const parts = ['aformat=channel_layouts=mono'];
  if (meta.sampleRate !== targetSr) {
    parts.push(`aresample=${targetSr}:filter_size=64`);
  }
  return parts.join(',');
}

// ── Measure loudness after EQ ──
// Runs the file through pre-EQ + EQ + loudnorm in measurement mode. The
// loudnorm filter prints a JSON block with input_i, input_tp, input_lra,
// input_thresh, target_offset — those feed the render pass to perform a
// single-pass linear normalisation when possible (loudnorm falls back to
// dynamic gain riding only when the linear gain would clip the TP target).
async function measureLoudnessAfterEq(inputPath, preChain, eqChain, duration, onProgress, setCurrent) {
  const chain = `${preChain},${eqChain},loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP_DB}:LRA=${TARGET_LRA}:print_format=json`;
  const stderr = await run('ffmpeg', [
    '-y', '-i', inputPath,
    '-af', chain,
    '-f', 'null', '-',
  ], { duration, onProgress, setCurrent });
  // loudnorm prints a JSON object at the end of stderr. Be lenient with
  // surrounding whitespace and capture the first object containing input_i.
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

// ── Render: pre-EQ + EQ + (optional) loudnorm ──
async function renderFile(inputPath, outputPath, preChain, eqChain, stats, applyLoudnorm, settings, duration, onProgress, setCurrent) {
  const codecArgs = buildOutputCodecArgs(settings);
  const filters = [preChain, eqChain];
  if (applyLoudnorm && stats) {
    filters.push(
      `loudnorm=I=${TARGET_LUFS}:TP=${TARGET_TP_DB}:LRA=${TARGET_LRA}:` +
      `measured_I=${stats.inputI}:measured_LRA=${stats.inputLra}:` +
      `measured_TP=${stats.inputTp}:measured_thresh=${stats.inputThresh}:` +
      `offset=${stats.targetOffset}`
    );
  }
  await run('ffmpeg', [
    '-y', '-i', inputPath,
    '-af', filters.join(','),
    ...codecArgs,
    outputPath,
  ], { duration, onProgress, setCurrent });
}

// ── ETA ──
function calcEta(startMs, done, total) {
  if (done === 0) return null;
  const elapsed = (Date.now() - startMs) / 1000;
  return Math.round(elapsed / done * (total - done));
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
      emit('progress', {
        file: file.path, step: 'Reading metadata', stepIndex: 1, stepTotal: 3,
        pct: 2, eta: null,
      });

      const meta = await probeBasic(file.path);
      const duration = meta.duration ?? file.duration ?? null;

      if (isCancelled()) break;

      const preChain = buildPreEqChain(meta, settings);
      const eqChain = buildEqChain(settings);

      emit('progress', {
        file: file.path, step: 'Measuring loudness', stepIndex: 2, stepTotal: 3,
        pct: 10, eta: calcEta(t0, done, total),
      });

      const stats = await measureLoudnessAfterEq(file.path, preChain, eqChain, duration,
        frac => {
          if (isCancelled()) return;
          emit('progress', {
            file: file.path, step: 'Measuring loudness', stepIndex: 2, stepTotal: 3,
            pct: Math.round(10 + frac * 40),
            eta: calcEta(t0, done + frac * 0.5, total),
          });
        }, setCurrent);

      if (isCancelled()) break;

      // Only normalize when the source is quieter than the target — files
      // that already meet or exceed −16 LUFS pass through with EQ only.
      const applyLoudnorm = stats !== null && stats.inputI < TARGET_LUFS;
      const verb = stats === null
        ? 'measure failed — render with EQ only'
        : applyLoudnorm
          ? `→ loudnorm to ${TARGET_LUFS} LUFS, TP ≤ ${TARGET_TP_DB} dBTP`
          : `already at/above ${TARGET_LUFS} LUFS — keep as-is`;
      const summary = stats === null
        ? 'loudness measure failed'
        : `I=${stats.inputI.toFixed(1)} LUFS, TP=${stats.inputTp.toFixed(1)} dBFS, LRA=${stats.inputLra.toFixed(1)} LU ${verb}`;
      console.log(`[AudioPro] ${path.basename(file.path)}: ${summary}`);
      emit('loudness', { file: file.path, message: summary });

      const outputPath = resolveOutputPath(file.path, settings);

      emit('progress', {
        file: file.path, step: 'Rendering', stepIndex: 3, stepTotal: 3,
        pct: 55, eta: calcEta(t0, done + 0.5, total),
      });

      await renderFile(file.path, outputPath, preChain, eqChain, stats, applyLoudnorm, settings, duration,
        frac => {
          if (isCancelled()) return;
          emit('progress', {
            file: file.path, step: 'Rendering', stepIndex: 3, stepTotal: 3,
            pct: Math.round(55 + frac * 44),
            eta: calcEta(t0, done + 0.5 + frac * 0.5, total),
          });
        }, setCurrent);

      done++;
      emit('file:done', { file: file.path, outputPath });

    } catch (err) {
      done++;
      emit('file:error', { file: file.path, error: err.message });
    }
  }

  emit('batch:done', { total, done });
}

module.exports = { processQueue };
