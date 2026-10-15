'use strict';

// Render history: the records come from the renderer, so the whitelist in
// src/history.js is the only thing standing between a malformed/oversized
// record and electron-store. These tests pin that contract.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const history = require('../src/history');

// Minimal stand-in for electron-store: get/set over a plain object.
function fakeStore(initial = {}) {
  const data = { ...initial };
  return {
    get: (k) => data[k],
    set: (k, v) => { data[k] = v; },
    _raw: () => data,
  };
}

test('sanitizeRecord: keeps the rendered fields and drops unknown keys', () => {
  const clean = history.sanitizeRecord({
    ts: 1700000000000,
    name: 'clase.wav',
    source: '/src/clase.wav',
    output: '/src/Audio_Pro/clase.wav',
    preset: 'platzi',
    mode: 2,
    status: 'done',
    verify: { i: -16, tp: -2, badge: 'ok' },
    flags: [{ code: 'SIBILANT', detail: 'harsh' }],
    somethingElse: 'should not survive',
  });
  assert.equal(clean.name, 'clase.wav');
  assert.equal(clean.mode, 2);
  assert.deepEqual(clean.verify, { i: -16, tp: -2, badge: 'ok' });
  assert.deepEqual(clean.flags, [{ code: 'SIBILANT', detail: 'harsh' }]);
  assert.equal('somethingElse' in clean, false);
});

test('sanitizeRecord: rejects non-records', () => {
  for (const bad of [null, undefined, 'clase.wav', 42, []]) {
    assert.equal(history.sanitizeRecord(bad), null, `${JSON.stringify(bad)} should be rejected`);
  }
});

test('sanitizeRecord: coerces bad types instead of trusting them', () => {
  const clean = history.sanitizeRecord({
    ts: 'not-a-number',
    name: { nope: 1 },
    mode: NaN,
    status: 'something-made-up',
    verify: 'not-an-object',
    flags: 'not-an-array',
  });
  assert.equal(clean.ts, 0);
  assert.equal(clean.name, null);
  assert.equal(clean.mode, null);
  assert.equal(clean.status, 'done', 'anything other than "error" normalizes to done');
  assert.equal(clean.verify, null);
  assert.deepEqual(clean.flags, []);
});

test('sanitizeRecord: caps string lengths and flag counts', () => {
  const clean = history.sanitizeRecord({
    name: 'x'.repeat(5000),
    flags: Array.from({ length: 50 }, (_, i) => ({ code: 'C'.repeat(100) + i, detail: 'd'.repeat(5000) })),
  });
  assert.equal(clean.name.length, 1024);
  assert.equal(clean.flags.length, 20);
  assert.equal(clean.flags[0].code.length, 40);
  assert.equal(clean.flags[0].detail.length, 1024);
});

test('sanitizeRecord: an unverified badge degrades to warn, never to ok', () => {
  const clean = history.sanitizeRecord({ verify: { i: -16, tp: -2, badge: 'totally-fine' } });
  assert.equal(clean.verify.badge, 'warn');
});

test('add: appends and returns the new length', () => {
  const store = fakeStore();
  assert.equal(history.add(store, { name: 'a.wav' }), 1);
  assert.equal(history.add(store, { name: 'b.wav' }), 2);
  assert.deepEqual(store.get(history.HISTORY_KEY).map(r => r.name), ['a.wav', 'b.wav']);
});

test('add: a rejected record returns 0 and does not touch the store', () => {
  const store = fakeStore({ [history.HISTORY_KEY]: [{ name: 'kept.wav' }] });
  assert.equal(history.add(store, null), 0);
  assert.deepEqual(store.get(history.HISTORY_KEY).map(r => r.name), ['kept.wav']);
});

test('add: keeps only the newest HISTORY_CAP entries', () => {
  const store = fakeStore();
  for (let i = 0; i < history.HISTORY_CAP + 25; i++) history.add(store, { name: `f${i}.wav` });
  const kept = store.get(history.HISTORY_KEY);
  assert.equal(kept.length, history.HISTORY_CAP);
  assert.equal(kept[0].name, 'f25.wav', 'the oldest entries are the ones dropped');
  assert.equal(kept[kept.length - 1].name, `f${history.HISTORY_CAP + 24}.wav`);
});

test('list: newest first, and empty when nothing was ever recorded', () => {
  const store = fakeStore();
  assert.deepEqual(history.list(store), []);
  history.add(store, { name: 'first.wav' });
  history.add(store, { name: 'second.wav' });
  assert.deepEqual(history.list(store).map(r => r.name), ['second.wav', 'first.wav']);
});

test('clear: empties the log without removing the key', () => {
  const store = fakeStore();
  history.add(store, { name: 'a.wav' });
  assert.equal(history.clear(store), true);
  assert.deepEqual(history.list(store), []);
});
