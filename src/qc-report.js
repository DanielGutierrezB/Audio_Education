'use strict';

// ── Batch QC report ───────────────────────────────────────────────────
// Renders a single Markdown document summarizing every file's mode, QC
// flags, and post-render loudness check — meant to be dropped alongside
// the course deliverable (docs/PLAN.md §4 Fase 8, "exportar informe QC
// del lote"). Pure string-building: the caller (main.js, over IPC)
// supplies the per-file summaries the renderer already tracks in its
// queue state, so this module has no FFmpeg/Electron dependency and no
// I/O of its own.

// Mirrors FLAG_SEVERITY in renderer/js/app.js — duplicated because the
// renderer has no direct Node access across the context bridge (see the
// AUDIO_EXTS comment there for the same situation).
const WARN_FLAG_CODES = new Set(['CLIP', 'HUM', 'SIBILANT', 'NOISY', 'DC_OFFSET', 'PAIR_MISMATCH', 'PAIR_REALIGNED']);

function pad2(n) { return String(n).padStart(2, '0'); }

function formatTimestamp(date) {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} ` +
    `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())} UTC`;
}

function defaultReportFilename(date = new Date()) {
  return `audiopro-qc-report-${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}.md`;
}

function formatDuration(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${pad2(s)}`;
}

// Reflects the same badge rules buildModeBadge uses in the renderer —
// see docs/PLAN.md §2.1 for the pairing/fallback semantics.
function modeLabel(file) {
  if (file.resolvedMode === 2) return '2 \u00b7 fused';
  if (file.resolvedMode === 1 && file.pairPath) return '1 \u00b7 pair mismatch';
  return file.pairPath ? '2 \u00b7 pending' : '1';
}

function flagsSummary(flags) {
  if (!flags || flags.length === 0) return 'clean \u2014 no flags';
  return flags.map(f => (WARN_FLAG_CODES.has(f.code) ? `\u26A0 ${f.code}` : f.code)).join(', ');
}

function verifySummary(verify) {
  if (!verify || verify.i == null) return '\u2014';
  const mark = verify.badge === 'ok' ? '\u2713' : '\u26A0';
  return `${mark} ${verify.i.toFixed(1)} LUFS`;
}

