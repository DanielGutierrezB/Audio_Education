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
  if (settings.noiseGateEnabled !== false && settings.mode !== 'clean') {
    // Gentler noise gate — less aggressive range to avoid cutting natural room tone
    parts.push('agate=threshold=0.003:ratio=3:attack=8:release=120:range=0.01');
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
  // Manual override — when the user has built a chain in the EQ editor
  // and toggled "Apply to all", that chain replaces the entire built-in
  // voice-warm EQ. The breath gate (if requested) is still appended so
  // the user doesn't lose downstream functionality.
  if (settings.manualEqApply === true && typeof settings.manualEqChain === 'string'
      && settings.manualEqChain.trim()) {
    const parts = [settings.manualEqChain.trim()];
    if (settings.breathReductionEnabled === true) {
      parts.push('agate=threshold=0.02:ratio=2:attack=5:release=150');
    }
    return parts.join(',');
  }

  const hpfFreq = settings.hpfFrequency ?? 80;
  const deEsser = settings.deEsserEnabled !== false;
  const breathReduction = settings.breathReductionEnabled === true;

  // Voice-optimized EQ curve — warm, full, broadcast-quality
  // Low shelf at 120Hz targets voice fundamentals (80-150Hz)
  // NOT at 250Hz which is the "boxy" zone that sounds hollow/echoey
  const filters = [
    `highpass=f=${hpfFreq}:poles=2`,
    'lowshelf=f=120:width_type=o:width=0.7:g=4',       // voice warmth (fundamentals only)
    'equalizer=f=300:width_type=o:width=1.5:g=-2',     // cut boxiness / room resonance
    'equalizer=f=800:width_type=o:width=2.0:g=0.5',    // lower mids, subtle body
    'equalizer=f=2000:width_type=o:width=1.5:g=2',     // upper-mid clarity
    'equalizer=f=3500:width_type=o:width=1.2:g=1',     // presence / intelligibility
    'equalizer=f=8000:width_type=o:width=2.0:g=-0.5',  // tame harshness
  ];

  if (deEsser) {
    const deEsserGain = settings.deEsserGain ?? -2;
    filters.splice(6, 0, `equalizer=f=6500:width_type=h:width=2000:g=${deEsserGain}`);
  }

  if (breathReduction) {
    filters.push('agate=threshold=0.02:ratio=2:attack=5:release=150');
  }

  return filters.join(',');
}

const LIMITER = 'alimiter=level_in=1:limit=0.891:level_out=1:attack=5:release=50';

