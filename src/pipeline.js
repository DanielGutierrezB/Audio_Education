'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const binPaths = require('./bin-paths');

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
    parts.push('agate=threshold=0.005:ratio=4:attack=5:release=80:range=0.003');
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

  // Adaptive body boost — the analyzer can shift this based on f0.
  const bodyHz = Math.round(settings.bodyBoostHz ?? 800);

  // Dynamic resonant-peak notches discovered by voice-profile.js. Each
  // entry is {freq, q, prominenceDb}. We attenuate by min(prominence-2, 6) dB
  // so very sharp resonances get cut more aggressively, but we never go
  // below −6 dB to keep the voice natural.
  const notches = Array.isArray(settings.dynamicNotches) ? settings.dynamicNotches : [];

  const filters = [
    `highpass=f=${hpfFreq}:poles=2`,
    'equalizer=f=150:width_type=o:width=1.0:g=1',
    'equalizer=f=250:width_type=o:width=1.5:g=-1.5',
  ];

  // Insert dynamic notches BEFORE the body boost so we don't fight ourselves.
  for (const n of notches) {
    if (!n || !Number.isFinite(n.freq) || n.freq <= 0) continue;
    const q = Math.min(20, Math.max(2, Number(n.q) || 8));
    const cutDb = -Math.min(6, Math.max(2, (Number(n.prominenceDb) || 4) - 2));
    // ffmpeg's equalizer with width_type=q uses Q (the actual quality factor)
    filters.push(`equalizer=f=${Math.round(n.freq)}:width_type=q:width=${q}:g=${cutDb}`);
  }

  filters.push(
    `equalizer=f=${bodyHz}:width_type=o:width=2.0:g=1`,
    'equalizer=f=2500:width_type=o:width=2.0:g=3',
    'equalizer=f=4000:width_type=o:width=1.5:g=2',
    'equalizer=f=12000:width_type=o:width=2:g=2',
  );

  if (deEsser) {
    filters.splice(filters.length - 1, 0, 'equalizer=f=6500:width_type=h:width=2000:g=-2');
  }

  if (breathReduction) {
    filters.push('agate=threshold=0.02:ratio=2:attack=5:release=150');
  }

  return filters.join(',');
}

// True peak ceiling. Default = -1 dBTP (broadcast standard, conservative).
// The loudnorm and the limiter MUST agree on this number; previously
// loudnorm targeted -1.5 while the limiter was already at -1.0, so loudness
// could quietly hit -1.0 before the limiter took over (±0.5 dB inconsistency).
const DEFAULT_TP_DBTP = -1.0;

function _dbtpToLinear(dbtp) {
  return Math.pow(10, dbtp / 20);
}

function buildLimiter(tpTarget) {
  // Aim a hair below the requested ceiling so resampling/dither headroom
  // doesn't push us over the user-visible target.
  const safety = (tpTarget ?? DEFAULT_TP_DBTP) - 0.2;
  const limit = _dbtpToLinear(safety);
  return `alimiter=level_in=1:limit=${limit.toFixed(6)}:level_out=1:attack=5:release=50`;
}

function buildSingleBandComp(tpTarget) {
  return `acompressor=threshold=0.06:ratio=3:attack=15:release=150:makeup=2.5,${buildLimiter(tpTarget)}`;
}

