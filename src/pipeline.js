'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Filter chains ──

const DENOISE_CHAIN = 'afftdn=nf=-25:tn=1';

function buildEqChain(hpfFreq) {
  const f = hpfFreq ?? 80;
  return [
    `highpass=f=${f}:poles=2`,
    'equalizer=f=300:width_type=o:width=1.5:g=-2',
    'equalizer=f=2500:width_type=o:width=1.5:g=2',
    'equalizer=f=6000:width_type=h:width=4000:g=-3',
    'equalizer=f=12000:width_type=o:width=2:g=1',
  ].join(',');
}

const DYNAMICS_CHAIN = [
  'acompressor=threshold=0.1:ratio=3:attack=10:release=100:makeup=1',
  'alimiter=level_in=1:limit=0.891:level_out=1:attack=5:release=50',
].join(',');

function buildLoudnormBase(lufsTarget) {
  return `I=${lufsTarget ?? -16}:TP=-1.5:LRA=11`;
}

// ── Spawn helper ──

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);

    if (opts.setCurrent) opts.setCurrent(proc);

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
      if (opts.setCurrent) opts.setCurrent(null);
      if (code === 0 || code === null) resolve(stderr);
      else reject(new Error(`${path.basename(cmd)} exited ${code}`));
    });

    proc.on('error', err => {
      if (opts.setCurrent) opts.setCurrent(null);
      reject(err);
    });
  });
}

// ── Analysis ──

async function analyzeFile(filePath, setCurrent) {
  const out = await new Promise((resolve, reject) => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      filePath,
    ]);
    setCurrent(proc);
    let buf = '';
    proc.stdout.on('data', c => { buf += c; });
    proc.on('close', code => {
      setCurrent(null);
      code === 0 ? resolve(buf) : reject(new Error('ffprobe failed'));
    });
    proc.on('error', err => { setCurrent(null); reject(err); });
  });

  const probe = JSON.parse(out);
  const audio = probe.streams?.find(s => s.codec_type === 'audio');
  return {
    duration: parseFloat(probe.format?.duration) || null,
    sampleRate: parseInt(audio?.sample_rate) || null,
    channels: parseInt(audio?.channels) || 1,
    bitDepth: parseInt(audio?.bits_per_sample) || null,
  };
}

// ── Denoise (afftdn) ──

async function denoiseFile(inputPath, outputPath, duration, onProgress, setCurrent) {
  await run('ffmpeg', [
    '-y', '-i', inputPath,
    '-af', DENOISE_CHAIN,
    '-acodec', 'pcm_s24le',
    '-ar', '48000',
    outputPath,
  ], { duration, onProgress, setCurrent });
}

// ── Loudnorm first-pass ──

