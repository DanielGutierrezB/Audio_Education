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

module.exports = { buildQcReportMarkdown, defaultReportFilename, WARN_FLAG_CODES };
