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
  // Find first silence region to measure noise
  const { stderr: silenceStderr } = await runCmd('ffmpeg', [
    '-i', filePath,
    '-af', 'silencedetect=noise=-40dB:d=0.3',
    '-f', 'null', '-',
  ]);

  // Parse first silence start
  const silenceMatch = silenceStderr.match(/silence_start:\s*([\d.]+)/);
  const silenceStart = silenceMatch ? parseFloat(silenceMatch[1]) : null;

  let noiseFloorDb = null;
  let noiseRmsDb = null;

  if (silenceStart !== null) {
    // Extract silence section and measure
    const tmpFile = path.join(os.tmpdir(), `audiopro_analyze_${crypto.randomBytes(6).toString('hex')}.wav`);
    try {
      await runCmd('ffmpeg', [
        '-y', '-i', filePath,
        '-ss', String(silenceStart), '-t', '0.5',
        '-ac', '1', tmpFile,
      ]);
      const { stderr: statsStderr } = await runCmd('ffmpeg', [
        '-i', tmpFile,
        '-af', 'astats=measure_perchannel=none:measure_overall=all',
        '-f', 'null', '-',
      ]);
      const nfMatch = statsStderr.match(/Noise floor dB:\s*([\-\d.inf]+)/);
      const rmsMatch = statsStderr.match(/RMS level dB:\s*([\-\d.]+)/);
      noiseFloorDb = nfMatch ? (nfMatch[1] === '-inf' ? -Infinity : parseNumber(nfMatch[1])) : null;
      noiseRmsDb = rmsMatch ? parseNumber(rmsMatch[1]) : null;
    } catch { /* ignore */ }
    finally {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    }
  }

  // Also measure overall stats to detect noise in voice sections
  const { stderr: overallStderr } = await runCmd('ffmpeg', [
    '-i', filePath, '-t', '60', '-ac', '1',
    '-af', 'astats=measure_perchannel=none:measure_overall=all',
    '-f', 'null', '-',
  ]);
  const overallRms = overallStderr.match(/RMS level dB:\s*([\-\d.]+)/);
  const overallPeak = overallStderr.match(/Peak level dB:\s*([\-\d.]+)/);
  const dcOffset = overallStderr.match(/DC offset:\s*([\-\d.e]+)/);

  return {
    noiseFloorDb,
    noiseRmsDb,
    overallRmsDb: overallRms ? parseNumber(overallRms[1]) : null,
    overallPeakDb: overallPeak ? parseNumber(overallPeak[1]) : null,
    dcOffset: dcOffset ? parseNumber(dcOffset[1]) : null,
    hasSilenceRegions: silenceStart !== null,
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
  // Analyze volume distribution
  const { stderr } = await runCmd('ffmpeg', [
    '-i', filePath, '-ac', '1',
    '-af', 'astats=measure_perchannel=none:measure_overall=all',
    '-f', 'null', '-',
  ]);
  const peakMatch = stderr.match(/Peak level dB:\s*([\-\d.]+)/);
  const rmsMatch = stderr.match(/RMS level dB:\s*([\-\d.]+)/);
  const rmsPeakMatch = stderr.match(/RMS peak dB:\s*([\-\d.]+)/);
  // FFmpeg's astats reports "RMS trough dB" (the typo "through" was a bug;
  // before this fix, rmsTrough was always null and dynamicRange was unusable).
  const rmsTroughMatch = stderr.match(/RMS trough dB:\s*([\-\d.]+)/);

  const peak = peakMatch ? parseNumber(peakMatch[1]) : null;
  const rms = rmsMatch ? parseNumber(rmsMatch[1]) : null;
  const rmsPeak = rmsPeakMatch ? parseNumber(rmsPeakMatch[1]) : null;
  const rmsTrough = rmsTroughMatch ? parseNumber(rmsTroughMatch[1]) : null;

  const dynamicRange = (rmsPeak !== null && rmsTrough !== null) ? rmsPeak - rmsTrough : null;
  const hasClipping = peak !== null && peak >= -0.5;

  return {
    peakDb: peak,
    rmsDb: rms,
    rmsPeakDb: rmsPeak,
    rmsTroughDb: rmsTrough,
    dynamicRange,
    hasClipping,
    needsCompression: dynamicRange !== null && dynamicRange > 20,
    compressionLevel: dynamicRange !== null
      ? (dynamicRange > 30 ? 'heavy' : dynamicRange > 20 ? 'moderate' : 'light')
      : 'moderate',
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

  // 2. Denoise decision
  const noiseLevel = noise.noiseRmsDb;
  if (noiseLevel !== null && noiseLevel > -55) {
    rec.steps.push('ml_denoise');
    rec.settings.mode = 'quality';
    rec.reasoning.push(`Noise floor at ${noiseLevel.toFixed(1)} dB (above -55 threshold) — using DeepFilterNet AI denoise`);
  } else if (noiseLevel !== null) {
    rec.steps.push('light_denoise');
    rec.settings.mode = 'fast';
    rec.reasoning.push(`Noise floor at ${noiseLevel.toFixed(1)} dB (below -55) — light FFmpeg denoise sufficient`);
  } else {
    rec.steps.push('ml_denoise');
    rec.settings.mode = 'quality';
    rec.reasoning.push('Could not measure noise floor — defaulting to AI denoise for safety');
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

  // 5. HPF frequency — reverb-aware AND voice-aware.
  // Voice profile (when available) gives us a per-speaker HPF that follows
  // the actual fundamental; reverb still escalates the cutoff a bit.
  const voiceHpf = analysis.voice?.hpfHz;
  if (reverb.likelyReverb) {
    // Raise by ~20 Hz over the voice baseline (or default to 100 Hz).
    rec.settings.hpfFrequency = voiceHpf ? Math.min(120, voiceHpf + 20) : 100;
    rec.reasoning.push(`Reverb detected (${reverb.severity}) — HPF set to ${rec.settings.hpfFrequency} Hz to reduce boominess`);
  } else if (voiceHpf) {
    rec.settings.hpfFrequency = voiceHpf;
    rec.reasoning.push(`Voice profile: ${analysis.voice.voiceClass} (f0≈${analysis.voice.pitchHz} Hz) — HPF tuned to ${voiceHpf} Hz`);
  } else {
    rec.settings.hpfFrequency = 80;
    rec.reasoning.push('Minimal reverb — standard HPF at 80 Hz');
  }

  // 5b. Dynamic notches from voice profile.
  if (analysis.voice) {
    rec.settings.dynamicNotches = analysis.voice.notches; // [{freq,q,prominenceDb}]
    if (analysis.voice.notches?.length) {
      const summary = analysis.voice.notches
        .map(n => {
          const cut = Number.isFinite(n.fixedCutDb) ? `−${n.fixedCutDb} dB` : `+${n.prominenceDb} dB`;
          return `${n.freq} Hz (Q≈${n.q}, ${cut})`;
        })
        .join(', ');
      rec.reasoning.push(`Resonant peaks detected — dynamic notches at: ${summary}`);
    } else {
      rec.reasoning.push('No resonant peaks detected in 80–900 Hz — skipping dynamic notches');
    }
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

  // 7. Compression
  rec.steps.push('compression');
  if (dynamics.compressionLevel === 'heavy') {
    rec.settings.multiBandCompEnabled = true;
    rec.settings.compressionRatio = 5;
    const drStr = dynamics.dynamicRange != null ? `${dynamics.dynamicRange.toFixed(1)} dB` : 'wide';
    rec.reasoning.push(`Wide dynamic range (${drStr}) — heavy multi-band compression`);
  } else if (dynamics.compressionLevel === 'moderate') {
    rec.settings.multiBandCompEnabled = true;
    rec.settings.compressionRatio = 3.5;
    const drStr = dynamics.dynamicRange != null ? `${dynamics.dynamicRange.toFixed(1)} dB` : 'moderate';
    rec.reasoning.push(`Moderate dynamic range (${drStr}) — standard multi-band compression`);
  } else {
    rec.settings.multiBandCompEnabled = false;
    const drStr = dynamics.dynamicRange != null ? `${dynamics.dynamicRange.toFixed(1)} dB` : 'tight';
    rec.reasoning.push(`Tight dynamic range (${drStr}) — single-band compression sufficient`);
  }

  // 8b. Speech Regeneration (Resemble Enhance) recommendation
  // Off by default; only suggest it when the audio is clearly degraded so we
  // don't waste 30s+ on already-clean recordings. The user can always force it
  // via settings.
  const noisyEnough  = noise.noiseRmsDb !== null && noise.noiseRmsDb > -50;
  const reverby      = reverb.likelyReverb && reverb.severity !== 'minimal';
  const wideDynamics = dynamics.dynamicRange !== null && dynamics.dynamicRange > 28;
  const veryQuiet    = loudness && loudness.integratedLUFS !== null && loudness.integratedLUFS < -28;
  const heavyArtifacts = noisyEnough && reverby;

  if (heavyArtifacts || (reverby && wideDynamics) || veryQuiet) {
    rec.steps.push('speech_regeneration');
    rec.settings.enhanceEnabled = true;
    // Pick a preset based on how degraded the audio is. Maps onto the 3
    // user-facing levels (Suave / Medio / Fuerte) so the auto-mode is
    // consistent with what the user sees in the dropdown. Previous strings
    // ('aggressive', 'broadcast') no longer exist in enhance.py and would
    // have caused the regen step to fail silently.
    if (heavyArtifacts) {
      rec.settings.enhancePreset = 'strong';
      rec.reasoning.push('Audio is noisy AND reverby — Resemble Enhance: Fuerte (strong regeneration)');
    } else if (reverby) {
      rec.settings.enhancePreset = 'light';
      rec.reasoning.push(`Reverb ${reverb.severity} detected — Resemble Enhance: Medio (light)`);
    } else {
      rec.settings.enhancePreset = 'ultra_subtle';
      rec.reasoning.push('Voice level very low / unclear — Resemble Enhance: Suave (ultra_subtle, preserve voice)');
    }
  } else {
    rec.settings.enhanceEnabled = false;
    rec.reasoning.push('Audio is clean enough — skipping speech regeneration (saves ~30-60s/min)');
  }

  // 9. Loudness target
  if (loudness) {
    const currentLUFS = loudness.integratedLUFS;
    rec.settings.lufsTarget = -16;
    const delta = -16 - currentLUFS;
    rec.reasoning.push(`Current loudness: ${currentLUFS?.toFixed(1)} LUFS → target -16 LUFS (${delta > 0 ? '+' : ''}${delta.toFixed(1)} dB adjustment)`);
  }

  // 10. Output
  rec.settings.outputFormat = 'wav24';
  rec.settings.sampleRate = basic.sampleRate >= 48000 ? 48000 : 44100;

  // ── Clean source mode ──
  // When the source has a low noise floor (≤ −55 dB — the same boundary
  // that already separates "noisy → DFN" from "clean → afftdn") AND its
  // dynamic range isn't extreme, treat it as production-grade material
  // that doesn't need the heavy pipeline. We bypass denoise (DFN AND
  // afftdn), EQ cuts, multi-band compression and single-band compression,
  // keeping only loudness normalisation and the limiter. We stay at
  // 24-bit throughout the pipeline (the 16-bit intermediate format only
  // exists for DeepFilterNet, which we skip).
  const noiseFloorDb = noise.noiseRmsDb;
  const isCleanSource =
    noiseFloorDb !== null && noiseFloorDb <= -55 &&
    dynamics.compressionLevel !== 'heavy';
  if (isCleanSource) {
    rec.settings.cleanSourceMode    = true;
    rec.settings.aiDenoiseEnabled   = false;
    rec.settings.multiBandCompEnabled = false;
    rec.settings.deEsserEnabled     = false;
    rec.settings.skipStaticEqCuts   = true;
    rec.reasoning.push(
      `Clean source detected (noise floor ${noiseFloorDb.toFixed(1)} dB, ` +
      `${dynamics.compressionLevel} dynamics) — minimal pipeline: loudnorm + limiter only, 24-bit throughout`
    );
  }

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
  const voice     = await safe('Profiling voice spectrum...', () => profileVoice(filePath));

  const analysis = {
    basic,
    loudness:  loudness  ?? { integratedLUFS: null, truePeak: null, lra: null, threshold: null },
    noise:     noise     ?? { noiseFloorDb: null, noiseRmsDb: null, overallRmsDb: null, overallPeakDb: null, dcOffset: null, hasSilenceRegions: false },
    sibilance: sibilance ?? { overallDb: null, sibilanceDb: null, sibilanceRatio: null, hasSibilance: false, severity: 'unknown' },
    reverb:    reverb    ?? { crestFactor: null, likelyReverb: false, severity: 'unknown' },
    dynamics:  dynamics  ?? { peakDb: null, rmsDb: null, rmsPeakDb: null, rmsTroughDb: null, dynamicRange: null, hasClipping: false, needsCompression: true, compressionLevel: 'moderate' },
    voice:     voice     ?? null,
  };
  const recommendations = buildRecommendations(analysis);

  return { analysis, recommendations };
}

module.exports = { analyzeAudio };
