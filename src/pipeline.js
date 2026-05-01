'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ── Filter builders ──

function buildPreChain(settings) {
  const parts = [];
  if (settings.stereoToMonoEnabled !== false) {
    parts.push('pan=mono|c0=0.5*c0+0.5*c1');
  }
  // afftdn fallback only used in fast mode or when DFN is unavailable
  if (settings.mode === 'fast') {
    parts.push('afftdn=nf=-20:tn=1:nr=20:om=o');
  }
  if (settings.noiseGateEnabled !== false) {
    parts.push('agate=threshold=0.008:ratio=6:attack=3:release=40:range=0.005');
  }
  if (settings.silenceTrimEnabled !== false) {
    // Trim leading silence only; trailing uses areverse trick to avoid cutting mid-speech pauses
    parts.push('silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.15');
    parts.push('areverse');
    parts.push('silenceremove=start_periods=1:start_threshold=-60dB:start_silence=0.3');
    parts.push('areverse');
  }
  return parts.length ? parts.join(',') : 'acopy';
}

function buildEqChain(settings) {
  const hpfFreq = settings.hpfFrequency ?? 80;
  const deEsser = settings.deEsserEnabled !== false;
  const breathReduction = settings.breathReductionEnabled === true;

  const filters = [
    `highpass=f=${hpfFreq}:poles=2`,
    'equalizer=f=200:width_type=o:width=1.5:g=-2',
    'equalizer=f=2800:width_type=o:width=1.5:g=2.5',
    'equalizer=f=12000:width_type=o:width=2:g=1.5',
  ];

  if (deEsser) {
    filters.splice(3, 0, 'equalizer=f=5500:width_type=h:width=3000:g=-2.5');
  }

  if (breathReduction) {
    filters.push('agate=threshold=0.02:ratio=2:attack=5:release=150');
  }

  return filters.join(',');
}

const LIMITER = 'alimiter=level_in=1:limit=0.891:level_out=1:attack=3:release=30';

function buildSingleBandComp() {
  return `acompressor=threshold=0.08:ratio=4:attack=8:release=80:makeup=2,${LIMITER}`;
}

function buildLoudnormBase(lufsTarget) {
  return `I=${lufsTarget ?? -16}:TP=-1.5:LRA=11`;
}

function parseLoudnormStats(stderr) {
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

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
  const inputDir = path.dirname(inputPath);
  const outputDir = path.join(path.dirname(inputDir), 'Audio_Pro');
  fs.mkdirSync(outputDir, { recursive: true });
  const baseName = path.basename(inputPath, path.extname(inputPath)) + ext;
  return path.join(outputDir, baseName);
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
      '-v', 'quiet', '-print_format', 'json', '-show_streams', '-show_format', filePath,
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
    duration:   parseFloat(probe.format?.duration) || null,
    sampleRate: parseInt(audio?.sample_rate) || null,
    channels:   parseInt(audio?.channels) || 1,
    bitDepth:   parseInt(audio?.bits_per_sample) || null,
  };
}

// ── DeepFilterNet denoise ──

const DENOISE_SCRIPT = path.join(__dirname, 'python', 'denoise.py');

async function runDeepFilterNet(inputPath, outputPath, setCurrent) {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [DENOISE_SCRIPT, inputPath, outputPath]);
    if (setCurrent) setCurrent(proc);
    let stderr = '';
    proc.stdout.on('data', chunk => {
      const line = chunk.toString().trim();
      // Parse status lines: DFN:loading, DFN:processing:duration, DFN:done:elapsed
      if (line.startsWith('DFN:')) {
        const [, status] = line.split(':');
        // Could emit progress here if needed
      }
    });
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('close', code => {
      if (setCurrent) setCurrent(null);
      if (code === 0) resolve();
      else reject(new Error(`DeepFilterNet failed (code ${code}): ${stderr.slice(-200)}`));
    });
    proc.on('error', err => {
      if (setCurrent) setCurrent(null);
      reject(err);
    });
  });
}

// ── Pre-process: mono + [denoise] + noise gate + silence trim ──

