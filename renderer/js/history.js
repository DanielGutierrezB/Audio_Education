'use strict';

// The History tab: recording each finished render, and rendering the log.

import { FLAG_SEVERITY, findQueuedFile } from './queue.js';

// ── Render history ──
const historyList     = document.getElementById('history-list');
const historyEmpty    = document.getElementById('history-empty');
const historyCount    = document.getElementById('history-count');
const btnClearHistory = document.getElementById('btn-clear-history');

const PRESET_LABELS = {
  platzi:  'Platzi −16 LUFS',
  youtube: 'YouTube −14 LUFS',
  podcast: 'Podcast −16 LUFS',
};

// Persist a finished render so the History tab can show it later. Pulls the
// QC flags/verify already attached to the queued file plus the batch's
// output path and target preset. Best-effort: never blocks processing.
async function recordHistory(event, status) {
  if (!window.api?.history) return;
  const file = findQueuedFile(event.file);
  const presetEl = document.getElementById('toolbar-preset');
  const rec = {
    ts: Date.now(),
    name: (event.file || '').split('/').pop(),
    source: event.file || null,
    output: event.outputPath || null,
    preset: presetEl ? presetEl.value : null,
    mode: event.mode ?? file?.resolvedMode ?? null,
    flags: file?.qcFlags ?? [],
    verify: event.verify ?? file?.verify ?? null,
    status,
    error: status === 'error' ? (event.error || null) : null,
  };
  try {
    await window.api.history.add(rec);
    // Refresh only if the History tab is the one on screen.
    if (document.getElementById('view-history')?.classList.contains('active')) loadHistory();
  } catch (err) {
    console.error('history add failed', err);
  }
}

async function loadHistory() {
  if (!window.api?.history || !historyList) return;
  let items = [];
  try { items = await window.api.history.list(); } catch { /* ignore — show empty */ }
  renderHistory(items);
}

function renderHistory(items) {
  const has = items.length > 0;
  historyEmpty.hidden = has;
  historyList.hidden = !has;
  if (btnClearHistory) btnClearHistory.hidden = !has;
  if (historyCount) historyCount.textContent = has ? `${items.length} render${items.length !== 1 ? 's' : ''}` : '';
  historyList.innerHTML = '';
  for (const rec of items) historyList.appendChild(buildHistoryRow(rec));
}

function formatHistoryDate(ts) {
  if (!ts) return '';
  try { return new Date(ts).toLocaleString(); } catch { return ''; }
}

function buildHistoryRow(rec) {
  const row = document.createElement('div');
  row.className = 'history-item' + (rec.status === 'error' ? ' history-error' : '');

  const head = document.createElement('div');
  head.className = 'history-item-head';

  const date = document.createElement('span');
  date.className = 'history-date';
  date.textContent = formatHistoryDate(rec.ts);

  const name = document.createElement('span');
  name.className = 'history-name';
  name.textContent = rec.name || '(unknown)';
  name.title = rec.output || rec.source || '';

  const openBtn = document.createElement('button');
  openBtn.className = 'btn btn-secondary btn-sm history-open';
  openBtn.textContent = 'Abrir ubicación';
  const target = rec.output || rec.source;
  openBtn.disabled = !target;
  openBtn.title = target ? `Reveal in Explorer:\n${target}` : 'No file path recorded';
  if (target) openBtn.addEventListener('click', () => window.api.shell.openPath(target));

  head.append(date, name, openBtn);

  const meta = document.createElement('div');
  meta.className = 'history-meta';

  if (rec.preset) {
    const p = document.createElement('span');
    p.className = 'flag-chip flag-info';
    p.textContent = PRESET_LABELS[rec.preset] || rec.preset;
    meta.appendChild(p);
  }

  const modeChip = document.createElement('span');
  if (rec.mode === 2) { modeChip.className = 'file-mode-badge mode-2'; modeChip.textContent = 'Mode 2 · fused'; }
  else { modeChip.className = 'file-mode-badge mode-fallback'; modeChip.textContent = 'Mode 1'; }
  meta.appendChild(modeChip);

  if (rec.status === 'error') {
    const e = document.createElement('span');
    e.className = 'flag-chip flag-warn';
    e.textContent = 'error';
    if (rec.error) e.title = rec.error;
    meta.appendChild(e);
  }

  for (const f of rec.flags || []) {
    const chip = document.createElement('span');
    chip.className = `flag-chip flag-${FLAG_SEVERITY[f.code] ?? 'info'}`;
    chip.textContent = f.code;
    if (f.detail) chip.title = f.detail;
    meta.appendChild(chip);
  }

  if (rec.verify) {
    const ok = rec.verify.badge === 'ok';
    const chip = document.createElement('span');
    chip.className = `flag-chip flag-${ok ? 'ok' : 'warn'}`;
    chip.textContent = rec.verify.i != null ? `${ok ? '✓' : '⚠'} out ${rec.verify.i.toFixed(1)} LUFS` : 'verify: n/a';
    if (rec.verify.tp != null) chip.title = `True peak: ${rec.verify.tp.toFixed(1)} dBFS`;
    meta.appendChild(chip);
  }

  row.append(head, meta);
  return row;
}

if (btnClearHistory) {
  btnClearHistory.addEventListener('click', async () => {
    if (!window.api?.history) return;
    try { await window.api.history.clear(); } catch { /* ignore */ }
    loadHistory();
  });
}

export {
  recordHistory,
  loadHistory,
};