function buildLoudnormBase(lufsTarget, tpTarget) {
  const tp = tpTarget ?? DEFAULT_TP_DBTP;
  return `I=${lufsTarget ?? -16}:TP=${tp}:LRA=11`;
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

const RUN_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes max per FFmpeg pass

function run(cmd, args, opts = {}) {
  // Resolve bundled binary paths
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
        // Include last 300 chars of stderr for troubleshooting
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

// ── Analysis ──

async function analyzeFile(filePath, setCurrent) {
  const out = await new Promise((resolve, reject) => {
    const proc = spawn(binPaths.ffprobe(), [
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

// ── Resemble Enhance speech regeneration ──

function findPython() {
  // 1. Explicit env var wins (used in dev: AUDIOPRO_PYTHON=...)
  if (process.env.AUDIOPRO_PYTHON && fs.existsSync(process.env.AUDIOPRO_PYTHON)) {
    return process.env.AUDIOPRO_PYTHON;
  }
  // 2. Embedded runtime that ships with the .app (production install).
  //    This is what end-users hit — they don't need any Python on their machine.
  const embedded = binPaths.embeddedPython?.();
  if (embedded) return embedded;
  // 3. Local dev venv at ~/.audiopro-venv (the one we set up during
  //    development with `python3.10 -m venv ~/.audiopro-venv`). Picked up
  //    automatically so `npm start` works without exporting AUDIOPRO_PYTHON.
  const home = process.env.HOME;
  if (home) {
    const devVenvPy = path.join(home, '.audiopro-venv', 'bin', 'python');
    if (fs.existsSync(devVenvPy)) return devVenvPy;
  }
  // 4. Dev fallback: scan well-known system interpreters.
  const candidates = [
    '/opt/homebrew/bin/python3.10',  // matches torch==2.1.1 (resemble-enhance pin)
    '/opt/homebrew/bin/python3.11',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3.10',
    '/usr/local/bin/python3.12',
    '/usr/local/bin/python3',
    'python3.10',
    'python3',
  ];
  for (const c of candidates) {
    if (c.startsWith('/')) {
      if (fs.existsSync(c)) return c;
    } else {
      // PATH-relative — trust it; spawn will fail if missing
      return c;
    }
  }
  return 'python3';
}

async function runResembleEnhance(inputPath, outputPath, settings, setCurrent, onLog, onProgress) {
  const py = findPython();
  const script = path.join(__dirname, 'python', 'enhance.py');
  const preset = settings.enhancePreset ?? 'ultra_subtle';
  const args = [
    script, inputPath, outputPath,
    `preset=${preset}`,
    `device=${settings.enhanceDevice ?? 'cpu'}`,
  ];
  // Allow per-file overrides
  if (settings.enhanceLambd != null) args.push(`lambd=${settings.enhanceLambd}`);
  if (settings.enhanceTau   != null) args.push(`tau=${settings.enhanceTau}`);
  if (settings.enhanceNfe   != null) args.push(`nfe=${settings.enhanceNfe}`);

  return new Promise((resolve, reject) => {
    const proc = spawn(py, args);
    if (setCurrent) setCurrent(proc);
    let stderr = '';

    // Parse RE:progress lines. Two formats supported:
    //   'RE:progress <cur>/<total>'                  (legacy, single bar)
    //   'RE:progress <label> <cur>/<total>'          (current; label = chunk|diffusion)
    //
    // We track chunk and diffusion separately and combine them so the bar moves
    // smoothly: each chunk = 1/chunkTotal of the bar, the inner diffusion
    // contributes the fractional part within the current chunk.
    let chunkCur = 0, chunkTot = 0;
    let diffCur = 0, diffTot = 0;

    function emitCombined() {
      if (!onProgress) return;
      let frac;
      if (chunkTot > 0) {
        const inner = diffTot > 0 ? Math.min(diffCur / diffTot, 1) : 0;
        frac = Math.min((chunkCur + inner) / chunkTot, 1);
      } else if (diffTot > 0) {
        frac = Math.min(diffCur / diffTot, 1);
      } else {
        return;
      }
      onProgress(frac);
    }

    function parseProgress(text) {
      if (!onProgress) return;
      const lines = text.split(/\r?\n/);
      for (const line of lines) {
        let m = line.match(/^RE:progress\s+(chunk|diffusion)\s+(\d+)\s*\/\s*(\d+)/);
        if (m) {
          const label = m[1];
          const cur = parseInt(m[2], 10);
          const tot = parseInt(m[3], 10);
          if (label === 'chunk') {
            chunkCur = cur;
            chunkTot = tot;
            // Reset inner diffusion bar each new chunk
            diffCur = 0;
          } else {
            diffCur = cur;
            diffTot = tot;
          }
          emitCombined();
          continue;
        }
        // Legacy fallback
        m = line.match(/^RE:progress\s+(\d+)\s*\/\s*(\d+)/);
        if (m) {
          const cur = parseInt(m[1], 10);
          const tot = parseInt(m[2], 10);
          if (tot > 0) onProgress(Math.min(cur / tot, 1));
        }
      }
    }

    proc.stdout.on('data', chunk => {
      const t = chunk.toString();
      parseProgress(t);
      if (onLog) onLog(t);
    });
    proc.stderr.on('data', chunk => {
      const t = chunk.toString();
      stderr += t;
      if (onLog) onLog(t);
    });
    proc.on('close', code => {
      if (setCurrent) setCurrent(null);
      if (code === 0) return resolve();
      // Map exit codes to clearer messages
      if (code === 2) {
        return reject(new Error('Resemble Enhance not installed. Run: pip install resemble-enhance soundfile torch'));
      }
      if (code === 3) {
        return reject(new Error('Resemble produced near-silent output (model/device bug). Try CPU or a different preset.'));
      }
      reject(new Error(`Resemble Enhance failed (exit ${code}): ${stderr.slice(-300).trim()}`));
    });
    proc.on('error', err => {
      if (setCurrent) setCurrent(null);
      reject(err);
    });
  });
}

// ── DeepFilterNet denoise ──

/**
 * Step 0 — normalise the source file to AudioPro's canonical working
 * format: mono / 48 kHz / 16-bit PCM. Every downstream step (denoise,
 * Resemble, EQ, MBC, render) operates on this format.
 *
 * 16-bit is mandated by the bundled DeepFilterNet binary, which panics
 * with `TooWide` on anything wider. Keeping the whole pipeline at 16-bit
 * avoids quality-degrading bit-depth round-trips between stages.
 */
async function normaliseInput(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binPaths.ffmpeg(), [
      '-y', '-v', 'error',
      '-i', inputPath,
      '-ac', '1',           // mono
      '-ar', '48000',       // 48 kHz
      '-c:a', 'pcm_s16le',  // 16-bit (DeepFilterNet limit)
      '-f', 'wav',
      outputPath,
    ]);
    let stderr = '';
    proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Input normalisation failed (${code}): ${stderr.slice(-200).trim()}`));
    });
    proc.on('error', reject);
  });
}

async function runDeepFilterNet(inputPath, outputPath, setCurrent, settings) {
  // Input is already mono / 48 kHz / 24-bit (Step 0 normalised it).
  // deep-filter writes to an output directory, so we use a temp dir.
  const tmpDir = path.join(os.tmpdir(), `audiopro_dfn_${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  return new Promise((resolve, reject) => {
    // --atten-lim-db caps how much DFN can attenuate the noisy signal.
    // The default is 100 dB (full reduction), which produces an
    // "over-processed" robotic / underwater sound on speech. Adobe
    // Podcast Enhance and similar tools sit around 12-20 dB. We use 18
    // dB — still removes obvious background noise but keeps the room
    // tone natural and avoids the artefact-heavy "vacuum" sound.
    const attenLimDb = String(settings?.aiDenoiseAttenLimDb ?? 18);
    const proc = spawn(binPaths.deepFilter(), [
      inputPath,
      '-o', tmpDir,
      '--compensate-delay',
      '--atten-lim-db', attenLimDb,
    ]);
    if (setCurrent) setCurrent(proc);
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('close', code => {
      if (setCurrent) setCurrent(null);
      if (code !== 0) {
        try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
        return reject(new Error(`DeepFilterNet failed (code ${code}): ${stderr.slice(-200)}`));
      }
      // deep-filter outputs to tmpDir with the same filename as the input.
      const outName = path.basename(inputPath);
      const dfnOutput = path.join(tmpDir, outName);
      try {
        fs.copyFileSync(dfnOutput, outputPath);
        fs.rmSync(tmpDir, { recursive: true });
      } catch (e) {
        try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
        return reject(new Error(`DeepFilterNet output not found: ${e.message}`));
      }
      resolve();
    });
    proc.on('error', err => {
      if (setCurrent) setCurrent(null);
      try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
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
    '-acodec', 'pcm_s16le', '-ar', '48000',
    outputPath,
  ], { duration, onProgress, setCurrent });
}

// ── Loudness measure pass ──

async function measureLoudness(filePath, duration, eqChain, loudnormBase, onProgress, setCurrent, tpTarget) {
  const chain = `${eqChain},${buildSingleBandComp(tpTarget)},loudnorm=${loudnormBase}:print_format=json`;
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
  const tpTarget = settings.tpTarget;
  const LIMITER = buildLimiter(tpTarget);

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
  const { analyzeAudio } = require('./analyzer');

  const total = files.length;
  let done = 0;
  const t0 = Date.now();

  for (const file of files) {
    if (isCancelled()) break;

    // Validate file is readable before starting
    try { fs.accessSync(file.path, fs.constants.R_OK); } catch {
      emit('file:error', { file: file.path, error: 'File not readable or not found' });
      done++;
      continue;
    }

    emit('file:start', { file: file.path, index: done, total });
    let tempPath = null;
    let dfnTempPath = null;
    let normalisedInputPath = null;

    try {
      // Step 1 — Smart Analysis
      emit('progress', {
        file: file.path, step: 'Analyzing audio...', stepIndex: 1, stepTotal: 6,
        pct: 2, eta: null,
      });

      // Run deep analysis to determine optimal workflow
      const { analysis, recommendations } = await analyzeAudio(file.path, (status) => {
        emit('progress', {
          file: file.path, step: `Analyzing: ${status}`, stepIndex: 1, stepTotal: 6,
          pct: 3, eta: null,
        });
      });

      // Merge analyzer recommendations with user overrides.
      //
      // Default: user settings override analyzer recommendations (Object
      // spread order). EXCEPTION: speech regeneration is gated by the
      // analyzer when the user hasn't explicitly opted in. Otherwise a
      // stale `enhanceEnabled: true` in the saved prefs (or in the user's
      // last UI session) re-runs Resemble on every file even when the
      // analyzer recommended skipping it (which is what was happening
      // in production: log read "Audio is clean enough — skipping speech
      // regeneration" yet Step 3/6 still ran).
      const fileSettings = { ...recommendations.settings, ...settings };
      if (settings.mode === 'auto' || !settings.mode) {
        // Auto mode: let the analyzer drive everything it knows about.
        Object.assign(fileSettings, recommendations.settings);
      } else {
        // Quality / Fast mode (user explicitly picked one): respect user
        // preference for enhanceEnabled IF they actually toggled it on.
        // But honour the analyzer's `false` when the user kept the toggle
        // off, so we don't force regen on clean audio just because of a
        // stale auto-setting from a previous run.
        if (settings.enhanceEnabled !== true) {
          fileSettings.enhanceEnabled = recommendations.settings.enhanceEnabled === true;
          if (recommendations.settings.enhancePreset) {
            fileSettings.enhancePreset = recommendations.settings.enhancePreset;
          }
        }
      }

      // Emit analysis results for UI
      emit('analysis', {
        file: file.path,
        analysis,
        recommendations,
      });

      if (isCancelled()) break;

      const duration = analysis.basic.duration ?? file.duration ?? null;
      // AI Denoise (DeepFilterNet) is opt-out via the dedicated toggle and
      // also disabled in 'fast' mode. Anything else falls back to FFmpeg's
      // afftdn inside the pre-process chain.
      const useMLDenoise = fileSettings.mode !== 'fast'
        && fileSettings.aiDenoiseEnabled !== false;
      // Speech regeneration is OFF by default. UI/settings opt-in via
      // settings.enhanceEnabled. Auto mode could turn it on for very degraded
      // audio in the future — left to recommendations.
      const useEnhance = fileSettings.enhanceEnabled === true;
      const STEP_TOTAL = (useMLDenoise ? 1 : 0) + (useEnhance ? 1 : 0) + 4;
      let stepIdx = 2;

      // Step 0 (between analysis and denoise) — lock the audio into
      // AudioPro's canonical working format: mono / 48 kHz / 24-bit. From
      // here on, the pipeline never has to re-resample or re-quantise; we
      // just keep that resolution all the way through to the final render.
      emit('progress', {
        file: file.path, step: 'Preparing (mono / 48 kHz / 16-bit)', stepIndex: stepIdx, stepTotal: STEP_TOTAL,
        pct: 5, eta: calcEta(t0, done, total),
      });
      normalisedInputPath = path.join(
        os.tmpdir(),
        `audiopro_norm_${crypto.randomBytes(8).toString('hex')}.wav`,
      );
      await normaliseInput(file.path, normalisedInputPath);
      let pipelineInput = normalisedInputPath;

      // Build chains from per-file settings. Both loudnorm and the limiter
      // share the same true-peak target so they can't disagree.
      const eqChain = buildEqChain(fileSettings);
      const loudnormBase = buildLoudnormBase(fileSettings.lufsTarget, fileSettings.tpTarget);

      // Step 2 — DeepFilterNet ML Denoise (if recommended)
      if (useMLDenoise) {
        emit('progress', {
          file: file.path, step: 'AI Denoise (DeepFilterNet)', stepIndex: stepIdx, stepTotal: STEP_TOTAL,
          pct: 8, eta: calcEta(t0, done, total),
        });

        dfnTempPath = path.join(os.tmpdir(), `audiopro_dfn_${crypto.randomBytes(8).toString('hex')}_${path.basename(file.path)}`);

        try {
          // Pass the already-normalised input — deep-filter expects
          // mono / 48 kHz / 24-bit and that's what we have at this stage.
          await runDeepFilterNet(pipelineInput, dfnTempPath, setCurrent, fileSettings);
          pipelineInput = dfnTempPath;
        } catch (dfnErr) {
          console.warn(`DeepFilterNet failed, falling back to FFmpeg: ${dfnErr.message}`);
          // Force FFmpeg denoise in pre-process
          fileSettings.mode = 'fast';
        }

        if (isCancelled()) break;
        stepIdx++;
      }

      // Step — Resemble Enhance (Speech Regeneration)
      if (useEnhance) {
        const presetLabel = fileSettings.enhancePreset ?? 'ultra_subtle';
        emit('progress', {
          file: file.path,
          step: `Speech Regeneration (Resemble — ${presetLabel})`,
          stepIndex: stepIdx, stepTotal: STEP_TOTAL,
          pct: 14, eta: calcEta(t0, done, total),
        });

        const enhTempPath = path.join(
          os.tmpdir(),
          `audiopro_enh_${crypto.randomBytes(8).toString('hex')}_${path.basename(file.path)}`,
        );

        try {
          await runResembleEnhance(pipelineInput, enhTempPath, fileSettings, setCurrent,
            (logLine) => {
              // Log to stderr-style channel via emit; UI can ignore
              emit('log', { file: file.path, source: 'resemble', message: logLine.trim() });
            },
            (frac) => {
              if (isCancelled()) return;
              // Map Resemble's 0..1 progress into 14% → 24% of the global bar
              emit('progress', {
                file: file.path,
                step: `Speech Regeneration (${presetLabel}) ${Math.round(frac * 100)}%`,
                stepIndex: stepIdx, stepTotal: STEP_TOTAL,
                pct: Math.round(14 + frac * 10),
                eta: calcEta(t0, done + 0.05 + frac * 0.10, total),
              });
            },
          );
          // Clean up previous DFN temp now that we have the next stage
          if (dfnTempPath && pipelineInput === dfnTempPath) {
            try { fs.unlinkSync(dfnTempPath); } catch { /* ignore */ }
            dfnTempPath = null;
          }
          pipelineInput = enhTempPath;
          // Stash the new temp under dfnTempPath so the existing finally{} cleans it.
          // (Keeping the cleanup logic single-source.)
          dfnTempPath = enhTempPath;
        } catch (enhErr) {
          console.warn(`Resemble Enhance failed, continuing without regeneration: ${enhErr.message}`);
          emit('log', { file: file.path, source: 'resemble', message: `WARN: ${enhErr.message}` });
          // Clean up the (likely partial) output
          try { fs.unlinkSync(enhTempPath); } catch { /* ignore */ }
        }

        if (isCancelled()) break;
        stepIdx++;
      }

      // Step 3 — Pre-process (mono + gate + trim)
      const prepLabel = useMLDenoise ? 'Gate + Trim' : 'Denoise + Gate';
      emit('progress', {
        file: file.path, step: prepLabel, stepIndex: stepIdx, stepTotal: STEP_TOTAL,
        pct: 25, eta: calcEta(t0, done + 0.1, total),
      });

      tempPath = path.join(os.tmpdir(), `audiopro_${crypto.randomBytes(8).toString('hex')}_${path.basename(file.path)}`);

      await preprocessFile(pipelineInput, tempPath, fileSettings, duration,
        frac => {
          if (isCancelled()) return;
          emit('progress', {
            file: file.path, step: prepLabel, stepIndex: stepIdx, stepTotal: STEP_TOTAL,
            pct: Math.round(25 + frac * 15),
            eta: calcEta(t0, done + frac * 0.2, total),
          });
        }, setCurrent);

      if (isCancelled()) break;
      stepIdx++;

      // Step 4 — EQ Measure
      emit('progress', {
        file: file.path, step: 'EQ Measure', stepIndex: stepIdx, stepTotal: STEP_TOTAL,
        pct: 42, eta: calcEta(t0, done + 0.3, total),
      });

      const stats = await measureLoudness(tempPath, duration, eqChain, loudnormBase,
        frac => {
          if (isCancelled()) return;
          emit('progress', {
            file: file.path, step: 'EQ Measure', stepIndex: stepIdx, stepTotal: STEP_TOTAL,
            pct: Math.round(42 + frac * 20),
            eta: calcEta(t0, done + 0.3 + frac * 0.2, total),
          });
        }, setCurrent, fileSettings.tpTarget);

      if (isCancelled()) break;
      stepIdx++;

      // Step 5 — Render
      const outputPath = resolveOutputPath(file.path, fileSettings);

      emit('progress', {
        file: file.path, step: 'Render', stepIndex: stepIdx, stepTotal: STEP_TOTAL,
        pct: 64, eta: calcEta(t0, done + 0.5, total),
      });

      await renderFile(tempPath, outputPath, stats, eqChain, loudnormBase, fileSettings, duration,
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
      if (normalisedInputPath) {
        try { fs.unlinkSync(normalisedInputPath); } catch { /* ignore */ }
      }
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