async function preprocessFile(inputPath, outputPath, settings, duration, onProgress, setCurrent) {
  const chain = buildPreChain(settings);
  await run('ffmpeg', [
    '-y', '-i', inputPath,
    '-af', chain,
    '-acodec', 'pcm_s24le', '-ar', '48000',
    outputPath,
  ], { duration, onProgress, setCurrent });
}

// ── Loudness measure pass ──

async function measureLoudness(filePath, duration, eqChain, loudnormBase, onProgress, setCurrent) {
  const chain = `${eqChain},${buildSingleBandComp()},loudnorm=${loudnormBase}:print_format=json`;
  const stderr = await run('ffmpeg', [
    '-y', '-i', filePath,
    '-af', chain,
    '-f', 'null', '-',
  ], { duration, onProgress, setCurrent });
  return parseLoudnormStats(stderr);
}

// ── Render: EQ → multi-band or single-band comp → limiter → loudnorm ──

async function renderFile(inputPath, outputPath, stats, eqChain, loudnormBase, settings, duration, onProgress, setCurrent) {
  const loudnorm = buildLoudnormFilter(stats, loudnormBase);
  const codecArgs = buildOutputCodecArgs(settings);
  const useMBC = settings.multiBandCompEnabled !== false;

  if (useMBC) {
    // Multi-band compressor via filter_complex
    // Bands: low 0-300 Hz, mid 250-3500 Hz, high 3000+ Hz
    // Each band gets independent compression, then mixed and limited
    const parts = [
      `[0:a]${eqChain},asplit=3[la][ma][ha]`,
      '[la]lowpass=f=300:poles=2[lf]',
      '[ma]highpass=f=250:poles=2,lowpass=f=3500:poles=2[mf]',
      '[ha]highpass=f=3000:poles=2[hf]',
      '[lf]acompressor=threshold=0.05:ratio=5:attack=20:release=300:makeup=3[lc]',
      '[mf]acompressor=threshold=0.08:ratio=3.5:attack=8:release=120:makeup=2[mc]',
      '[hf]acompressor=threshold=0.12:ratio=2:attack=3:release=80:makeup=1.5[hc]',
      `[lc][mc][hc]amix=inputs=3:normalize=0,volume=1.0,${LIMITER},${loudnorm}[out]`,
    ];
    await run('ffmpeg', [
      '-y', '-i', inputPath,
      '-filter_complex', parts.join(';'),
      '-map', '[out]',
      ...codecArgs,
      outputPath,
    ], { duration, onProgress, setCurrent });
  } else {
    const chain = `${eqChain},${buildSingleBandComp()},${loudnorm}`;
    await run('ffmpeg', [
      '-y', '-i', inputPath,
      '-af', chain,
      ...codecArgs,
      outputPath,
    ], { duration, onProgress, setCurrent });
  }
}

// ── ETA ──

function calcEta(startMs, done, total) {
  if (done === 0) return null;
  const elapsed = (Date.now() - startMs) / 1000;
  return Math.round(elapsed / done * (total - done));
}

// ── Queue runner ──

