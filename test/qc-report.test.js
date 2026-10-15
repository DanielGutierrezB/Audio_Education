'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const qcReport = require('../src/qc-report');
const { buildQcReportMarkdown, defaultReportFilename } = qcReport;

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

// ── Course consistency ──
// What a viewer notices across a course is classes sounding different from
// each other, more than any one sitting a dB from an absolute target. These
// pin that section's thresholds and wording.

const done = (name, { i = -16, tilt = 11 } = {}) =>
  ({ name, status: 'done', verify: { i, tp: -2, badge: 'ok' }, tilt, qcFlags: [] });

test('consistency: nothing to compare with fewer than two finished files', () => {
  assert.equal(qcReport.analyzeConsistency([]), null);
  assert.equal(qcReport.analyzeConsistency([done('a.wav')]), null);
  assert.equal(
    qcReport.analyzeConsistency([done('a.wav'), { name: 'b.wav', status: 'error' }]),
    null,
    'an errored file has nothing to measure');
});

test('consistency: a uniform batch reports no outliers', () => {
  const c = qcReport.analyzeConsistency([
    done('01.wav', { i: -16.0 }), done('02.wav', { i: -16.1 }), done('03.wav', { i: -15.9 }),
  ]);
  assert.ok(c.loudness.spread <= qcReport.LOUDNESS_SPREAD_LU);
  assert.deepEqual(c.loudnessOutliers, []);
  assert.deepEqual(c.tiltOutliers, []);
});

test('consistency: the class that did not land is named', () => {
  const c = qcReport.analyzeConsistency([
    done('01.wav', { i: -16.0 }), done('02.wav', { i: -16.0 }),
    done('03.wav', { i: -16.1 }), done('04.wav', { i: -13.0 }),
  ]);
  assert.ok(c.loudness.spread > qcReport.LOUDNESS_SPREAD_LU);
  assert.ok(c.loudnessOutliers.length >= 1);
  assert.equal(c.loudnessOutliers[0].name, '04.wav', 'the worst offender reads first');
});

test('consistency: a differently-recorded class is flagged on source tone', () => {
  const c = qcReport.analyzeConsistency([
    done('01.wav', { tilt: 11 }), done('02.wav', { tilt: 11.4 }),
    done('03.wav', { tilt: 10.8 }), done('04.wav', { tilt: 19 }),
  ]);
  assert.equal(c.tiltOutliers.length, 1);
  assert.equal(c.tiltOutliers[0].name, '04.wav');
  assert.ok(c.tiltOutliers[0].distance > qcReport.TILT_OUTLIER_DB);
  // Tone is about the source, so it must not be reported as a loudness problem.
  assert.deepEqual(c.loudnessOutliers, []);
});

test('consistency: files with no measurement are skipped, not counted as zero', () => {
  const c = qcReport.analyzeConsistency([
    done('01.wav', { i: -16 }), done('02.wav', { i: -16 }),
    { name: '03.wav', status: 'done', verify: null, tilt: null, qcFlags: [] },
  ]);
  assert.equal(c.loudness.count, 2, 'an unmeasured file must not drag the spread to 16 LU');
  assert.equal(c.tilt.count, 2);
});

test('the report renders the consistency section and calls out the outlier', () => {
  const md = qcReport.buildQcReportMarkdown([
    done('01.wav', { i: -16.0 }), done('02.wav', { i: -16.0 }), done('03.wav', { i: -12.5 }),
  ]);
  assert.match(md, /## Course consistency/);
  assert.match(md, /Output loudness/);
  assert.match(md, /Loudness is not uniform/);
  assert.match(md, /03\.wav/);
});

test('the consistency section is omitted when there is nothing to compare', () => {
  const md = qcReport.buildQcReportMarkdown([done('only.wav')]);
  assert.doesNotMatch(md, /## Course consistency/);
});
