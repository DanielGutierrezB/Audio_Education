'use strict';

// The log is the only account of what a batch did, and until now it lived
// entirely in memory: a crash or a force-quit mid-course took it with it,
// which is exactly when someone wants to read it. These cover the formatting
// contract the file and the clipboard share, since both render the same
// entries and a diagnosis depends on them being readable.

const { test } = require('node:test');
const assert = require('node:assert/strict');

// Safe to require outside Electron: nothing at module scope calls into `app`,
// and these tests stay off the functions that do (init, the file writes).
const logger = require('../src/logger');

test('an entry renders as timestamp, category, message', () => {
  const line = logger.formatEntry({ time: '2026-10-15 12:00:00', cat: 'pipeline', msg: 'Done' });
  assert.equal(line, '[2026-10-15 12:00:00] [pipeline] Done');
});

test('single-line data is appended inline, so one event stays one line', () => {
  const line = logger.formatEntry({ time: 't', cat: 'qc', msg: 'Flags', data: 'SIBILANT, CLIP' });
  assert.equal(line, '[t] [qc] Flags | SIBILANT, CLIP');
  assert.ok(!line.includes('\n'));
});

test('an object is serialised and indented under its entry', () => {
  const line = logger.formatEntry({ time: 't', cat: 'pipeline', msg: 'Batch', data: { files: 4, preset: 'platzi' } });
  const [head, ...rest] = line.split('\n');
  assert.equal(head, '[t] [pipeline] Batch');
  assert.ok(rest.length > 1, 'a multi-key object should span lines');
  for (const l of rest) {
    assert.ok(l.startsWith('    '), `continuation lines must be indented: ${JSON.stringify(l)}`);
  }
  assert.match(line, /"preset": "platzi"/);
});

test('an entry with no data carries no separator', () => {
  const line = logger.formatEntry({ time: 't', cat: 'system', msg: 'started' });
  assert.ok(!line.includes('|'));
});

test('rotation keeps a bounded number of bounded files', () => {
  // A long batch with per-step logging runs to a few hundred KB, so the cap
  // has to be well above that while still bounding a runaway loop.
  assert.ok(logger.MAX_FILE_BYTES >= 1024 * 1024, 'a single batch must fit comfortably');
  assert.ok(logger.MAX_FILES >= 2, 'at least the previous session must survive a rotation');
  assert.ok(logger.MAX_FILES * logger.MAX_FILE_BYTES <= 64 * 1024 * 1024,
    'the whole log directory must stay a sane size on a working disk');
});

test('the in-memory buffer is bounded too', () => {
  assert.ok(logger.MAX_ENTRIES >= 500, 'a batch must be readable in full from memory');
  assert.ok(Number.isInteger(logger.MAX_ENTRIES));
});
