'use strict';

// Renders a single-frame PNG spectrogram for visual QC inspection
// (docs/PLAN.md §4 Fase 8). A time/frequency/amplitude plot of the whole
// file makes several artefact families from the §1.4 catalogue visible
// at a glance without auditioning the whole recording: hum shows as a
// solid horizontal line at 50/60 Hz (+ harmonics), clipping as bright
// smears across the full band at loud transients, and denoise "musical
// noise" as scattered speckle in what should be plain silence.

const { runFfmpeg } = require('./ffmpeg-run');

const DEFAULT_SIZE = '1200x400';
const SPECTROGRAM_TIMEOUT_MS = 3 * 60 * 1000;

async function generateSpectrogram(inputPath, outputPath, opts = {}) {
  const size = opts.size ?? DEFAULT_SIZE;
  const legend = opts.legend === false ? '0' : '1';
  await runFfmpeg([
    '-y',
    '-i', inputPath,
    '-lavfi', `showspectrumpic=s=${size}:legend=${legend}`,
    '-frames:v', '1',
    '-update', '1',
    outputPath,
  ], { ...opts, timeout: opts.timeout ?? SPECTROGRAM_TIMEOUT_MS });
  return outputPath;
}

module.exports = { generateSpectrogram, DEFAULT_SIZE };