async function processQueue(files, { emit, isCancelled, setCurrent, settings = {} }) {
  const useMLDenoise = settings.mode !== 'fast';
  const STEP_TOTAL = useMLDenoise ? 5 : 4; // Analysis, [DFN Denoise], Pre-process, EQ Measure, Render
  const eqChain = buildEqChain(settings);
  const loudnormBase = buildLoudnormBase(settings.lufsTarget);

  const total = files.length;
  let done = 0;
  const t0 = Date.now();

  for (const file of files) {
    if (isCancelled()) break;

    emit('file:start', { file: file.path, index: done, total });
    let tempPath = null;
    let dfnTempPath = null;

    try {
      // Step 1 — Analysis
      emit('progress', {
        file: file.path, step: 'Analysis', stepIndex: 1, stepTotal: STEP_TOTAL,
        pct: 3, eta: null,
      });

      const meta = await analyzeFile(file.path, setCurrent);
      if (isCancelled()) break;

      const duration = meta.duration ?? file.duration ?? null;
      let stepIdx = 2;
      let pipelineInput = file.path;

      // Step 2 (Quality only) — DeepFilterNet ML Denoise
      if (useMLDenoise) {
        emit('progress', {
          file: file.path, step: 'AI Denoise (DeepFilterNet)', stepIndex: stepIdx, stepTotal: STEP_TOTAL,
          pct: 5, eta: calcEta(t0, done, total),
        });

        dfnTempPath = path.join(os.tmpdir(), `audiopro_dfn_${Date.now()}_${path.basename(file.path)}`);

        try {
          await runDeepFilterNet(file.path, dfnTempPath, setCurrent);
          pipelineInput = dfnTempPath;
        } catch (dfnErr) {
          // Fall back to FFmpeg denoise if DFN fails
          console.warn(`DeepFilterNet failed, falling back to FFmpeg: ${dfnErr.message}`);
        }

        if (isCancelled()) break;
        stepIdx++;
      }

      // Step 3 (or 2 in Fast) — Pre-process (mono + gate + trim)
      const prepLabel = useMLDenoise ? 'Gate + Trim' : 'Denoise + Gate';
      emit('progress', {
        file: file.path, step: prepLabel, stepIndex: stepIdx, stepTotal: STEP_TOTAL,
        pct: useMLDenoise ? 25 : 10, eta: calcEta(t0, done + 0.1, total),
      });

      tempPath = path.join(os.tmpdir(), `audiopro_${Date.now()}_${path.basename(file.path)}`);

      await preprocessFile(pipelineInput, tempPath, settings, duration,
        frac => {
          if (isCancelled()) return;
          const base = useMLDenoise ? 25 : 10;
          const range = useMLDenoise ? 15 : 30;
          emit('progress', {
            file: file.path, step: prepLabel, stepIndex: stepIdx, stepTotal: STEP_TOTAL,
            pct: Math.round(base + frac * range),
            eta: calcEta(t0, done + frac * 0.2, total),
          });
        }, setCurrent);

      if (isCancelled()) break;
      stepIdx++;

      // Step 4 (or 3) — EQ Measure
      emit('progress', {
        file: file.path, step: 'EQ Measure', stepIndex: stepIdx, stepTotal: STEP_TOTAL,
        pct: useMLDenoise ? 42 : 42, eta: calcEta(t0, done + 0.3, total),
      });

      const stats = await measureLoudness(tempPath, duration, eqChain, loudnormBase,
        frac => {
          if (isCancelled()) return;
          emit('progress', {
            file: file.path, step: 'EQ Measure', stepIndex: stepIdx, stepTotal: STEP_TOTAL,
            pct: Math.round(42 + frac * 20),
            eta: calcEta(t0, done + 0.3 + frac * 0.2, total),
          });
        }, setCurrent);

      if (isCancelled()) break;
      stepIdx++;

      // Step 5 (or 4) — Render
      const outputPath = resolveOutputPath(file.path, settings);

      emit('progress', {
        file: file.path, step: 'Render', stepIndex: stepIdx, stepTotal: STEP_TOTAL,
        pct: 64, eta: calcEta(t0, done + 0.5, total),
      });

      await renderFile(tempPath, outputPath, stats, eqChain, loudnormBase, settings, duration,
        frac => {
          if (isCancelled()) return;
          emit('progress', {
            file: file.path, step: 'Render', stepIndex: stepIdx, stepTotal: STEP_TOTAL,
            pct: Math.round(64 + frac * 35),
            eta: calcEta(t0, done + 0.5 + frac * 0.5, total),
          });
        }, setCurrent);

      done++;
      emit('file:done', { file: file.path, outputPath });

    } catch (err) {
      done++;
      emit('file:error', { file: file.path, error: err.message });
    } finally {
      if (tempPath) {
        try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
      }
      if (dfnTempPath) {
        try { fs.unlinkSync(dfnTempPath); } catch { /* ignore */ }
      }
    }
  }

  emit('batch:done', { total, done });
}

module.exports = { processQueue };
