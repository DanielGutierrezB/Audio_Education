'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const binPaths = require('./bin-paths');
const { profileVoice } = require('./voice-profile');

// ── Helpers ──

function runCmd(cmd, args) {
  // Resolve bundled binary paths
  if (cmd === 'ffmpeg')  cmd = binPaths.ffmpeg();
  if (cmd === 'ffprobe') cmd = binPaths.ffprobe();
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '', stderr = '';
    proc.stdout.on('data', c => { stdout += c; });
    proc.stderr.on('data', c => { stderr += c; });
    proc.on('close', code => {
      if (code === 0 || code === null) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

function parseNumber(val) {
  const n = parseFloat(val);
  return isNaN(n) ? null : n;
}

// ── Analysis Functions ──

async function getBasicInfo(filePath) {
  const { stdout } = await runCmd('ffprobe', [
    '-v', 'quiet', '-print_format', 'json',
    '-show_streams', '-show_format', filePath,
  ]);
  const probe = JSON.parse(stdout);
  const audio = probe.streams?.find(s => s.codec_type === 'audio');
  return {
    duration: parseNumber(probe.format?.duration),
    sampleRate: parseInt(audio?.sample_rate) || 48000,
    channels: parseInt(audio?.channels) || 1,
    bitDepth: parseInt(audio?.bits_per_sample) || 16,
    codec: audio?.codec_name || 'unknown',
  };
}

async function measureLoudness(filePath) {
  const { stderr } = await runCmd('ffmpeg', [
    '-i', filePath,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
    '-f', 'null', '-',
  ]);
  const m = stderr.match(/\{[^{}]*"input_i"[^{}]*\}/s);
  if (!m) return null;
  try {
    const stats = JSON.parse(m[0]);
    return {
      integratedLUFS: parseNumber(stats.input_i),
      truePeak: parseNumber(stats.input_tp),
      lra: parseNumber(stats.input_lra),
      threshold: parseNumber(stats.input_thresh),
    };
  } catch { return null; }
}

async function measureNoiseFloor(filePath, channels) {
  // Find ALL silence regions to get a reliable noise measurement
  const { stderr: silenceStderr } = await runCmd('ffmpeg', [
    '-i', filePath,
    '-af', 'silencedetect=noise=-40dB:d=0.3',
    '-f', 'null', '-',
  ]);

  // Parse all silence start/end pairs
  const silenceStarts = [...silenceStderr.matchAll(/silence_start:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
  const silenceEnds   = [...silenceStderr.matchAll(/silence_end:\s*([\d.]+)/g)].map(m => parseFloat(m[1]));
  const hasSilenceRegions = silenceStarts.length > 0;

  let noiseFloorDb = null;
  let noiseRmsDb = null;
  const noiseMeasurements = [];

  // Measure noise from multiple silence regions for a reliable average
  const regionsToMeasure = Math.min(silenceStarts.length, 5);
  for (let i = 0; i < regionsToMeasure; i++) {
    const start = silenceStarts[i];
    const end = silenceEnds[i] ?? (start + 0.5);
    const dur = Math.min(end - start, 1.0);  // cap at 1s
    if (dur < 0.1) continue;  // too short to measure

    const tmpFile = path.join(os.tmpdir(), `audiopro_analyze_${crypto.randomBytes(6).toString('hex')}.wav`);
    try {
      await runCmd('ffmpeg', [
        '-y', '-i', filePath,
        '-ss', String(start), '-t', String(dur),
        '-ac', '1', tmpFile,
      ]);
      const { stderr: statsStderr } = await runCmd('ffmpeg', [
        '-i', tmpFile,
        '-af', 'astats=measure_perchannel=none:measure_overall=all',
        '-f', 'null', '-',
      ]);
      const nfMatch = statsStderr.match(/Noise floor dB:\s*([\-\d.inf]+)/);
      const rmsMatch = statsStderr.match(/RMS level dB:\s*([\-\d.]+)/);
      const nf = nfMatch ? (nfMatch[1] === '-inf' ? -Infinity : parseNumber(nfMatch[1])) : null;
      const rms = rmsMatch ? parseNumber(rmsMatch[1]) : null;
      if (rms !== null && isFinite(rms)) noiseMeasurements.push(rms);
      if (nf !== null && isFinite(nf) && (noiseFloorDb === null || nf > noiseFloorDb)) noiseFloorDb = nf;
    } catch { /* ignore */ }
    finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  // Use median of noise measurements (robust against outliers)
  if (noiseMeasurements.length > 0) {
    noiseMeasurements.sort((a, b) => a - b);
    const mid = Math.floor(noiseMeasurements.length / 2);
    noiseRmsDb = noiseMeasurements.length % 2 === 0
      ? (noiseMeasurements[mid - 1] + noiseMeasurements[mid]) / 2
      : noiseMeasurements[mid];
  }

  // Measure overall stats
  const { stderr: overallStderr } = await runCmd('ffmpeg', [
    '-i', filePath, '-t', '60', '-ac', '1',
    '-af', 'astats=measure_perchannel=none:measure_overall=all',
    '-f', 'null', '-',
  ]);
  const overallRms = overallStderr.match(/RMS level dB:\s*([\-\d.]+)/);
  const overallPeak = overallStderr.match(/Peak level dB:\s*([\-\d.]+)/);
  const dcOffset = overallStderr.match(/DC offset:\s*([\-\d.e]+)/);

  // Compute SNR: voice level vs noise level
  const voiceRmsDb = overallRms ? parseNumber(overallRms[1]) : null;
  const snrDb = (voiceRmsDb !== null && noiseRmsDb !== null) ? voiceRmsDb - noiseRmsDb : null;

  return {
    noiseFloorDb,
    noiseRmsDb,
    snrDb,
    overallRmsDb: voiceRmsDb,
    overallPeakDb: overallPeak ? parseNumber(overallPeak[1]) : null,
    dcOffset: dcOffset ? parseNumber(dcOffset[1]) : null,
    hasSilenceRegions,
    measurementCount: noiseMeasurements.length,
  };
}

async function detectSibilance(filePath) {
  // Measure energy in sibilance range (4-10kHz) vs overall
  const { stderr: fullStderr } = await runCmd('ffmpeg', [
    '-i', filePath, '-t', '30', '-ac', '1',
    '-af', 'volumedetect',
    '-f', 'null', '-',
  ]);
  const { stderr: highStderr } = await runCmd('ffmpeg', [
    '-i', filePath, '-t', '30', '-ac', '1',
    '-af', 'highpass=f=4000,lowpass=f=10000,volumedetect',
    '-f', 'null', '-',
  ]);

  const fullMean = fullStderr.match(/mean_volume:\s*([\-\d.]+)/);
  const highMean = highStderr.match(/mean_volume:\s*([\-\d.]+)/);

  const fullDb = fullMean ? parseNumber(fullMean[1]) : null;
  const highDb = highMean ? parseNumber(highMean[1]) : null;

  // If high-freq content is within 20dB of the overall, there's significant sibilance
  const sibilanceRatio = (fullDb !== null && highDb !== null) ? fullDb - highDb : null;

  return {
    overallDb: fullDb,
    sibilanceDb: highDb,
    sibilanceRatio,
    hasSibilance: sibilanceRatio !== null && sibilanceRatio < 18,
    severity: sibilanceRatio !== null ? (sibilanceRatio < 12 ? 'high' : sibilanceRatio < 18 ? 'moderate' : 'low') : 'unknown',
  };
}

async function detectReverb(filePath) {
  // Compare dry/direct sound energy vs late reflections using RT60 approximation
  // We measure correlation between a short segment and its delayed version
  // High correlation at 50-300ms delays = reverb
  const { stderr } = await runCmd('ffmpeg', [
    '-i', filePath, '-t', '30', '-ac', '1',
    '-af', 'volumedetect',
    '-f', 'null', '-',
  ]);
  // Simple heuristic: measure crest factor (peak/rms ratio)
  // Reverby audio has lower crest factor (more sustained energy)
  const { stderr: crestStderr } = await runCmd('ffmpeg', [
    '-i', filePath, '-t', '60', '-ac', '1',
    '-af', 'astats=measure_perchannel=none:measure_overall=all',
    '-f', 'null', '-',
  ]);
  const crestMatch = crestStderr.match(/Crest factor:\s*([\d.]+)/);
  const crest = crestMatch ? parseNumber(crestMatch[1]) : null;

  // Crest factor < 8 = likely reverby, > 15 = dry
  return {
    crestFactor: crest,
    likelyReverb: crest !== null && crest < 10,
    severity: crest !== null ? (crest < 6 ? 'heavy' : crest < 10 ? 'moderate' : 'minimal') : 'unknown',
  };
}

async function detectDynamicRange(filePath) {
  // Measure dynamics only on voice-active segments (gate out silence first)
  // This prevents pauses from inflating the dynamic range measurement
  const { stderr } = await runCmd('ffmpeg', [
    '-i', filePath, '-ac', '1',
    '-af', 'agate=threshold=0.003:ratio=100:attack=1:release=10,astats=measure_perchannel=none:measure_overall=all',
    '-f', 'null', '-',
  ]);

  // Also measure ungated for peak/clipping detection
  const { stderr: rawStderr } = await runCmd('ffmpeg', [
    '-i', filePath, '-ac', '1',
    '-af', 'astats=measure_perchannel=none:measure_overall=all',
    '-f', 'null', '-',
  ]);

  const peakMatch = rawStderr.match(/Peak level dB:\s*([\-\d.]+)/);
  const rmsMatch = rawStderr.match(/RMS level dB:\s*([\-\d.]+)/);

  // Gated measurements (voice-only dynamic range)
  const gatedRmsPeakMatch = stderr.match(/RMS peak dB:\s*([\-\d.]+)/);
  const gatedRmsTroughMatch = stderr.match(/RMS trough dB:\s*([\-\d.]+)/);
  const gatedRmsTroughFallback = stderr.match(/RMS through dB:\s*([\-\d.]+)/); // ffmpeg typo variant

  const peak = peakMatch ? parseNumber(peakMatch[1]) : null;
  const rms = rmsMatch ? parseNumber(rmsMatch[1]) : null;
  const rmsPeak = gatedRmsPeakMatch ? parseNumber(gatedRmsPeakMatch[1]) : null;
  const rmsTrough = gatedRmsTroughMatch
    ? parseNumber(gatedRmsTroughMatch[1])
    : (gatedRmsTroughFallback ? parseNumber(gatedRmsTroughFallback[1]) : null);

  // Voice-only dynamic range (excludes silence gaps)
  const dynamicRange = (rmsPeak !== null && rmsTrough !== null) ? rmsPeak - rmsTrough : null;
  const hasClipping = peak !== null && peak >= -0.5;

  // Also measure LRA from loudnorm for a second opinion
  let lra = null;
  try {
    const { stderr: lnStderr } = await runCmd('ffmpeg', [
      '-i', filePath,
      '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json',
      '-f', 'null', '-',
    ]);
    const lnMatch = lnStderr.match(/"input_lra"\s*:\s*"([\d.]+)"/);
    lra = lnMatch ? parseNumber(lnMatch[1]) : null;
  } catch { /* ignore */ }

  // Use LRA as primary compression guide (more reliable for speech)
  // LRA < 5 = tight, 5-10 = moderate, > 10 = wide
  let compressionLevel;
  if (lra !== null) {
    compressionLevel = lra > 10 ? 'heavy' : lra > 5 ? 'moderate' : 'light';
  } else if (dynamicRange !== null) {
    // Fallback to gated dynamic range (thresholds adjusted for voice-only measurement)
    compressionLevel = dynamicRange > 20 ? 'heavy' : dynamicRange > 12 ? 'moderate' : 'light';
  } else {
    compressionLevel = 'moderate';
  }

  return {
    peakDb: peak,
    rmsDb: rms,
    rmsPeakDb: rmsPeak,
    rmsTroughDb: rmsTrough,
    dynamicRange,
    lra,
    hasClipping,
    needsCompression: compressionLevel !== 'light',
    compressionLevel,
  };
}

// ── Build Recommendations ──

function buildRecommendations(analysis) {
  const rec = {
    steps: [],
    settings: {},
    reasoning: [],
  };

  const { basic, loudness, noise, sibilance, reverb, dynamics } = analysis;

  // 1. Stereo to mono
  if (basic.channels > 1) {
    rec.steps.push('stereo_to_mono');
    rec.settings.stereoToMonoEnabled = true;
    rec.reasoning.push(`Input is ${basic.channels}-channel — converting to mono for voice content`);
  }

  // 2. Denoise decision — based on SNR, not raw noise floor
  const snr = noise.snrDb;
  const noiseLevel = noise.noiseRmsDb;
  if (snr !== null) {
    if (snr < 20) {
      // Poor SNR — heavy noise, needs ML denoise
      rec.steps.push('ml_denoise');
      rec.settings.mode = 'quality';
      rec.settings.denoiseStrength = 'full';
      rec.reasoning.push(`SNR ${snr.toFixed(1)} dB (poor, <20) — full DeepFilterNet AI denoise`);
    } else if (snr < 25) {
      // Moderate SNR — some noise, light ML denoise
      rec.steps.push('ml_denoise');
      rec.settings.mode = 'quality';
      rec.settings.denoiseStrength = 'light';
      rec.reasoning.push(`SNR ${snr.toFixed(1)} dB (moderate) — light DeepFilterNet AI denoise`);
    } else {
      // Good SNR (≥25 dB) — audio is already clean, skip denoise
      // ML denoise on clean audio introduces phase artifacts (hollow/echo sound)
      rec.steps.push('skip_denoise');
      rec.settings.mode = 'clean';
      rec.settings.denoiseStrength = 'none';
      rec.reasoning.push(`SNR ${snr.toFixed(1)} dB (good, ≥25) — audio is clean, skipping denoise to preserve quality`);
    }
  } else if (noiseLevel !== null && noiseLevel < -60) {
    rec.steps.push('skip_denoise');
    rec.settings.mode = 'clean';
    rec.settings.denoiseStrength = 'none';
    rec.reasoning.push(`Noise floor at ${noiseLevel.toFixed(1)} dB (very low) — skipping denoise`);
  } else if (noiseLevel !== null && noiseLevel > -45) {
    rec.steps.push('ml_denoise');
    rec.settings.mode = 'quality';
    rec.settings.denoiseStrength = 'full';
    rec.reasoning.push(`Noise floor at ${noiseLevel.toFixed(1)} dB (high) — using DeepFilterNet AI denoise`);
  } else {
    rec.steps.push('light_denoise');
    rec.settings.mode = 'fast';
    rec.settings.denoiseStrength = 'light';
    rec.reasoning.push('Uncertain noise level — defaulting to light FFmpeg denoise');
  }

  // 3. Noise gate
  if (noise.hasSilenceRegions) {
    rec.steps.push('noise_gate');
    rec.settings.noiseGateEnabled = true;
    rec.reasoning.push('Silence regions detected — applying noise gate for clean pauses');
  } else {
    rec.settings.noiseGateEnabled = false;
    rec.reasoning.push('No clear silence regions — skipping noise gate to avoid artifacts');
  }

  // 4. Silence trim
  rec.steps.push('silence_trim');
  rec.settings.silenceTrimEnabled = true;
  rec.reasoning.push('Trimming leading/trailing silence');

  // 5. HPF frequency
  if (reverb.likelyReverb) {
    rec.settings.hpfFrequency = 100;
    rec.reasoning.push(`Reverb detected (${reverb.severity}) — HPF raised to 100 Hz to reduce boominess`);
  } else {
    rec.settings.hpfFrequency = 80;
    rec.reasoning.push('Minimal reverb — standard HPF at 80 Hz');
  }

  // 6. De-esser
  if (sibilance.hasSibilance) {
    rec.steps.push('de_esser');
    rec.settings.deEsserEnabled = true;
    const gain = sibilance.severity === 'high' ? -4 : -2.5;
    rec.settings.deEsserGain = gain;
    rec.reasoning.push(`Sibilance ${sibilance.severity} (ratio ${sibilance.sibilanceRatio?.toFixed(1)}) — de-esser at ${gain} dB`);
  } else {
    rec.settings.deEsserEnabled = false;
    rec.reasoning.push('Low sibilance — de-esser not needed');
  }

  // 7. Compression — use LRA as primary guide, gentler ratios
  rec.steps.push('compression');
  const lraStr = dynamics.lra != null ? `LRA ${dynamics.lra.toFixed(1)} LU` : null;
  const drStr = dynamics.dynamicRange != null ? `DR ${dynamics.dynamicRange.toFixed(1)} dB` : null;
  const metricsStr = [lraStr, drStr].filter(Boolean).join(', ') || 'unknown';

  if (dynamics.compressionLevel === 'heavy') {
    rec.settings.multiBandCompEnabled = true;
    rec.settings.compressionRatio = 3;
    rec.reasoning.push(`Wide dynamics (${metricsStr}) — moderate multi-band compression`);
  } else if (dynamics.compressionLevel === 'moderate') {
    rec.settings.multiBandCompEnabled = false;
    rec.settings.compressionRatio = 2.5;
    rec.reasoning.push(`Moderate dynamics (${metricsStr}) — gentle single-band compression`);
  } else {
    rec.settings.multiBandCompEnabled = false;
    rec.settings.compressionRatio = 2;
    rec.reasoning.push(`Tight dynamics (${metricsStr}) — light single-band compression`);
  }

  // 8. BodyGen (harmonic exciter + sub-harmonic synthesis)
  // Always enabled — generates new harmonic content via waveshaping for fuller voice
  rec.steps.push('bodygen');
  rec.settings.bodyGenEnabled = true;
  rec.settings.bodyGenMix = 0.12;
  rec.settings.bodyGenSubMix = 0.06;
  rec.reasoning.push('BodyGen enabled — harmonic exciter + sub-harmonic synthesis for voice fullness');

  // 9. Loudness target
  if (loudness) {
    const currentLUFS = loudness.integratedLUFS;
    rec.settings.lufsTarget = -16;
    const delta = -16 - currentLUFS;
    rec.reasoning.push(`Current loudness: ${currentLUFS?.toFixed(1)} LUFS → target -16 LUFS (${delta > 0 ? '+' : ''}${delta.toFixed(1)} dB adjustment)`);
  }

  // 9. Output
  rec.settings.outputFormat = 'wav24';
  rec.settings.sampleRate = basic.sampleRate >= 48000 ? 48000 : 44100;

  return rec;
}

// ── Main Analyze Function ──

async function analyzeAudio(filePath, onStatus) {
  const status = (msg) => { if (onStatus) onStatus(msg); };

  // Each measurement is resilient — failure in one doesn't block the rest
  async function safe(label, fn) {
    status(label);
    try { return await fn(); } catch (err) {
      console.warn(`Analysis step "${label}" failed: ${err.message}`);
      return null;
    }
  }

  const basic = await safe('Getting file info...', () => getBasicInfo(filePath));
  if (!basic) throw new Error('Cannot read file metadata — file may be corrupted or not a valid audio file');

  const loudness  = await safe('Measuring loudness...', () => measureLoudness(filePath));
  const noise     = await safe('Analyzing noise floor...', () => measureNoiseFloor(filePath, basic.channels));
  const sibilance = await safe('Detecting sibilance...', () => detectSibilance(filePath));
  const reverb    = await safe('Checking reverb...', () => detectReverb(filePath));
  const dynamics  = await safe('Analyzing dynamics...', () => detectDynamicRange(filePath));
  // Voice profile is used by adaptive EQ. Always computed (cheap ~150ms FFT)
  // and exposed in `recommendations`; the pipeline only consumes it when
  // settings.adaptiveEqEnabled is true.
  const voiceProfile = await safe('Profiling voice...', () => profileVoice(filePath));

  const analysis = {
    basic,
    loudness:  loudness  ?? { integratedLUFS: null, truePeak: null, lra: null, threshold: null },
    noise:     noise     ?? { noiseFloorDb: null, noiseRmsDb: null, overallRmsDb: null, overallPeakDb: null, dcOffset: null, hasSilenceRegions: false },
    sibilance: sibilance ?? { overallDb: null, sibilanceDb: null, sibilanceRatio: null, hasSibilance: false, severity: 'unknown' },
    reverb:    reverb    ?? { crestFactor: null, likelyReverb: false, severity: 'unknown' },
    dynamics:  dynamics  ?? { peakDb: null, rmsDb: null, rmsPeakDb: null, rmsTroughDb: null, dynamicRange: null, hasClipping: false, needsCompression: true, compressionLevel: 'moderate' },
    voiceProfile: voiceProfile ?? null,
  };
  const recommendations = buildRecommendations(analysis);
  recommendations.voiceProfile = voiceProfile;

  return { analysis, recommendations };
}

module.exports = { analyzeAudio };
