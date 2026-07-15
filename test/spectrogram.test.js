'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { generateSpectrogram, DEFAULT_SIZE } = require('../src/spectrogram');
const { runFfprobe } = require('../src/ffmpeg-run');
const fx = require('./fixtures');

let workDir, sourcePath;

before(async () => {
  workDir = fx.tmpDir('spectrogram');
  sourcePath = await fx.buildTone(path.join(workDir, 'source.wav'), { duration: 2, frequency: 440 });
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

async function probeImage(p) {
  const out = await runFfprobe(['-v', 'quiet', '-print_format', 'json', '-show_streams', p]);
  return JSON.parse(out).streams[0];
}

test('generateSpectrogram: writes a valid PNG sized to the requested resolution (legend off)', async () => {
  const outPath = path.join(workDir, 'spec-no-legend.png');
  await generateSpectrogram(sourcePath, outPath, { size: '640x240', legend: false });
  assert.ok(fs.existsSync(outPath));
  const stream = await probeImage(outPath);
  assert.equal(stream.codec_name, 'png');
  assert.equal(stream.width, 640);
  assert.equal(stream.height, 240);
});

test('generateSpectrogram: default size produces a PNG at least as large as requested (legend adds margin)', async () => {
  const outPath = path.join(workDir, 'spec-default.png');
  await generateSpectrogram(sourcePath, outPath);
  assert.ok(fs.existsSync(outPath));
  const stream = await probeImage(outPath);
  const [defW, defH] = DEFAULT_SIZE.split('x').map(Number);
  assert.ok(stream.width >= defW, `width ${stream.width} should be >= ${defW}`);
  assert.ok(stream.height >= defH, `height ${stream.height} should be >= ${defH}`);
});

test('generateSpectrogram: rejects when the source file does not exist', async () => {
  const outPath = path.join(workDir, 'spec-missing.png');
  await assert.rejects(() => generateSpectrogram(path.join(workDir, 'does-not-exist.wav'), outPath));
});