function escapeCell(s) {
  return String(s ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

// ── Course consistency ──
// Within one course, what people notice is classes sounding different from
// *each other* far more than any one of them sitting a dB from an absolute
// target. Watching a course back, a class 2 LU louder than the rest stands
// out; a course uniformly 2 LU off its target does not.
//
// AudioPro masters every file to the same figure, so a spread in the output
// column means something didn't land and is worth a look before delivery.
// Source tilt is included for the opposite reason: a spread there is expected
// (it is what the adaptive correction exists to absorb), but a class far from
// the others was recorded differently — different mic, different room — and
// that is worth knowing even when the correction handled it.

// loudnorm lands within a few tenths of a LU, so anything past this is not
// measurement noise.
const LOUDNESS_SPREAD_LU = 1.0;
// Source tilt varies a few dB across takes of the same voice; past this it is
// a different recording setup, not a different day.
const TILT_OUTLIER_DB = 4.0;

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function spreadOf(files, pick) {
  const measured = files
    .map(f => ({ name: f.name, value: pick(f) }))
    .filter(x => typeof x.value === 'number' && Number.isFinite(x.value));
  if (measured.length < 2) return null;
  const values = measured.map(x => x.value);
  const mid = median(values);
  return {
    count: measured.length,
    min: Math.min(...values),
    max: Math.max(...values),
    spread: Math.max(...values) - Math.min(...values),
    median: mid,
    // Sorted by how far off they are, so the worst offender reads first.
    byDistance: measured
      .map(x => ({ ...x, distance: Math.abs(x.value - mid) }))
      .sort((a, b) => b.distance - a.distance),
  };
}

// Returns null when there is nothing to compare — a single file, or a batch
// where nothing finished.
function analyzeConsistency(files) {
  const done = (Array.isArray(files) ? files : []).filter(f => f.status === 'done');
  if (done.length < 2) return null;

  const loudness = spreadOf(done, f => f.verify?.i);
  const tilt = spreadOf(done, f => f.tilt);

  const loudnessOutliers = loudness && loudness.spread > LOUDNESS_SPREAD_LU
    ? loudness.byDistance.filter(x => x.distance > LOUDNESS_SPREAD_LU / 2)
    : [];
  const tiltOutliers = tilt
    ? tilt.byDistance.filter(x => x.distance > TILT_OUTLIER_DB)
    : [];

  return { loudness, tilt, loudnessOutliers, tiltOutliers };
}

function consistencyLines(files) {
  const c = analyzeConsistency(files);
  if (!c) return [];

  const lines = ['', '## Course consistency', ''];
  lines.push('How alike the finished classes are, which is what a viewer notices');
  lines.push('across a course more than any single file\u2019s distance from target.');
  lines.push('');
  lines.push('| Measure | Across | Lowest | Highest | Spread |');
  lines.push('|---|---|---|---|---|');
  if (c.loudness) {
    lines.push(`| Output loudness | ${c.loudness.count} files | ${c.loudness.min.toFixed(1)} LUFS ` +
      `| ${c.loudness.max.toFixed(1)} LUFS | **${c.loudness.spread.toFixed(1)} LU** |`);
  }
  if (c.tilt) {
    lines.push(`| Source tone (body \u2212 presence) | ${c.tilt.count} files | ${c.tilt.min.toFixed(1)} dB ` +
      `| ${c.tilt.max.toFixed(1)} dB | ${c.tilt.spread.toFixed(1)} dB |`);
  }
  lines.push('');

  if (c.loudnessOutliers.length) {
    lines.push(`\u26A0 **Loudness is not uniform** \u2014 the batch spans ${c.loudness.spread.toFixed(1)} LU ` +
      `where every file targets the same figure, so these did not land:`);
    for (const o of c.loudnessOutliers) {
      lines.push(`  - ${escapeCell(o.name)} \u2014 ${o.value.toFixed(1)} LUFS ` +
        `(${o.value > c.loudness.median ? '+' : ''}${(o.value - c.loudness.median).toFixed(1)} LU vs the rest)`);
    }
    lines.push('');
  } else if (c.loudness) {
    lines.push(`\u2713 Loudness is uniform across the batch (${c.loudness.spread.toFixed(1)} LU spread).`);
    lines.push('');
  }

  if (c.tiltOutliers.length) {
    lines.push('These classes were **recorded differently** from the rest \u2014 the tone');
    lines.push('correction absorbed it, but worth a listen before delivery:');
    for (const o of c.tiltOutliers) {
      lines.push(`  - ${escapeCell(o.name)} \u2014 source tone ${o.value.toFixed(1)} dB ` +
        `(${o.value > c.tilt.median ? 'darker' : 'brighter'} than the others by ` +
        `${o.distance.toFixed(1)} dB)`);
    }
    lines.push('');
  }

  return lines;
}

function needsAttention(file) {
  if (file.status === 'error') return true;
  if (file.verify && file.verify.badge !== 'ok') return true;
  return (file.qcFlags ?? []).some(fl => WARN_FLAG_CODES.has(fl.code));
}

function buildQcReportMarkdown(files, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const list = Array.isArray(files) ? files : [];

  const doneCount = list.filter(f => f.status === 'done').length;
  const errorCount = list.filter(f => f.status === 'error').length;
  const pendingCount = list.length - doneCount - errorCount;
  const mode2Count = list.filter(f => f.resolvedMode === 2).length;
  const flaggedFiles = list.filter(needsAttention);

  const lines = [];
  lines.push('# AudioPro \u2014 QC Report');
  lines.push('');
  lines.push(`Generated: ${formatTimestamp(now)}`);
  lines.push(`Files: ${list.length} \u00b7 Done: ${doneCount} \u00b7 Errors: ${errorCount} \u00b7 Pending: ${pendingCount} \u00b7 Mode 2 (fused): ${mode2Count}`);
  lines.push('');
  lines.push(flaggedFiles.length
    ? `**${flaggedFiles.length} file(s) need a look** before delivery \u2014 see Details below.`
    : '_No files need attention \u2014 clean run._');
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| File | Mode | Duration | Flags | Output check |');
  lines.push('|---|---|---|---|---|');
  for (const f of list) {
    const row = f.status === 'error'
      ? [escapeCell(f.name), modeLabel(f), formatDuration(f.duration), `ERROR: ${escapeCell(f.errorMsg)}`, '\u2014']
      : [escapeCell(f.name), modeLabel(f), formatDuration(f.duration), escapeCell(flagsSummary(f.qcFlags)), verifySummary(f.verify)];
    lines.push(`| ${row.join(' | ')} |`);
  }

  lines.push(...consistencyLines(list));

  if (flaggedFiles.length) {
    lines.push('');
    lines.push('## Details \u2014 files that need a look');
    for (const f of flaggedFiles) {
      lines.push('');
      lines.push(`### ${f.name}`);
      lines.push(`- Mode: ${modeLabel(f)}${f.pairPath ? ` (pair: \`${f.pairPath}\`)` : ''}`);
      lines.push(`- Status: ${f.status}`);
      if (f.status === 'error') {
        lines.push(`- Error: ${f.errorMsg ?? 'unknown error'}`);
        continue;
      }
      if (f.qcFlags?.length) {
        lines.push('- Flags:');
        for (const fl of f.qcFlags) lines.push(`  - **${fl.code}** \u2014 ${fl.detail ?? ''}`);
      }
      if (f.verify) {
        const iStr = f.verify.i != null ? `${f.verify.i.toFixed(1)} LUFS` : 'n/a';
        const tpStr = f.verify.tp != null ? `${f.verify.tp.toFixed(1)} dBFS` : 'n/a';
        lines.push(`- Output check: ${iStr}, True peak ${tpStr} \u2192 ${f.verify.badge}`);
      }
      if (f.outputPath) lines.push(`- Output: \`${f.outputPath}\``);
    }
  }

  lines.push('');
  return lines.join('\n');
}

module.exports = {
  buildQcReportMarkdown, defaultReportFilename, WARN_FLAG_CODES,
  analyzeConsistency, LOUDNESS_SPREAD_LU, TILT_OUTLIER_DB,
};
