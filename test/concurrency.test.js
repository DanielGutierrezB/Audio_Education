'use strict';

// The queue used to render strictly one file at a time, which left most of the
// machine idle on a 15-40 class course. These tests cover the pool: that it
// actually overlaps work, that cancellation still stops the batch promptly,
// and that the bookkeeping every file row depends on stays correct when
// several files finish out of order.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const pipeline = require('../src/pipeline');
const fx = require('./fixtures');

let workDir;
const sources = [];

before(async () => {
  workDir = fx.tmpDir('concurrency');
  for (let i = 0; i < 4; i++) {
    sources.push(await fx.buildTone(path.join(workDir, `c${i}.wav`), { duration: 2, frequency: 180 + i * 20 }));
  }
});

after(() => {
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

function runOpts(extra = {}) {
  return {
    isCancelled: () => false,
    setCurrent: () => {},
    ...extra,
  };
}

test('defaultConcurrency stays within bounds on any core count', () => {
  const n = pipeline.defaultConcurrency();
  assert.ok(Number.isInteger(n));
  assert.ok(n >= 1, 'must always run at least one file');
  assert.ok(n <= pipeline.MAX_CONCURRENCY,
    `${n} exceeds the ${pipeline.MAX_CONCURRENCY} cap — concurrent ffmpeg processes trade wall-clock for contention`);
});

test('files really do overlap when concurrency is above one', async () => {
  const outDir = path.join(workDir, 'overlap-out');
  const events = [];
  const emit = (type, data) => events.push({ type, ...data });

  await pipeline.processQueue(sources.map(p => ({ path: p })), {
    emit, ...runOpts(),
    settings: { customOutputDir: outDir, concurrency: 2 },
  });

  // Walk the start/done order: with a pool of 2 a second file must start
  // before the first finishes, otherwise this is still a serial queue.
  let open = 0;
  let sawOverlap = false;
  for (const e of events) {
    if (e.type === 'file:start') { open++; if (open > 1) sawOverlap = true; }
    if (e.type === 'file:done' || e.type === 'file:error') open--;
  }
  assert.ok(sawOverlap, 'no two files were ever in flight at once');

  const doneCount = events.filter(e => e.type === 'file:done').length;
  assert.equal(doneCount, sources.length, 'every file must still finish');
});

test('batch:done reports every file exactly once, however they interleave', async () => {
  const outDir = path.join(workDir, 'count-out');
  const events = [];
  const emit = (type, data) => events.push({ type, ...data });

  await pipeline.processQueue(sources.map(p => ({ path: p })), {
    emit, ...runOpts(),
    settings: { customOutputDir: outDir, concurrency: 3 },
  });

  const batch = events.filter(e => e.type === 'batch:done');
  assert.equal(batch.length, 1, 'exactly one batch:done');
  assert.equal(batch[0].total, sources.length);
  assert.equal(batch[0].done, sources.length);

  const started = events.filter(e => e.type === 'file:start').map(e => e.file);
  assert.equal(new Set(started).size, sources.length, 'no file started twice');
});

test('a single-file batch is never given more workers than files', async () => {
  const outDir = path.join(workDir, 'single-out');
  const events = [];
  const emit = (type, data) => events.push({ type, ...data });

  await pipeline.processQueue([{ path: sources[0] }], {
    emit, ...runOpts(),
    settings: { customOutputDir: outDir, concurrency: 4 },
  });

  assert.equal(events.filter(e => e.type === 'file:done').length, 1);
  assert.equal(events.find(e => e.type === 'batch:done').done, 1);
});

test('cancelling stops the pool without leaving the batch unreported', async () => {
  const outDir = path.join(workDir, 'cancel-pool-out');
  let cancelled = false;
  const events = [];
  const emit = (type, data) => {
    events.push({ type, ...data });
    // Cancel as soon as the first file lands, mid-batch.
    if (type === 'file:done') cancelled = true;
  };

  await pipeline.processQueue(sources.map(p => ({ path: p })), {
    emit,
    isCancelled: () => cancelled,
    setCurrent: () => {},
    settings: { customOutputDir: outDir, concurrency: 2 },
  });

  const batch = events.find(e => e.type === 'batch:done');
  assert.ok(batch, 'batch:done must fire even on cancel, or the UI stays stuck on "processing"');
  assert.ok(batch.done < batch.total, `expected an unfinished batch, got ${batch.done}/${batch.total}`);
});

test('an unreadable file fails that file alone and the pool carries on', async () => {
  const outDir = path.join(workDir, 'missing-out');
  const events = [];
  const emit = (type, data) => events.push({ type, ...data });

  const files = [
    { path: path.join(workDir, 'does-not-exist.wav') },
    ...sources.slice(0, 2).map(p => ({ path: p })),
  ];
  await pipeline.processQueue(files, {
    emit, ...runOpts(),
    settings: { customOutputDir: outDir, concurrency: 2 },
  });

  assert.equal(events.filter(e => e.type === 'file:error').length, 1);
  assert.equal(events.filter(e => e.type === 'file:done').length, 2);
  assert.equal(events.find(e => e.type === 'batch:done').done, 3, 'the failed file still counts as handled');
});