function parseLoudnormStats(stderr) {
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

async function measureLoudness(filePath, duration, eqChain, loudnormBase, onProgress, setCurrent) {
  const chain = `${eqChain},${DYNAMICS_CHAIN},loudnorm=${loudnormBase}:print_format=json`;
  const stderr = await run('ffmpeg', [
    '-y', '-i', filePath,
    '-af', chain,
    '-f', 'null', '-',
  ], { duration, onProgress, setCurrent });
  return parseLoudnormStats(stderr);
}

// ── Render ──

function buildLoudnormFilter(stats, loudnormBase) {
  if (!stats) return `loudnorm=${loudnormBase}`;
  return (
    `loudnorm=${loudnormBase}:linear=true` +
    `:measured_I=${stats.input_i}` +
    `:measured_LRA=${stats.input_lra}` +
    `:measured_TP=${stats.input_tp}` +
    `:measured_thresh=${stats.input_thresh}`
  );
}

async function renderFile(inputPath, outputPath, stats, eqChain, loudnormBase, duration, onProgress, setCurrent) {
  const chain = `${eqChain},${DYNAMICS_CHAIN},${buildLoudnormFilter(stats, loudnormBase)}`;
  await run('ffmpeg', [
    '-y', '-i', inputPath,
    '-af', chain,
    '-acodec', 'pcm_s24le',
    '-ar', '48000',
    outputPath,
  ], { duration, onProgress, setCurrent });
}

// ── Output path ──

function resolveOutputPath(inputPath) {
  const inputDir = path.dirname(inputPath);
  const outputDir = path.join(path.dirname(inputDir), 'Audio_Pro');
  fs.mkdirSync(outputDir, { recursive: true });
  return path.join(outputDir, path.basename(inputPath));
}

// ── ETA helper ──

function calcEta(startMs, done, total) {
  if (done === 0) return null;
  const elapsed = (Date.now() - startMs) / 1000;
  return Math.round(elapsed / done * (total - done));
}

// ── Queue runner ──

async function processQueue(files, { emit, isCancelled, setCurrent, settings = {} }) {
  const denoise = settings.mode !== 'fast';
  const STEP_TOTAL = denoise ? 4 : 3;
  const eqChain = buildEqChain(settings.hpfFrequency);
  const loudnormBase = buildLoudnormBase(settings.lufsTarget);

  const total = files.length;
  let done = 0;
  const t0 = Date.now();

  for (const file of files) {
    if (isCancelled()) break;

    emit('file:start', { file: file.path, index: done, total });

    let tempPath = null;

    try {
      // Step 1 — Analysis
      emit('progress', { file: file.path, step: 'Analysis', stepIndex: 1, stepTotal: STEP_TOTAL, pct: 5, eta: null });

      const meta = await analyzeFile(file.path, setCurrent);
      if (isCancelled()) break;

      const duration = meta.duration ?? file.duration ?? null;
      let sourceForEq = file.path;

      if (denoise) {
        // Step 2 — Denoise
        emit('progress', { file: file.path, step: 'Denoise', stepIndex: 2, stepTotal: STEP_TOTAL, pct: 12, eta: calcEta(t0, done, total) });

        tempPath = path.join(os.tmpdir(), `audiopro_${Date.now()}_${path.basename(file.path)}`);

        await denoiseFile(file.path, tempPath, duration,
          frac => {
            if (isCancelled()) return;
            emit('progress', {
              file: file.path, step: 'Denoise', stepIndex: 2, stepTotal: STEP_TOTAL,
              pct: Math.round(12 + frac * 28),
              eta: calcEta(t0, done + frac * 0.25, total),
            });
          }, setCurrent);

        if (isCancelled()) break;
        sourceForEq = tempPath;

        // Step 3 — EQ+Measure
        emit('progress', { file: file.path, step: 'EQ Measure', stepIndex: 3, stepTotal: STEP_TOTAL, pct: 42, eta: calcEta(t0, done + 0.25, total) });

        const stats = await measureLoudness(sourceForEq, duration, eqChain, loudnormBase,
          frac => {
            if (isCancelled()) return;
            emit('progress', {
              file: file.path, step: 'EQ Measure', stepIndex: 3, stepTotal: STEP_TOTAL,
              pct: Math.round(42 + frac * 23),
              eta: calcEta(t0, done + 0.25 + frac * 0.25, total),
            });
          }, setCurrent);

        if (isCancelled()) break;

        // Step 4 — Render
        const outputPath = resolveOutputPath(file.path);
        emit('progress', { file: file.path, step: 'Render', stepIndex: 4, stepTotal: STEP_TOTAL, pct: 67, eta: calcEta(t0, done + 0.5, total) });

        await renderFile(sourceForEq, outputPath, stats, eqChain, loudnormBase, duration,
          frac => {
            if (isCancelled()) return;
            emit('progress', {
              file: file.path, step: 'Render', stepIndex: 4, stepTotal: STEP_TOTAL,
              pct: Math.round(67 + frac * 32),
              eta: calcEta(t0, done + 0.5 + frac * 0.5, total),
            });
          }, setCurrent);

        done++;
        emit('file:done', { file: file.path, outputPath });

      } else {
        // Fast mode — skip denoise

        // Step 2 — EQ+Measure
        emit('progress', { file: file.path, step: 'EQ Measure', stepIndex: 2, stepTotal: STEP_TOTAL, pct: 20, eta: calcEta(t0, done, total) });

        const stats = await measureLoudness(file.path, duration, eqChain, loudnormBase,
          frac => {
            if (isCancelled()) return;
            emit('progress', {
              file: file.path, step: 'EQ Measure', stepIndex: 2, stepTotal: STEP_TOTAL,
              pct: Math.round(20 + frac * 35),
              eta: calcEta(t0, done + frac * 0.5, total),
            });
          }, setCurrent);

        if (isCancelled()) break;

        // Step 3 — Render
        const outputPath = resolveOutputPath(file.path);
        emit('progress', { file: file.path, step: 'Render', stepIndex: 3, stepTotal: STEP_TOTAL, pct: 55, eta: calcEta(t0, done + 0.5, total) });

        await renderFile(file.path, outputPath, stats, eqChain, loudnormBase, duration,
          frac => {
            if (isCancelled()) return;
            emit('progress', {
              file: file.path, step: 'Render', stepIndex: 3, stepTotal: STEP_TOTAL,
              pct: Math.round(55 + frac * 44),
              eta: calcEta(t0, done + 0.5 + frac * 0.5, total),
            });
          }, setCurrent);

        done++;
        emit('file:done', { file: file.path, outputPath });
      }

    } catch (err) {
      done++;
      emit('file:error', { file: file.path, error: err.message });
    } finally {
      if (tempPath) {
        try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
      }
    }
  }

  emit('batch:done', { total, done });
}

module.exports = { processQueue };