function buildSingleBandComp(settings = {}) {
  const ratio = settings.compressionRatio ?? 2.5;
  const makeup = ratio <= 2 ? 1.5 : ratio <= 3 ? 2 : 2.5;
  return `acompressor=threshold=0.08:ratio=${ratio}:attack=15:release=200:makeup=${makeup},${LIMITER}`;
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

// ── DeepFilterNet denoise ──

async function runDeepFilterNet(inputPath, outputPath, setCurrent, opts = {}) {
  // deep-filter writes to an output directory, so we use a temp dir
  const tmpDir = path.join(os.tmpdir(), `audiopro_dfn_${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  // DFN 0.5.x crashes on 24-bit WAV ("TooWide") — convert to 16-bit first
  let dfnInput = inputPath;
  let convertedInput = null;
  try {
    const probeOut = await new Promise((res, rej) => {
      const p = spawn(binPaths.ffprobe(), ['-v', 'quiet', '-print_format', 'json', '-show_streams', inputPath]);
      let buf = '';
      p.stdout.on('data', c => { buf += c; });
      p.on('close', code => code === 0 ? res(buf) : rej(new Error('ffprobe failed')));
      p.on('error', rej);
    });
    const streams = JSON.parse(probeOut).streams || [];
    const audio = streams.find(s => s.codec_type === 'audio');
    const bps = parseInt(audio?.bits_per_sample) || 16;
    if (bps > 16) {
      convertedInput = path.join(tmpDir, `input_16bit_${path.basename(inputPath)}`);
      await new Promise((res, rej) => {
        const p = spawn(binPaths.ffmpeg(), ['-y', '-i', inputPath, '-acodec', 'pcm_s16le', '-ar', String(audio?.sample_rate || 48000), convertedInput]);
        p.on('close', code => code === 0 ? res() : rej(new Error('16-bit conversion failed')));
        p.on('error', rej);
      });
      dfnInput = convertedInput;
    }
  } catch { /* proceed with original file */ }

  return new Promise((resolve, reject) => {
    const args = [
      dfnInput,
      '-o', tmpDir,
      '--compensate-delay',
    ];
    // Limit attenuation for light denoise (less aggressive)
    // 100 = full denoise, 6 = very subtle, 0 = no denoise
    if (opts.attenLimitDb != null) {
      args.push('--atten-lim-db', String(opts.attenLimitDb));
    }
    const proc = spawn(binPaths.deepFilter(), args);
    if (setCurrent) setCurrent(proc);
    let stderr = '';
    proc.stderr.on('data', chunk => { stderr += chunk.toString(); });
    proc.on('close', code => {
      if (setCurrent) setCurrent(null);
      if (code !== 0) {
        try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
        return reject(new Error(`DeepFilterNet failed (code ${code}): ${stderr.slice(-200)}`));
      }
      // deep-filter outputs to tmpDir with the same filename as the input
      const outName = path.basename(dfnInput);
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

// ── BodyGen: harmonic exciter + sub-harmonic synthesis ──

async function runBodyGen(inputPath, outputPath, setCurrent, opts = {}) {
  const pythonScript = path.join(__dirname, 'python', 'bodygen.py');
  const args = [
    pythonScript, inputPath, outputPath,
    '--mix', String(opts.mix ?? 0.12),
    '--sub-mix', String(opts.subMix ?? 0.06),
  ];
  if (opts.lowFreq) args.push('--low-freq', String(opts.lowFreq));
  if (opts.highFreq) args.push('--high-freq', String(opts.highFreq));

  await run('python3', args, { setCurrent, timeout: 2 * 60 * 1000 });
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

async function measureLoudness(filePath, duration, eqChain, loudnormBase, settings, onProgress, setCurrent) {
  const chain = `${eqChain},${buildSingleBandComp(settings)},loudnorm=${loudnormBase}:print_format=json`;
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
    // Gentler ratios to avoid over-processing
    const ratio = settings.compressionRatio ?? 2.5;
    const lowRatio = Math.min(ratio + 0.5, 4);    // was 5
    const midRatio = ratio;                         // was 3.5
    const highRatio = Math.max(ratio - 0.5, 1.5);  // was 2
    const parts = [
      `[0:a]${eqChain},asplit=3[la][ma][ha]`,
      '[la]lowpass=f=300:poles=2[lf]',
      '[ma]highpass=f=250:poles=2,lowpass=f=3500:poles=2[mf]',
      '[ha]highpass=f=3000:poles=2[hf]',
      `[lf]acompressor=threshold=0.06:ratio=${lowRatio}:attack=20:release=300:makeup=2[lc]`,
      `[mf]acompressor=threshold=0.1:ratio=${midRatio}:attack=10:release=150:makeup=1.5[mc]`,
      `[hf]acompressor=threshold=0.15:ratio=${highRatio}:attack=5:release=100:makeup=1[hc]`,
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
    const chain = `${eqChain},${buildSingleBandComp(settings)},${loudnorm}`;
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
    let bodyGenTempPath = null;

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

      // Merge analyzer recommendations with user overrides
      const fileSettings = { ...recommendations.settings, ...settings };
      // But let analyzer win on auto-detected things unless user explicitly set them
      if (settings.mode === 'auto' || !settings.mode) {
        Object.assign(fileSettings, recommendations.settings);
      }

      // Emit analysis results for UI
      emit('analysis', {
        file: file.path,
        analysis,
        recommendations,
      });

      if (isCancelled()) break;

      const duration = analysis.basic.duration ?? file.duration ?? null;
      const useMLDenoise = fileSettings.mode === 'quality';  // skip for 'clean' and 'fast'
      const useBodyGen = fileSettings.bodyGenEnabled !== false; // on by default
      let stepCount = 4; // base: analyze + preprocess + EQ measure + render
      if (useMLDenoise) stepCount++;
      if (useBodyGen) stepCount++;
      const STEP_TOTAL = stepCount;
      let stepIdx = 2;
      let pipelineInput = file.path;

      // Build chains from per-file settings
      const eqChain = buildEqChain(fileSettings);
      const loudnormBase = buildLoudnormBase(fileSettings.lufsTarget);

      // Log what the pipeline decided
      console.log(`[AudioPro] ${path.basename(file.path)}: mode=${fileSettings.mode}, denoise=${fileSettings.denoiseStrength ?? 'default'}, compression=${fileSettings.compressionLevel ?? (fileSettings.multiBandCompEnabled ? 'multiband' : 'single')} ratio=${fileSettings.compressionRatio ?? '?'}`);

      // Step 2 — DeepFilterNet ML Denoise (if recommended and not clean audio)
      if (useMLDenoise) {
        emit('progress', {
          file: file.path, step: 'AI Denoise (DeepFilterNet)', stepIndex: stepIdx, stepTotal: STEP_TOTAL,
          pct: 8, eta: calcEta(t0, done, total),
        });

        dfnTempPath = path.join(os.tmpdir(), `audiopro_dfn_${crypto.randomBytes(8).toString('hex')}_${path.basename(file.path)}`);

        try {
          const dfnOpts = {};
          // For light denoise, use reduced attenuation
          if (fileSettings.denoiseStrength === 'light') {
            dfnOpts.attenLimitDb = 12;  // limit attenuation to 12 dB (subtle)
          }
          await runDeepFilterNet(file.path, dfnTempPath, setCurrent, dfnOpts);
          pipelineInput = dfnTempPath;
        } catch (dfnErr) {
          console.warn(`DeepFilterNet failed, falling back to FFmpeg: ${dfnErr.message}`);
          // Force FFmpeg denoise in pre-process
          fileSettings.mode = 'fast';
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

      // Step N — BodyGen (harmonic exciter + sub-harmonic synthesis)
      if (useBodyGen) {
        emit('progress', {
          file: file.path, step: 'BodyGen (harmonics)', stepIndex: stepIdx, stepTotal: STEP_TOTAL,
          pct: Math.round(25 + 15 * (useMLDenoise ? 1 : 0.7)),
          eta: calcEta(t0, done + 0.25, total),
        });

        bodyGenTempPath = path.join(os.tmpdir(), `audiopro_bg_${crypto.randomBytes(8).toString('hex')}_${path.basename(file.path)}`);

        try {
          await runBodyGen(tempPath, bodyGenTempPath, setCurrent, {
            mix: fileSettings.bodyGenMix ?? 0.12,
            subMix: fileSettings.bodyGenSubMix ?? 0.06,
          });
          // Replace tempPath with bodygen output for subsequent steps
          const oldTemp = tempPath;
          tempPath = bodyGenTempPath;
          bodyGenTempPath = oldTemp; // swap so old gets cleaned up
        } catch (bgErr) {
          console.warn(`BodyGen failed, continuing without: ${bgErr.message}`);
          // Continue with unprocessed tempPath
          if (bodyGenTempPath) {
            try { fs.unlinkSync(bodyGenTempPath); } catch { /* ignore */ }
            bodyGenTempPath = null;
          }
        }

        if (isCancelled()) break;
        stepIdx++;
      }

      // Step N — EQ Measure
      emit('progress', {
        file: file.path, step: 'EQ Measure', stepIndex: stepIdx, stepTotal: STEP_TOTAL,
        pct: 42, eta: calcEta(t0, done + 0.3, total),
      });

      const stats = await measureLoudness(tempPath, duration, eqChain, loudnormBase, fileSettings,
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
      if (tempPath) {
        try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
      }
      if (dfnTempPath) {
        try { fs.unlinkSync(dfnTempPath); } catch { /* ignore */ }
      }
      if (bodyGenTempPath) {
        try { fs.unlinkSync(bodyGenTempPath); } catch { /* ignore */ }
      }
    }
  }

  emit('batch:done', { total, done });
}

module.exports = { processQueue };
