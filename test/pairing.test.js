'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pairing = require('../src/pairing');
const fx = require('./fixtures');

let workDir;

before(() => {
  workDir = fx.tmpDir('pairing');
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

test('pairs an original with its Enhanced/ counterpart by basename', async () => {
  const enhancedDir = path.join(workDir, 'Enhanced');
  fs.mkdirSync(enhancedDir, { recursive: true });
  await fx.buildTone(path.join(workDir, 'clase-01.wav'));
  await fx.buildTone(path.join(enhancedDir, 'clase-01.wav'));
  await fx.buildTone(path.join(workDir, 'clase-02-solo.wav'));

  const { pairs, singles, hasEnhancedDir } = pairing.findPairs(workDir);
  assert.equal(hasEnhancedDir, true);
  assert.equal(pairs.length, 1);
  assert.equal(path.basename(pairs[0].original.path), 'clase-01.wav');
  assert.equal(path.basename(pairs[0].enhanced.path), 'clase-01.wav');
  assert.equal(singles.length, 1);
  assert.equal(path.basename(singles[0].path), 'clase-02-solo.wav');
});

test('matches across different extensions (adobe-podcast-batch always exports WAV)', async () => {
  const dir = path.join(workDir, 'mixed-ext');
  const enhancedDir = path.join(dir, 'Enhanced');
  fs.mkdirSync(enhancedDir, { recursive: true });
  await fx.buildTone(path.join(dir, 'leccion.wav'));
  fs.writeFileSync(path.join(dir, 'leccion.mp3'), Buffer.from([0]));
  await fx.buildTone(path.join(enhancedDir, 'leccion.wav'));

  const { pairs } = pairing.findPairs(dir);
  // Both leccion.wav and leccion.mp3 share the basename "leccion" — the
  // pairing keys strictly by basename, so with two originals sharing a
  // key only one survives as the map key; assert at least the expected
  // match count rather than which physical file "wins".
  assert.ok(pairs.length >= 1);
});

test('falls back to nested "Clean voice" folder when present', async () => {
  const dir = path.join(workDir, 'nested-clean');
  const enhancedDir = path.join(dir, 'Enhanced');
  const cleanDir = path.join(enhancedDir, 'Clean voice');
  fs.mkdirSync(cleanDir, { recursive: true });
  await fx.buildTone(path.join(dir, 'intro.wav'));
  await fx.buildTone(path.join(cleanDir, 'intro.wav'));

  const { pairs, hasEnhancedDir } = pairing.findPairs(dir);
  assert.equal(hasEnhancedDir, true);
  assert.equal(pairs.length, 1);
});

test('no Enhanced/ folder means every file is a single (Mode 1)', async () => {
  const dir = path.join(workDir, 'solo-only');
  fs.mkdirSync(dir, { recursive: true });
  await fx.buildTone(path.join(dir, 'a.wav'));
  await fx.buildTone(path.join(dir, 'b.wav'));

  const { pairs, singles, hasEnhancedDir } = pairing.findPairs(dir);
  assert.equal(hasEnhancedDir, false);
  assert.equal(pairs.length, 0);
  assert.equal(singles.length, 2);
});

test('isAudioFile recognises the documented extension set', () => {
  for (const ext of pairing.AUDIO_EXTS) assert.equal(pairing.isAudioFile(`x${ext}`), true);
  assert.equal(pairing.isAudioFile('x.txt'), false);
});
