'use strict';

// ── Voice profiling ──
//
// Spectral analysis to drive an adaptive EQ. We do TWO things here:
//
//  1. Pitch profile — estimate the dominant fundamental of the speaker.
//     Used to decide HPF cutoff and to nudge the body-boost frequency
//     toward the actual chest-resonance of the speaker (typically 2x f0
//     for males, ~250-350 Hz for females, ~120-180 Hz for males).
//
//  2. Resonant peak detection — averaged FFT magnitude across the file.
//     We look for the loudest 2-3 narrow peaks in the "mud / boxiness"
//     window (180-900 Hz) that exceed a local-median floor by enough to
//     be perceived as honky/boxy resonances. These get notched dynamically
//     in the EQ chain.
//
// Implementation: ffmpeg's astats + a small DFT done on a downsampled,
// mono-mixed slice of the file. We avoid heavy native deps and stay
// self-contained.

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const binPaths = require('./bin-paths');

// Frequency window where speech "mud / boxiness / honk" resonances live.
// Outside this window we don't notch (highs are handled by the de-esser,
// lows by the HPF). 180 Hz lower bound also keeps us above f0 for most
// voices so we never cut into the fundamental itself.
const MUD_LO_HZ = 180;
const MUD_HI_HZ = 900;

// Adobe Podcast / similar AI enhancers tend to inject a broad warmth
// boost in the 100–400 Hz region. Material that has already been through
// those tools arrives with a bumpy low-mid spectrum that needs surgical
// attenuation. We scan this band separately with a more aggressive
// detector (lower prominence threshold, higher Q for narrower notches)
// and treat the result as a SECOND set of notches in addition to the
// regular mud detection.
const LOWMID_LO_HZ = 100;
const LOWMID_HI_HZ = 400;
const LOWMID_PROMINENCE_DB = 3.0;   // more sensitive than the mud band
const LOWMID_MAX_NOTCHES   = 2;
const LOWMID_Q_FALLBACK    = 10;    // narrower than mud (≈high-Q surgical cut)
const LOWMID_MIN_SPACING   = 1.20;  // ratio between adjacent notches

// FFT analysis parameters.
const ANALYSIS_SR     = 8000;   // resample target — speech mud lives < 4 kHz
const FFT_SIZE        = 4096;   // ~0.5 s window @ 8 kHz, ~2 Hz bin resolution
const HOP_SIZE        = 2048;
const MAX_SECONDS     = 60;     // cap analysis at 60 s (full file would be too slow)
const MIN_RMS_FRAME   = 0.005;  // skip silent frames so silence doesn't bias the spectrum

// Notch detection thresholds.
// A peak counts as "resonant / molesta" when it sits this many dB above
// the local median magnitude in its 1/3-octave neighborhood.
const PEAK_PROMINENCE_DB = 4.5;
// Don't pick more than this many notches — the EQ chain stays sane and
// FFmpeg filtergraphs stay short.
const MAX_NOTCHES        = 3;
// Notches that fall closer than this in log-frequency are merged.
const MIN_NOTCH_SPACING  = 1.25; // ratio (must be > 1)

// Pitch-detection bounds. Real speech fundamentals typically sit between
// ~80 Hz (deep male) and ~300 Hz (children / high female). We clamp here
// to keep autocorrelation-based pitch estimates robust against hum / noise.
const PITCH_LO_HZ = 70;
const PITCH_HI_HZ = 320;


/**
 * Decode a slice of `filePath` to a mono Float32Array @ ANALYSIS_SR Hz.
 * Returns null on any failure.
 */
function decodeMono(filePath) {
  return new Promise(resolve => {
    const proc = spawn(binPaths.ffmpeg(), [
      '-v', 'error',
      '-i', filePath,
      '-t', String(MAX_SECONDS),
      '-ac', '1',
      '-ar', String(ANALYSIS_SR),
      '-f', 'f32le',
      'pipe:1',
    ]);
    const chunks = [];
    let stderr = '';
    proc.stdout.on('data', c => chunks.push(c));
    proc.stderr.on('data', c => { stderr += c.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', code => {
      if (code !== 0) return resolve(null);
      const buf = Buffer.concat(chunks);
      const count = Math.floor(buf.length / 4);
      if (count < FFT_SIZE) return resolve(null);
      // Copy to a new Float32Array so we own aligned memory
      const out = new Float32Array(count);
      const view = new Float32Array(buf.buffer, buf.byteOffset, count);
      out.set(view);
      resolve(out);
    });
  });
}

