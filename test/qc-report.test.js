'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { buildQcReportMarkdown, defaultReportFilename } = require('../src/qc-report');

const FIXED_NOW = new Date('2026-07-15T12:34:00Z');

test('buildQcReportMarkdown: empty batch reports zero files and no attention needed', () => {
  const md = buildQcReportMarkdown([], { now: FIXED_NOW });
  assert.match(md, /# AudioPro — QC Report/);
  assert.match(md, /Files: 0 · Done: 0 · Errors: 0 · Pending: 0 · Mode 2 \(fused\): 0/);
  assert.match(md, /No files need attention — clean run\./);
  assert.doesNotMatch(md, /## Details/);
});

test('buildQcReportMarkdown: clean done file shows in the summary table with no flags', () => {
  const files = [{
    name: 'lesson-01.wav', status: 'done', duration: 754, resolvedMode: 1,
    qcFlags: [], verify: { i: -16.1, tp: -2.4, badge: 'ok' },
  }];
  const md = buildQcReportMarkdown(files, { now: FIXED_NOW });
  assert.match(md, /\| lesson-01\.wav \| 1 \| 12:34 \| clean — no flags \| ✓ -16\.1 LUFS \|/);
  assert.doesNotMatch(md, /## Details/);
});

test('buildQcReportMarkdown: file with a warn-severity flag lands in the Details section', () => {
  const files = [{
    name: 'lesson-02.wav', status: 'done', duration: 482, resolvedMode: 2, pairPath: '/rec/Enhanced/lesson-02.wav',
    qcFlags: [{ code: 'HUM', detail: '60 Hz band 3.1 dB below full mix' }],
    verify: { i: -16.0, tp: -2.1, badge: 'ok' },
  }];
  const md = buildQcReportMarkdown(files, { now: FIXED_NOW });
  assert.match(md, /\*\*1 file\(s\) need a look\*\* before delivery/);
  assert.match(md, /⚠ HUM/);
  assert.match(md, /### lesson-02\.wav/);
  assert.match(md, /- Mode: 2 · fused \(pair: `\/rec\/Enhanced\/lesson-02\.wav`\)/);
  assert.match(md, /\*\*HUM\*\* — 60 Hz band 3\.1 dB below full mix/);
});

test('buildQcReportMarkdown: an out-of-spec verify badge also triggers a Details entry even with no flags', () => {
  const files = [{
    name: 'lesson-03.wav', status: 'done', duration: 100, resolvedMode: 1,
    qcFlags: [], verify: { i: -18.5, tp: -1.0, badge: 'warn' },
  }];
  const md = buildQcReportMarkdown(files, { now: FIXED_NOW });
  assert.match(md, /### lesson-03\.wav/);
  assert.match(md, /Output check: -18\.5 LUFS, True peak -1\.0 dBFS → warn/);
});

test('buildQcReportMarkdown: error files render an ERROR row and error detail without crashing on missing fields', () => {
  const files = [{ name: 'lesson-04.wav', status: 'error', errorMsg: 'File not readable or not found' }];
  const md = buildQcReportMarkdown(files, { now: FIXED_NOW });
  assert.match(md, /\| lesson-04\.wav \| 1 \| — \| ERROR: File not readable or not found \| — \|/);
  assert.match(md, /- Error: File not readable or not found/);
});

test('buildQcReportMarkdown: mode label covers pending pair and fallback mismatch', () => {
  const files = [
    { name: 'a.wav', status: 'queued', pairPath: '/x/Enhanced/a.wav' },
    { name: 'b.wav', status: 'done', resolvedMode: 1, pairPath: '/x/Enhanced/b.wav', qcFlags: [], verify: { i: -16, tp: -2, badge: 'ok' } },
  ];
  const md = buildQcReportMarkdown(files, { now: FIXED_NOW });
  assert.match(md, /\| a\.wav \| 2 · pending \|/);
  assert.match(md, /\| b\.wav \| 1 · pair mismatch \|/);
});

test('buildQcReportMarkdown: escapes pipe characters in file names so the table stays valid', () => {
  const files = [{ name: 'weird|name.wav', status: 'done', qcFlags: [], verify: null }];
  const md = buildQcReportMarkdown(files, { now: FIXED_NOW });
  assert.match(md, /weird\\\|name\.wav/);
});

test('defaultReportFilename: produces a date-stamped markdown filename', () => {
  assert.equal(defaultReportFilename(FIXED_NOW), 'audiopro-qc-report-2026-07-15.md');
});