/**
 * Iterative radix-2 Cooley-Tukey FFT, in-place on real/imag arrays.
 * `n` must be a power of 2.
 */
function fftInPlace(re, im) {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = -2 * Math.PI / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < half; k++) {
        const aRe = re[i + k];
        const aIm = im[i + k];
        const bRe = re[i + k + half] * curRe - im[i + k + half] * curIm;
        const bIm = re[i + k + half] * curIm + im[i + k + half] * curRe;
        re[i + k]        = aRe + bRe;
        im[i + k]        = aIm + bIm;
        re[i + k + half] = aRe - bRe;
        im[i + k + half] = aIm - bIm;
        const nRe = curRe * wRe - curIm * wIm;
        const nIm = curRe * wIm + curIm * wRe;
        curRe = nRe;
        curIm = nIm;
      }
    }
  }
}

/**
 * Compute the average magnitude spectrum (across non-silent frames) for the
 * given mono PCM data, with a Hann window. Returns Float32Array of length
 * FFT_SIZE/2 with linear magnitudes.
 */
function averageSpectrum(pcm) {
  const n = FFT_SIZE;
  const half = n >> 1;
  const window = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    window[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  }
  const sum = new Float32Array(half);
  let frames = 0;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let off = 0; off + n <= pcm.length; off += HOP_SIZE) {
    // Compute frame RMS to skip silent frames
    let r = 0;
    for (let i = 0; i < n; i++) r += pcm[off + i] * pcm[off + i];
    const rms = Math.sqrt(r / n);
    if (rms < MIN_RMS_FRAME) continue;
    // Window + load
    for (let i = 0; i < n; i++) {
      re[i] = pcm[off + i] * window[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    for (let k = 0; k < half; k++) {
      sum[k] += Math.sqrt(re[k] * re[k] + im[k] * im[k]);
    }
    frames++;
  }
  if (frames === 0) return null;
  for (let k = 0; k < half; k++) sum[k] /= frames;
  return sum;
}

/**
 * Estimate the dominant pitch (fundamental, in Hz) from the magnitude
 * spectrum, by searching for the strongest bin within [PITCH_LO_HZ,
 * PITCH_HI_HZ]. This is not a true pitch tracker (no autocorrelation)
 * but for a long average it lands within ±10-15 Hz of f0 in practice,
 * which is good enough for adaptive EQ decisions.
 */
function estimatePitch(spectrum, sampleRate) {
  const half = spectrum.length;
  const binHz = sampleRate / (half * 2); // = sr / FFT_SIZE
  const loBin = Math.max(1, Math.floor(PITCH_LO_HZ / binHz));
  const hiBin = Math.min(half - 1, Math.ceil(PITCH_HI_HZ / binHz));
  if (hiBin <= loBin) return null;
  let bestBin = loBin, bestVal = -Infinity;
  for (let k = loBin; k <= hiBin; k++) {
    if (spectrum[k] > bestVal) { bestVal = spectrum[k]; bestBin = k; }
  }
  // Parabolic interpolation around the peak for sub-bin accuracy
  if (bestBin > 0 && bestBin < half - 1) {
    const a = Math.log(Math.max(1e-12, spectrum[bestBin - 1]));
    const b = Math.log(Math.max(1e-12, spectrum[bestBin]));
    const c = Math.log(Math.max(1e-12, spectrum[bestBin + 1]));
    const denom = (a - 2 * b + c);
    const offset = denom !== 0 ? 0.5 * (a - c) / denom : 0;
    return (bestBin + offset) * binHz;
  }
  return bestBin * binHz;
}

/**
 * Detect up to `maxNotches` resonant peaks within [loHz, hiHz] by
 * comparing each bin to the median magnitude of its 1/3-octave
 * neighborhood. Peaks are returned sorted ascending by frequency.
 *
 * `opts` (all optional) lets the caller tune sensitivity for different
 * frequency ranges:
 *   prominenceDb: minimum dB above local median to count as a peak
 *   maxNotches:   max picks returned
 *   minSpacing:   adjacent notches must differ by at least this freq ratio
 *   qFallback:    Q used when 3-dB-down width can't be measured
 *   maxQ:         clamp on Q (lower => softer notch)
 *
 * Each returned peak: { freq, q, prominenceDb }.
 */
function findResonantPeaks(spectrum, sampleRate, loHz, hiHz, opts = {}) {
  const prominenceDb = opts.prominenceDb ?? PEAK_PROMINENCE_DB;
  const maxNotches   = opts.maxNotches   ?? MAX_NOTCHES;
  const minSpacing   = opts.minSpacing   ?? MIN_NOTCH_SPACING;
  const qFallback    = opts.qFallback    ?? 8;
  const maxQ         = opts.maxQ         ?? 20;
  const half = spectrum.length;
  const binHz = sampleRate / (half * 2);
  const loBin = Math.max(1, Math.floor(loHz / binHz));
  const hiBin = Math.min(half - 1, Math.ceil(hiHz / binHz));
  if (hiBin <= loBin + 4) return [];

  // Convert to dB once
  const db = new Float32Array(hiBin - loBin + 1);
  for (let i = 0; i < db.length; i++) {
    const m = spectrum[loBin + i];
    db[i] = 20 * Math.log10(Math.max(1e-12, m));
  }

  // Local-median floor over 1/3 octave (factor 2^(1/3) ≈ 1.26).
  // For each bin, we estimate the floor from a window of bins spanning
  // [f / 2^(1/6), f * 2^(1/6)] (i.e. roughly half a 1/3-octave each side).
  const floorDb = new Float32Array(db.length);
  const sixth = Math.pow(2, 1 / 6);
  const tmp = [];
  for (let i = 0; i < db.length; i++) {
    const f = (loBin + i) * binHz;
    const lo = Math.max(loBin, Math.floor((f / sixth) / binHz));
    const hi = Math.min(hiBin, Math.ceil((f * sixth) / binHz));
    tmp.length = 0;
    for (let k = lo; k <= hi; k++) tmp.push(db[k - loBin]);
    tmp.sort((a, b) => a - b);
    floorDb[i] = tmp[Math.floor(tmp.length / 2)];
  }

  // Pick local maxima that exceed the floor by PEAK_PROMINENCE_DB.
  const candidates = [];
  for (let i = 1; i < db.length - 1; i++) {
    if (db[i] <= db[i - 1] || db[i] <= db[i + 1]) continue; // not a local max
    const prominence = db[i] - floorDb[i];
    if (prominence < prominenceDb) continue;
    const f = (loBin + i) * binHz;
    candidates.push({ freq: f, prominenceDb: prominence, idx: i });
  }
  // Sort loudest-first
  candidates.sort((a, b) => b.prominenceDb - a.prominenceDb);

  // Greedy de-duplication: drop candidates that fall within `minSpacing`
  // of an already-picked stronger one.
  const picked = [];
  for (const c of candidates) {
    if (picked.length >= maxNotches) break;
    const tooClose = picked.some(p => {
      const ratio = Math.max(p.freq, c.freq) / Math.min(p.freq, c.freq);
      return ratio < minSpacing;
    });
    if (tooClose) continue;
    // Q approximated from local 3-dB-down width; fall back to qFallback
    // when we can't measure the width. Higher Q = surgical (narrower) notch.
    let qApprox = qFallback;
    const target = db[c.idx] - 3;
    let lWidth = 0, rWidth = 0;
    for (let k = c.idx - 1; k >= 0; k--) {
      if (db[k] <= target) { lWidth = c.idx - k; break; }
    }
    for (let k = c.idx + 1; k < db.length; k++) {
      if (db[k] <= target) { rWidth = k - c.idx; break; }
    }
    const totalBins = lWidth + rWidth;
    if (totalBins > 0) {
      const widthHz = totalBins * binHz;
      qApprox = Math.min(maxQ, Math.max(4, c.freq / widthHz));
    }
    picked.push({
      freq: Math.round(c.freq),
      q: Math.round(qApprox * 10) / 10,
      prominenceDb: Math.round(c.prominenceDb * 10) / 10,
    });
  }
  // Final sort by ascending frequency for nicer logs/filters
  picked.sort((a, b) => a.freq - b.freq);
  return picked;
}

/**
 * Public API. Profiles the voice in `filePath` and returns:
 *   { pitchHz, voiceClass, bodyBoostHz, hpfHz, notches: [...] }
 *
 * Returns null if profiling failed (caller should fall back to defaults).
 */
async function profileVoice(filePath) {
  const pcm = await decodeMono(filePath);
  if (!pcm) return null;
  const spectrum = averageSpectrum(pcm);
  if (!spectrum) return null;

  const pitch = estimatePitch(spectrum, ANALYSIS_SR);

  // Two passes:
  //   1. Mud / boxiness band (180–900 Hz) — broader, stricter prominence.
  //   2. Low-mid warmth band (100–400 Hz) — surgical, narrower Q. This
  //      catches the broad warmth bump that Adobe Podcast Enhance and
  //      similar AI tools commonly leave behind. Higher sensitivity
  //      (lower prominence threshold) and a tighter Q so we attenuate
  //      the bump without smearing the rest of the low-mid range.
  const mudPeaks = findResonantPeaks(spectrum, ANALYSIS_SR, MUD_LO_HZ, MUD_HI_HZ, {
    prominenceDb: PEAK_PROMINENCE_DB,
    maxNotches:   MAX_NOTCHES,
    minSpacing:   MIN_NOTCH_SPACING,
    qFallback:    8,
    maxQ:         20,
  });
  const lowMidPeaks = findResonantPeaks(spectrum, ANALYSIS_SR, LOWMID_LO_HZ, LOWMID_HI_HZ, {
    prominenceDb: LOWMID_PROMINENCE_DB,
    maxNotches:   LOWMID_MAX_NOTCHES,
    minSpacing:   LOWMID_MIN_SPACING,
    qFallback:    LOWMID_Q_FALLBACK,
    maxQ:         16,
  });

  // Merge both lists. If a low-mid peak overlaps with a mud peak (within
  // a 1.15 ratio band), keep only the higher-prominence one so we don't
  // double-notch the same frequency.
  const merged = [...mudPeaks];
  for (const lm of lowMidPeaks) {
    const overlap = merged.findIndex(m => {
      const r = Math.max(m.freq, lm.freq) / Math.min(m.freq, lm.freq);
      return r < 1.15;
    });
    if (overlap === -1) {
      merged.push(lm);
    } else if (lm.prominenceDb > merged[overlap].prominenceDb) {
      merged[overlap] = lm;
    }
  }
  merged.sort((a, b) => a.freq - b.freq);
  const peaks = merged;

  // Classify the voice from f0 — used for log-friendly labels.
  let voiceClass = 'unknown';
  let bodyBoostHz = 800;
  let hpfHz = 80;
  if (pitch != null) {
    if (pitch < 110)      { voiceClass = 'deep_male';   bodyBoostHz = 600;  hpfHz = 60; }
    else if (pitch < 150) { voiceClass = 'male';        bodyBoostHz = 700;  hpfHz = 70; }
    else if (pitch < 190) { voiceClass = 'high_male';   bodyBoostHz = 800;  hpfHz = 80; }
    else if (pitch < 230) { voiceClass = 'low_female';  bodyBoostHz = 900;  hpfHz = 85; }
    else                  { voiceClass = 'female';      bodyBoostHz = 1000; hpfHz = 90; }
  }

  // Avoid placing the body boost on top of a detected resonance — that
  // would just amplify the very thing we're notching out. Nudge it up
  // by 1/3 octave if a notch sits within 30% of the boost frequency.
  const sixth = Math.pow(2, 1 / 6);
  for (const n of peaks) {
    if (Math.abs(Math.log2(n.freq / bodyBoostHz)) < 1 / 3) {
      bodyBoostHz = Math.round(bodyBoostHz * sixth);
      break;
    }
  }

  return {
    pitchHz: pitch != null ? Math.round(pitch) : null,
    voiceClass,
    bodyBoostHz,
    hpfHz,
    notches: peaks, // [{freq, q, prominenceDb}, ...]
  };
}

module.exports = { profileVoice };
