'use strict';

// Mirrors AUDIO_EXTS in src/pairing.js — kept in sync manually since the
// renderer has no direct access to Node modules across the context
// bridge. Used only to accept/reject dropped files client-side; the main
// process re-validates everything server-side regardless.
const AUDIO_EXTS = ['.wav', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.aiff', '.aif'];
function isAudioFileName(name) {
  const lower = name.toLowerCase();
  return AUDIO_EXTS.some(ext => lower.endsWith(ext));
}

// ── DOM refs ──
const tabs           = document.querySelectorAll('.tab');
const views          = document.querySelectorAll('.view');
const btnAddFolders  = document.getElementById('btn-add-folders');
const btnAddFiles    = document.getElementById('btn-add-files');
const btnProcessAll  = document.getElementById('btn-process-all');
const btnClearAll    = document.getElementById('btn-clear-all');
const btnRemoveDone  = document.getElementById('btn-remove-completed');
const queueEmpty     = document.getElementById('queue-empty');
const queueList      = document.getElementById('queue-list');
const queueSummary   = document.getElementById('queue-summary');
const queueContainer = document.getElementById('queue-container');
const badgeDone      = document.getElementById('badge-done');

// ── State ──
// Map<folderPath, { files: Array<{ path, name, size, duration, status }>, collapsed: bool }>
const queue = new Map();
// Map<originalPath, outputPath>
const completedFiles = new Map();
// Set of selected file paths
const selectedFiles = new Set();

// ── Tab navigation ──
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    tabs.forEach(t => {
      t.classList.toggle('active', t.dataset.tab === target);
      t.setAttribute('aria-selected', t.dataset.tab === target);
    });
    views.forEach(v => {
      const isTarget = v.id === `view-${target}`;
      v.classList.toggle('active', isTarget);
      v.hidden = !isTarget;
    });
  });
});

// ── Preferences ──
let prefs = {};
async function loadPrefs() {
  if (window.api) prefs = await window.api.store.getAll();
  applySettingsUI(prefs);
}

// ── Helpers ──
function formatDuration(sec) {
  if (sec == null) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function formatAudioTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// Mirrors fileUrlFor in eq-editor.js — kept in sync manually since these
// are separate plain <script> files with no shared module system. Used
// here only for the spectrogram <img> preview.
function fileUrlFor(p) {
  const fwd = p.replace(/\\/g, '/');
  const prefix = fwd.startsWith('/') ? 'file://' : 'file:///';
  return prefix + encodeURI(fwd);
}

function formatEta(seconds) {
  if (seconds == null || isNaN(seconds) || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function statusIcon(status) {
  const map = { queued: '⏳', processing: '🔄', done: '✅', error: '❌' };
  return map[status] ?? '⏳';
}

// ── Queue management ──
async function addFoldersViaDialog() {
  if (!window.api) return;
  const paths = await window.api.folders.open();
  if (paths.length) await processFolderPaths(paths);
}

async function addFilesViaDialog() {
  if (!window.api) return;
  const files = await window.api.files.open();
  if (files.length) addIndividualFiles(files);
}

async function processFolderPaths(folderPaths) {
  const added = [];
  for (const fp of folderPaths) {
    if (queue.has(fp)) continue;
    const wavFiles = await window.api.folders.scan(fp);
    if (!wavFiles.length) continue;
    queue.set(fp, {
      files: wavFiles.map(f => ({ ...f, duration: null, status: 'queued' })),
      collapsed: false,
    });
    added.push(fp);
  }
  if (!added.length) return;
  renderQueue();
  for (const fp of added) loadFolderMetadata(fp);
}

function addIndividualFiles(fileInfos) {
  // Group by parent directory
  for (const fi of fileInfos) {
    const dir = fi.path.substring(0, fi.path.lastIndexOf('/'));
    if (!queue.has(dir)) {
      queue.set(dir, { files: [], collapsed: false });
    }
    const group = queue.get(dir);
    if (!group.files.find(f => f.path === fi.path)) {
      group.files.push({ ...fi, duration: null, status: 'queued' });
    }
  }
  renderQueue();
  for (const fi of fileInfos) {
    loadSingleFileMeta(fi.path);
  }
}

async function loadFolderMetadata(folderPath) {
  const group = queue.get(folderPath);
  if (!group || !window.api) return;
  for (const file of group.files) {
    const meta = await window.api.ffprobe.getMetadata(file.path);
    if (meta?.duration != null) {
      file.duration = meta.duration;
      patchFileDuration(file);
      updateQueueSummary();
    }
  }
}

async function loadSingleFileMeta(filePath) {
  if (!window.api) return;
  const meta = await window.api.ffprobe.getMetadata(filePath);
  if (meta?.duration != null) {
    for (const [, group] of queue) {
      const f = group.files.find(f => f.path === filePath);
      if (f) {
        f.duration = meta.duration;
        patchFileDuration(f);
        updateQueueSummary();
        return;
      }
    }
  }
}

function removeFolder(folderPath) {
  for (const fp of queue.get(folderPath)?.files ?? []) {
    selectedFiles.delete(fp.path);
  }
  queue.delete(folderPath);
  renderQueue();
}

function removeFile(filePath) {
  selectedFiles.delete(filePath);
  for (const [fp, group] of queue) {
    const idx = group.files.findIndex(f => f.path === filePath);
    if (idx !== -1) {
      group.files.splice(idx, 1);
      if (group.files.length === 0) queue.delete(fp);
      break;
    }
  }
  renderQueue();
}

function moveFile(filePath, direction) {
  for (const [, group] of queue) {
    const idx = group.files.findIndex(f => f.path === filePath);
    if (idx === -1) continue;
    const newIdx = idx + direction;
    if (newIdx < 0 || newIdx >= group.files.length) return;
    [group.files[idx], group.files[newIdx]] = [group.files[newIdx], group.files[idx]];
    renderQueue();
    return;
  }
}

function clearAll() {
  queue.clear();
  selectedFiles.clear();
  renderQueue();
}

function removeCompleted() {
  for (const [fp, group] of queue) {
    group.files = group.files.filter(f => {
      if (f.status === 'done') { selectedFiles.delete(f.path); return false; }
      return true;
    });
    if (group.files.length === 0) queue.delete(fp);
  }
  renderQueue();
}

// ── Render queue ──
function renderQueue() {
  // Single source of truth for the EQ editor's file dropdown: every time
  // the queue is rendered (add/remove/reset), notify the editor.
  notifyQueueChanged();
  const hasFiles = queue.size > 0;
  queueEmpty.hidden = hasFiles;
  queueList.hidden = !hasFiles;
  btnProcessAll.disabled = !hasFiles;
  btnClearAll.hidden = !hasFiles;

  const hasDone = hasFiles && [...queue.values()].some(g => g.files.some(f => f.status === 'done'));
  btnRemoveDone.hidden = !hasDone;

  if (!hasFiles) {
    queueList.innerHTML = '';
    updateQueueSummary();
    return;
  }

  queueList.innerHTML = '';
  for (const [fp, group] of queue) {
    queueList.appendChild(buildFolderGroup(fp, group));
  }

  updateQueueSummary();
}

function updateQueueSummary() {
  let totalFiles = 0;
  let totalBytes = 0;
  let totalDuration = 0;

  for (const [, group] of queue) {
    for (const f of group.files) {
      totalFiles++;
      totalBytes += f.size ?? 0;
      if (f.duration) totalDuration += f.duration;
    }
  }

  if (totalFiles === 0) {
    queueSummary.textContent = '';
    return;
  }

  const selCount = selectedFiles.size;
  const sizeStr = totalBytes >= 1024 * 1024
    ? `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.round(totalBytes / 1024)} KB`;

  // Rough estimate: analyze + measure + render (+ fusion for Mode 2 pairs)
  // ≈ 0.18× realtime across 3-5 FFmpeg passes per file.
  const estSec = totalDuration > 0 ? Math.round(totalDuration * 0.18) : null;
  const estStr = estSec != null ? ` · ~${formatEta(estSec)} est.` : '';

  const selStr = selCount > 0 ? `${selCount} of ${totalFiles} selected · ` : `${totalFiles} file${totalFiles !== 1 ? 's' : ''} · `;

  queueSummary.textContent = `${selStr}${sizeStr}${estStr}`;
}

function buildFolderGroup(folderPath, group) {
  const wrap = document.createElement('div');
  wrap.className = 'folder-group';
  wrap.dataset.folder = folderPath;

  const header = document.createElement('div');
  header.className = 'folder-group-header';

  const chevron = document.createElement('span');
  chevron.className = 'folder-chevron' + (group.collapsed ? '' : ' open');
  chevron.textContent = '▶';

  const icon = document.createElement('span');
  icon.className = 'folder-icon';
  icon.textContent = '📁';

  const pathSpan = document.createElement('span');
  pathSpan.className = 'folder-path';
  pathSpan.title = folderPath;
  // Show only last two path components
  const parts = folderPath.split('/');
  pathSpan.textContent = parts.slice(-2).join('/');

  const count = document.createElement('span');
  count.className = 'folder-count';
  count.textContent = `${group.files.length} file${group.files.length !== 1 ? 's' : ''}`;

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove-folder';
  removeBtn.title = 'Remove this folder from the queue';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeFolder(folderPath); });

  header.append(chevron, icon, pathSpan, count, removeBtn);

  header.addEventListener('click', () => {
    group.collapsed = !group.collapsed;
    chevron.classList.toggle('open', !group.collapsed);
    fileList.hidden = group.collapsed;
  });

  wrap.appendChild(header);

  const fileList = document.createElement('div');
  fileList.className = 'file-list';
  fileList.hidden = group.collapsed;
  for (const file of group.files) fileList.appendChild(buildFileItem(file));
  wrap.appendChild(fileList);

  return wrap;
}

// Mode badge reflects `file.resolvedMode` once known (set from the 'qc'
// or 'file:done' pipeline events) and falls back to "pending pair"
// styling when a `pairPath` was auto-detected but processing hasn't
// started yet — see docs/PLAN.md §2.1 for the detection rules.
function buildModeBadge(file) {
  if (!file.pairPath && file.resolvedMode !== 2) return null;
  const badge = document.createElement('span');
  if (file.resolvedMode === 2) {
    badge.className = 'file-mode-badge mode-2';
    badge.textContent = 'Mode 2 · fused';
    badge.title = `Fused with ${file.pairPath ? file.pairPath.split('/').pop() : 'Adobe Enhance'}`;
  } else if (file.resolvedMode === 1 && file.pairPath) {
    badge.className = 'file-mode-badge mode-fallback';
    badge.textContent = 'Mode 1 · pair mismatch';
    badge.title = 'Original and Enhanced/ duration mismatch — processed as Mode 1 on the original';
  } else {
    badge.className = 'file-mode-badge mode-pending';
    badge.textContent = 'Pair detected';
    badge.title = `Will fuse with ${file.pairPath.split('/').pop()} on Process All`;
  }
  return badge;
}

function buildFileItem(file) {
  const item = document.createElement('div');
  item.className = 'file-item' + (selectedFiles.has(file.path) ? ' selected' : '');
  item.dataset.filePath = file.path;

  const main = document.createElement('div');
  main.className = 'file-item-main';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'file-checkbox';
  cb.checked = selectedFiles.has(file.path);
  cb.addEventListener('change', (e) => {
    e.stopPropagation();
    if (cb.checked) selectedFiles.add(file.path);
    else selectedFiles.delete(file.path);
    item.classList.toggle('selected', cb.checked);
    updateQueueSummary();
  });

  const statusEl = document.createElement('span');
  statusEl.className = `file-status-icon status-${file.status}`;
  statusEl.textContent = statusIcon(file.status);
  statusEl.title = file.status;

  const name = document.createElement('span');
  name.className = 'file-name';
  name.title = file.name;
  name.textContent = file.name;

  const dur = document.createElement('span');
  dur.className = 'file-meta file-duration';
  dur.textContent = formatDuration(file.duration);

  const size = document.createElement('span');
  size.className = 'file-meta';
  size.textContent = formatSize(file.size);

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove-file';
  removeBtn.title = 'Remove this file';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeFile(file.path); });

  const badge = buildModeBadge(file);
  main.append(cb, statusEl, name, ...(badge ? [badge] : []), dur, size, removeBtn);
  item.appendChild(main);

  const flags = document.createElement('div');
  flags.className = 'file-flags';
  flags.hidden = true;
  if (file.qcFlags?.length) renderFlagChips(flags, file.qcFlags);
  item.appendChild(flags);

  // Right-click context menu
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, file.path);
  });

  return item;
}

// QC flag codes worth calling out with a "needs attention" color; the
// rest render as neutral info chips. Mirrors the artefact catalogue in
// docs/PLAN.md §1.4.
const FLAG_SEVERITY = {
  CLIP: 'warn', HUM: 'warn', SIBILANT: 'warn', NOISY: 'warn', DC_OFFSET: 'warn',
};

function renderFlagChips(container, flags) {
  container.innerHTML = '';
  if (!flags.length) {
    const ok = document.createElement('span');
    ok.className = 'flag-chip flag-ok';
    ok.textContent = 'clean — no flags';
    container.appendChild(ok);
    return;
  }
  for (const f of flags) {
    const chip = document.createElement('span');
    chip.className = `flag-chip flag-${FLAG_SEVERITY[f.code] ?? 'info'}`;
    chip.textContent = f.code;
    if (f.detail) chip.title = f.detail;
    container.appendChild(chip);
  }
}

function patchFileDuration(file) {
  const el = queueList.querySelector(`.file-item[data-file-path="${CSS.escape(file.path)}"]`);
  if (el) el.querySelector('.file-duration').textContent = formatDuration(file.duration);
}

function patchFileStatus(filePath, status) {
  const el = queueList.querySelector(`.file-item[data-file-path="${CSS.escape(filePath)}"]`);
  if (el) {
    const icon = el.querySelector('.file-status-icon');
    icon.className = `file-status-icon status-${status}`;
    icon.textContent = statusIcon(status);
    icon.title = status;
  }
}

// Re-renders a single file-item's mode badge in place once the pipeline
// resolves whether a detected pair actually fused (or fell back to
// Mode 1 on a duration mismatch — see pipeline.js's pairing check).
function patchFileMode(filePath, mode, findFile) {
  const file = findFile(filePath);
  if (file) file.resolvedMode = mode;
  const el = queueList.querySelector(`.file-item[data-file-path="${CSS.escape(filePath)}"]`);
  if (!el || !file) return;
  const main = el.querySelector('.file-item-main');
  const existing = main.querySelector('.file-mode-badge');
  const badge = buildModeBadge(file);
  if (existing) existing.replaceWith(...(badge ? [badge] : []));
  else if (badge) main.insertBefore(badge, main.querySelector('.file-duration'));
}

function patchFileFlags(filePath, flags, findFile) {
  const file = findFile(filePath);
  if (file) file.qcFlags = flags;
  const el = queueList.querySelector(`.file-item[data-file-path="${CSS.escape(filePath)}"]`);
  if (!el) return;
  const container = el.querySelector('.file-flags');
  renderFlagChips(container, flags);
  container.hidden = false;
}

// Appends (rather than replaces) the post-render loudness check emitted
// with 'file:done' — arrives after the QC flag chips from the earlier
// 'qc' event, so it always renders as a trailing chip. See docs/PLAN.md
// §4 Fase 2 acceptance: "el informe QC de salida aparece en la UI".
function patchFileVerify(filePath, verify, findFile) {
  if (!verify) return;
  const file = findFile(filePath);
  if (file) file.verify = verify;
  const el = queueList.querySelector(`.file-item[data-file-path="${CSS.escape(filePath)}"]`);
  if (!el) return;
  const container = el.querySelector('.file-flags');
  container.hidden = false;
  let chip = container.querySelector('.flag-chip-verify');
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'flag-chip-verify';
    container.appendChild(chip);
  }
  const ok = verify.badge === 'ok';
  chip.className = `flag-chip flag-chip-verify flag-${ok ? 'ok' : 'warn'}`;
  chip.textContent = verify.i != null ? `${ok ? '✓' : '⚠'} out ${verify.i.toFixed(1)} LUFS` : 'verify: n/a';
  chip.title = verify.tp != null ? `True peak: ${verify.tp.toFixed(1)} dBFS` : 'Loudness re-measure unavailable';
}

function findQueuedFile(filePath) {
  for (const [, group] of queue) {
    const f = group.files.find(f => f.path === filePath);
    if (f) return f;
  }
  return null;
}

// ── Context menu ──
const ctxMenu = document.getElementById('ctx-menu');
let ctxMenuFile = null;

function showContextMenu(x, y, filePath) {
  ctxMenuFile = filePath;
  ctxMenu.hidden = false;
  const mw = ctxMenu.offsetWidth || 160;
  const mh = ctxMenu.offsetHeight || 120;
  const left = Math.min(x, window.innerWidth - mw - 4);
  const top = Math.min(y, window.innerHeight - mh - 4);
  ctxMenu.style.left = `${left}px`;
  ctxMenu.style.top = `${top}px`;
}

function hideContextMenu() {
  ctxMenu.hidden = true;
  ctxMenuFile = null;
}

document.addEventListener('click', hideContextMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideContextMenu(); });

ctxMenu.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn || !ctxMenuFile) return;
  const action = btn.dataset.action;
  const fp = ctxMenuFile;
  hideContextMenu();

  if (action === 'remove') removeFile(fp);
  else if (action === 'move-up') moveFile(fp, -1);
  else if (action === 'move-down') moveFile(fp, 1);
  else if (action === 'open-finder') {
    if (window.api) window.api.shell.openPath(fp);
  } else if (action === 'spectrogram') {
    showSpectrogram(fp);
  }
});

// ── Spectrogram viewer (Fase 8c) ──
const spectrogramModal   = document.getElementById('spectrogram-modal');
const spectrogramTitle   = document.getElementById('spectrogram-title');
const spectrogramLoading = document.getElementById('spectrogram-loading');
const spectrogramImage   = document.getElementById('spectrogram-image');
const spectrogramClose   = document.getElementById('spectrogram-close');

async function showSpectrogram(filePath) {
  if (!window.api?.spectrogram) return;
  const name = filePath.split('/').pop();
  spectrogramTitle.textContent = `Spectrogram \u2014 ${name}`;
  spectrogramImage.hidden = true;
  spectrogramImage.src = '';
  spectrogramLoading.hidden = false;
  spectrogramLoading.textContent = 'Rendering spectrogram\u2026';
  spectrogramModal.hidden = false;

  const res = await window.api.spectrogram.generate(filePath);
  // The modal may have been closed (or re-opened for a different file)
  // while the render was in flight — don't clobber whatever's showing now.
  if (spectrogramModal.hidden || spectrogramTitle.textContent !== `Spectrogram \u2014 ${name}`) return;
  if (res?.path) {
    spectrogramImage.src = fileUrlFor(res.path);
    spectrogramImage.hidden = false;
    spectrogramLoading.hidden = true;
  } else {
    spectrogramLoading.textContent = `Failed to render spectrogram: ${res?.error ?? 'unknown error'}`;
  }
}

function hideSpectrogram() {
  spectrogramModal.hidden = true;
  spectrogramImage.src = '';
}

spectrogramClose.addEventListener('click', hideSpectrogram);
spectrogramModal.addEventListener('click', (e) => { if (e.target === spectrogramModal) hideSpectrogram(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !spectrogramModal.hidden) hideSpectrogram(); });

// ── QC report export (Fase 8d) ──
const btnQcReport = document.getElementById('btn-qc-report');

function collectFileSummaries() {
  const out = [];
  for (const group of queue.values()) {
    for (const f of group.files) {
      out.push({
        name: f.name,
        status: f.status,
        duration: f.duration ?? null,
        resolvedMode: f.resolvedMode ?? null,
        pairPath: f.pairPath ?? null,
        qcFlags: f.qcFlags ?? [],
        verify: f.verify ?? null,
        outputPath: completedFiles.get(f.path) ?? null,
        errorMsg: f.errorMsg ?? null,
      });
    }
  }
  return out;
}

btnQcReport.addEventListener('click', async () => {
  if (!window.api?.qc) return;
  const summaries = collectFileSummaries();
  if (!summaries.length) return;
  const res = await window.api.qc.saveReport(summaries);
  if (res?.path) {
    btnQcReport.textContent = '\u2713';
    setTimeout(() => { btnQcReport.textContent = '\uD83D\uDCC4'; }, 1500);
  } else if (res?.error) {
    console.error('Failed to save QC report:', res.error);
  }
});

// ── Drag & drop ──
queueContainer.addEventListener('dragover', e => {
  e.preventDefault();
  e.stopPropagation();
  queueContainer.classList.add('drag-over');
});

queueContainer.addEventListener('dragleave', e => {
  if (!queueContainer.contains(e.relatedTarget)) {
    queueContainer.classList.remove('drag-over');
  }
});

queueContainer.addEventListener('drop', async e => {
  e.preventDefault();
  e.stopPropagation();
  queueContainer.classList.remove('drag-over');
  if (!window.api) return;

  const folderPaths = [];
  const audioFileInfos = [];

  for (const item of e.dataTransfer.items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file?.path) continue;
    const entry = item.webkitGetAsEntry();
    if (entry?.isDirectory) {
      folderPaths.push(file.path);
    } else if (isAudioFileName(file.name)) {
      audioFileInfos.push({ path: file.path, name: file.name, size: file.size });
    }
  }

  if (folderPaths.length) await processFolderPaths(folderPaths);
  if (audioFileInfos.length) addIndividualFiles(audioFileInfos);
});

// ── Progress bar ──
const progressSection  = document.getElementById('progress-section');
const progressFilename = document.getElementById('progress-filename');
const progressStep     = document.getElementById('progress-step');
const progressFill     = document.getElementById('progress-fill');
const progressPercent  = document.getElementById('progress-percent');
const progressEta      = document.getElementById('progress-eta');

// ── Processing state ──
let processing = false;
let unsubPipeline = null;

// ── Embedded Adobe Enhance stage (runs before the mastering queue) ──
const enhanceBanner     = document.getElementById('enhance-banner');
const enhanceBannerText = document.getElementById('enhance-banner-text');
let enhanceTotal = 0;
let enhanceDone = 0;
let enhanceLimitTimer = null;

// Maps the engine's state contract (shared verbatim with
// adobe-podcast-batch — Spanish values) to this UI's labels.
const ENHANCE_STATE_LABELS = {
  'subiendo': 'Uploading to Adobe',
  'procesando': 'Processing on Adobe',
  'descargando': 'Downloading clean voice',
  'listo': 'Done',
  'error': 'Error',
  'esperando': 'Waiting for Adobe credits',
  'en cola': 'Queued',
  'en espera': 'Queued',
};

function setEnhanceProgress(filename, stateLabel, pct) {
  const overall = enhanceTotal ? Math.round((enhanceDone / enhanceTotal) * 100) : 0;
  progressFill.style.width = `${overall}%`;
  progressPercent.textContent = `${overall}%`;
  progressStep.textContent = `Adobe Enhance \u00b7 ${stateLabel}${pct ? ` ${pct}%` : ''}`;
  if (filename) progressFilename.textContent = filename;
  progressEta.textContent = `${enhanceDone}/${enhanceTotal} enhanced`;
}

function showEnhanceLimit(seconds) {
  let remain = seconds;
  const tick = () => {
    if (remain <= 0) { hideEnhanceLimit(); return; }
    const m = Math.floor(remain / 60), s = remain % 60;
    enhanceBannerText.textContent = `Out of Adobe credits \u2014 resuming in ${m}:${String(s).padStart(2, '0')}\u2026`;
    remain--;
  };
  enhanceBanner.hidden = false;
  clearInterval(enhanceLimitTimer);
  tick();
  enhanceLimitTimer = setInterval(tick, 1000);
}

function hideEnhanceLimit() {
  clearInterval(enhanceLimitTimer);
  enhanceLimitTimer = null;
  enhanceBanner.hidden = true;
}

function setProgress(pct, step, stepIndex, stepTotal, filename, eta) {
  progressFill.style.width = `${pct}%`;
  progressPercent.textContent = `${pct}%`;
  progressStep.textContent = `Step ${stepIndex}/${stepTotal} · ${step}`;
  if (filename) progressFilename.textContent = filename;
  progressEta.textContent = `ETA: ${formatEta(eta)}`;
}

function updateDoneBadge() {
  const count = completedFiles.size;
  badgeDone.textContent = count;
  badgeDone.hidden = count === 0;
}

function startProcessing() {
  if (processing || !window.api) return;
  processing = true;

  const files = [];
  for (const [, group] of queue) {
    for (const file of group.files) {
      if (file.status !== 'done') {
        files.push({ path: file.path, duration: file.duration, ...(file.pairPath ? { pairPath: file.pairPath } : {}) });
      }
    }
  }
  if (!files.length) { processing = false; return; }

  btnProcessAll.textContent = 'Cancel';
  btnProcessAll.classList.replace('btn-accent', 'btn-secondary');
  btnAddFolders.disabled = true;
  btnAddFiles.disabled = true;

  const firstStepTotal = (files[0].pairPath && prefs.fusionEnabled !== false) ? 5 : 4;
  progressSection.hidden = false;
  setProgress(0, 'Starting…', 1, firstStepTotal, files[0].path.split('/').pop(), null);

  unsubPipeline = window.api.pipeline.onEvent(handlePipelineEvent);

  window.api.pipeline.start(files).catch(err => {
    console.error('Pipeline start error:', err);
    finishProcessing();
  });
}

function cancelProcessing() {
  if (!processing || !window.api) return;
  window.api.pipeline.cancel();
  finishProcessing();
}

function finishProcessing() {
  processing = false;
  if (unsubPipeline) { unsubPipeline(); unsubPipeline = null; }

  btnProcessAll.textContent = '▶ Process All';
  btnProcessAll.classList.replace('btn-secondary', 'btn-accent');
  btnAddFolders.disabled = false;
  btnAddFiles.disabled = false;

  progressSection.hidden = true;
  hideEnhanceLimit();
  renderQueue();
}

function handlePipelineEvent(event) {
  const filename = event.file ? event.file.split('/').pop() : '';

  switch (event.type) {
    case 'enhance:start':
      enhanceTotal = event.total;
      enhanceDone = 0;
      setEnhanceProgress(null, 'Starting\u2026');
      break;

    case 'enhance:status': {
      patchFileStatus(event.file, 'processing');
      const f = findQueuedFile(event.file);
      if (f) f.status = 'processing';
      setEnhanceProgress(filename, ENHANCE_STATE_LABELS[event.state] ?? event.state, event.pct);
      break;
    }

    case 'enhance:done': {
      enhanceDone++;
      if (event.ok && event.enhancedPath) {
        const f = findQueuedFile(event.file);
        if (f) f.pairPath = event.enhancedPath;
        // Refresh the badge: the file now has a pair and will fuse as Mode 2.
        patchFileMode(event.file, undefined, findQueuedFile);
        // The EQ editor's 3-way A/B keys off pairPath — let it re-read the queue.
        notifyQueueChanged();
      }
      setEnhanceProgress(filename, event.ok ? 'Done' : 'Error');
      break;
    }

    case 'enhance:limit':
      showEnhanceLimit(event.seconds);
      break;

    case 'enhance:limit-clear':
      hideEnhanceLimit();
      break;

    case 'enhance:auth-expired':
      enhanceBanner.hidden = false;
      enhanceBannerText.textContent = 'Adobe session expired \u2014 reconnect from Settings and run again.';
      break;

    case 'enhance:batch-done':
      hideEnhanceLimit();
      break;

    case 'file:start':
      patchFileStatus(event.file, 'processing');
      for (const [, group] of queue) {
        const f = group.files.find(f => f.path === event.file);
        if (f) f.status = 'processing';
      }
      break;

    case 'progress':
      setProgress(event.pct, event.step, event.stepIndex, event.stepTotal, filename, event.eta);
      break;

    case 'qc':
      patchFileMode(event.file, event.mode, findQueuedFile);
      patchFileFlags(event.file, event.flags, findQueuedFile);
      break;

    case 'file:done':
      patchFileStatus(event.file, 'done');
      patchFileMode(event.file, event.mode, findQueuedFile);
      patchFileVerify(event.file, event.verify, findQueuedFile);
      for (const [, group] of queue) {
        const f = group.files.find(f => f.path === event.file);
        if (f) f.status = 'done';
      }
      completedFiles.set(event.file, event.outputPath);
      updateDoneBadge();
      notifyQueueChanged();
      btnRemoveDone.hidden = false;
      break;

    case 'file:error':
      patchFileStatus(event.file, 'error');
      for (const [, group] of queue) {
        const f = group.files.find(f => f.path === event.file);
        if (f) { f.status = 'error'; f.errorMsg = event.error; }
      }
      window.api?.log.push('renderer', `File error displayed: ${filename}`, event.error);
      break;

    case 'batch:done':
      finishProcessing();
      break;

    case 'error':
      console.error('Pipeline error:', event.error);
      window.api?.log.push('renderer', 'Pipeline global error', event.error);
      finishProcessing();
      break;
  }
}

// ── Settings panel ──
const btnSettings   = document.getElementById('btn-settings');
const settingsPanel = document.getElementById('settings-panel');

const setHpf           = document.getElementById('set-hpf');
const setDeEsser       = document.getElementById('set-deesser');
const setFormat        = document.getElementById('set-format');
const setSampleRate    = document.getElementById('set-samplerate');
const hpfValue         = document.getElementById('hpf-value');

const toolbarPreset    = document.getElementById('toolbar-preset');
const setCompression   = document.getElementById('set-compression');
const setDenoise       = document.getElementById('set-denoise');
const setBody          = document.getElementById('set-body');
const bodyValue        = document.getElementById('body-value');
const setAirExtra      = document.getElementById('set-air-extra');
const setTrimSilence   = document.getElementById('set-trim-silence');
const setNormalize     = document.getElementById('set-normalize');
const setFusionEnabled = document.getElementById('set-fusion-enabled');
const setFusionMode    = document.getElementById('set-fusion-mode');
const setFusionCrossover     = document.getElementById('set-fusion-crossover');
const fusionCrossoverValue   = document.getElementById('fusion-crossover-value');
const setFusionOriginal      = document.getElementById('set-fusion-original');
const fusionOriginalValue    = document.getElementById('fusion-original-value');
const setEnhanceEnabled  = document.getElementById('set-enhance-enabled');
const setEnhanceMix      = document.getElementById('set-enhance-mix');
const enhanceMixValue    = document.getElementById('enhance-mix-value');
const adobeDot           = document.getElementById('adobe-dot');
const adobeConnText      = document.getElementById('adobe-conn-text');
const btnAdobeConnect    = document.getElementById('btn-adobe-connect');
const btnAdobeDisconnect = document.getElementById('btn-adobe-disconnect');

btnSettings.addEventListener('click', () => {
  const open = !settingsPanel.hidden;
  settingsPanel.hidden = open;
  btnSettings.setAttribute('aria-expanded', String(!open));
});

function applySettingsUI(p) {
  setHpf.value = p.hpfFrequency ?? 80;
  hpfValue.textContent = `${setHpf.value} Hz`;
  setDeEsser.checked = p.deEsserEnabled === true;
  setFormat.value = p.outputFormat ?? 'wav24';
  setSampleRate.value = String(p.sampleRate ?? 48000);
  applyOutputDirUI(p.customOutputDir || '');

  toolbarPreset.value = p.platformPreset ?? 'platzi';
  setCompression.value = p.compressionMode ?? 'auto';
  setDenoise.value = p.denoiseMode ?? 'auto';
  setBody.value = p.bodyPct ?? 0;
  bodyValue.textContent = `${setBody.value}%`;
  setAirExtra.checked = p.airExtraEnabled === true;
  setTrimSilence.checked = p.trimSilence !== false;
  setNormalize.value = p.normalizeMode ?? 'both';
  setFusionEnabled.checked = p.fusionEnabled !== false;
  setFusionMode.value = p.fusionMode ?? 'bands';
  setFusionCrossover.value = p.fusionCrossoverHz ?? 200;
  fusionCrossoverValue.textContent = `${setFusionCrossover.value} Hz`;
  setFusionOriginal.value = p.fusionOriginalPct ?? 20;
  fusionOriginalValue.textContent = `${setFusionOriginal.value}%`;
  setEnhanceEnabled.checked = p.enhanceEnabled === true;
  setEnhanceMix.value = p.enhanceMixPct ?? 100;
  enhanceMixValue.textContent = `${setEnhanceMix.value}%`;
}

function savePref(key, value) {
  prefs[key] = value;
  if (window.api) window.api.store.set(key, value);
}

setHpf.addEventListener('input', () => {
  const v = parseInt(setHpf.value);
  hpfValue.textContent = `${v} Hz`;
  savePref('hpfFrequency', v);
});

setDeEsser.addEventListener('change', () => savePref('deEsserEnabled', setDeEsser.checked));
setFormat.addEventListener('change', () => savePref('outputFormat', setFormat.value));
setSampleRate.addEventListener('change', () => savePref('sampleRate', parseInt(setSampleRate.value)));

toolbarPreset.addEventListener('change', () => savePref('platformPreset', toolbarPreset.value));
setCompression.addEventListener('change', () => savePref('compressionMode', setCompression.value));
setDenoise.addEventListener('change', () => savePref('denoiseMode', setDenoise.value));
setBody.addEventListener('input', () => {
  const v = parseInt(setBody.value);
  bodyValue.textContent = `${v}%`;
  savePref('bodyPct', v);
});
setAirExtra.addEventListener('change', () => savePref('airExtraEnabled', setAirExtra.checked));
setTrimSilence.addEventListener('change', () => savePref('trimSilence', setTrimSilence.checked));
setNormalize.addEventListener('change', () => savePref('normalizeMode', setNormalize.value));
setFusionEnabled.addEventListener('change', () => savePref('fusionEnabled', setFusionEnabled.checked));
setFusionMode.addEventListener('change', () => savePref('fusionMode', setFusionMode.value));
setFusionCrossover.addEventListener('input', () => {
  const v = parseInt(setFusionCrossover.value);
  fusionCrossoverValue.textContent = `${v} Hz`;
  savePref('fusionCrossoverHz', v);
});
setFusionOriginal.addEventListener('input', () => {
  const v = parseInt(setFusionOriginal.value);
  fusionOriginalValue.textContent = `${v}%`;
  savePref('fusionOriginalPct', v);
});
setEnhanceEnabled.addEventListener('change', () => savePref('enhanceEnabled', setEnhanceEnabled.checked));
setEnhanceMix.addEventListener('input', () => {
  const v = parseInt(setEnhanceMix.value);
  enhanceMixValue.textContent = `${v}%`;
  savePref('enhanceMixPct', v);
});

// ── Adobe connection (embedded Enhance) ──
// The token's identity field is sometimes a real email and sometimes an
// opaque AdobeID GUID (e.g. "4E67…@AdobeID") — only a real email is worth
// showing; the GUID goes in the tooltip instead of cluttering the row.
function adobeDisplayName(email) {
  if (typeof email === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return email;
  return 'Connected';
}

function refreshAdobeConn(status) {
  const connected = status?.connected === true;
  adobeDot.classList.toggle('on', connected);
  adobeConnText.textContent = connected ? adobeDisplayName(status.email) : 'Not connected';
  adobeConnText.title = connected && status.email ? status.email : '';
  btnAdobeConnect.textContent = connected ? 'Reconnect' : 'Connect';
  btnAdobeDisconnect.hidden = !connected;
}

if (window.api?.adobe) {
  window.api.adobe.status().then(refreshAdobeConn).catch(() => {});
  window.api.adobe.onConn(refreshAdobeConn);
  btnAdobeConnect.addEventListener('click', async () => {
    btnAdobeConnect.disabled = true;
    btnAdobeConnect.textContent = 'Opening\u2026';
    try {
      refreshAdobeConn(await window.api.adobe.connect());
    } finally {
      btnAdobeConnect.disabled = false;
    }
  });
  btnAdobeDisconnect.addEventListener('click', async () => {
    refreshAdobeConn(await window.api.adobe.disconnect());
  });
}

// ── Event listeners — toolbar / empty state ──
btnAddFolders.addEventListener('click', addFoldersViaDialog);
btnAddFiles.addEventListener('click', addFilesViaDialog);
btnClearAll.addEventListener('click', clearAll);
btnRemoveDone.addEventListener('click', removeCompleted);

// ── Custom output directory ──
const btnOutputDir    = document.getElementById('btn-output-dir');
const btnOutputLabel  = document.getElementById('btn-output-label');
const btnOutputReset  = document.getElementById('btn-output-reset');
const btnOpenOutput   = document.getElementById('btn-open-output');

function applyOutputDirUI(dir) {
  prefs.customOutputDir = dir || '';
  if (dir) {
    const parts = dir.split('/').filter(Boolean);
    const tail = parts.slice(-2).join('/');
    btnOutputLabel.textContent = `Output: ${tail || dir}`;
    btnOutputDir.title = `Output folder: ${dir}\nClick to change`;
    btnOutputReset.hidden = false;
    btnOpenOutput.hidden = false;
  } else {
    btnOutputLabel.textContent = 'Output: Default';
    btnOutputDir.title = 'Choose where processed files are saved. Default writes to Audio_Pro/ next to each source folder.';
    btnOutputReset.hidden = true;
    btnOpenOutput.hidden = true;
  }
}

btnOutputDir.addEventListener('click', async () => {
  const chosen = await window.api.output.chooseDir();
  if (chosen) applyOutputDirUI(chosen);
});

btnOutputReset.addEventListener('click', async () => {
  await window.api.store.set('customOutputDir', '');
  applyOutputDirUI('');
});

btnOpenOutput.addEventListener('click', () => window.api.output.openDir());

// ── Copy Log button ──
const btnCopyLog = document.getElementById('btn-copy-log');
btnCopyLog.addEventListener('click', async () => {
  try {
    const log = await window.api.log.getFormatted();
    await navigator.clipboard.writeText(log);
    // Flash the button to confirm
    btnCopyLog.textContent = '\u2713';
    btnCopyLog.style.color = 'var(--accent)';
    setTimeout(() => {
      btnCopyLog.textContent = '\uD83D\uDCCB';
      btnCopyLog.style.color = '';
    }, 1500);
  } catch (err) {
    console.error('Failed to copy log:', err);
  }
});

document.getElementById('btn-empty-folders').addEventListener('click', addFoldersViaDialog);
document.getElementById('btn-empty-files').addEventListener('click', addFilesViaDialog);

btnProcessAll.addEventListener('click', () => {
  if (processing) cancelProcessing();
  else startProcessing();
});

// ── Queue exposed to the EQ editor ──
// Derives from the live `queue` Map so the EQ preview can play any
// queued source file — not only after processing finishes. The optional
// `output` field tells the editor a processed version also exists.
window.audioProQueue = {
  listFiles() {
    const out = [];
    for (const group of queue.values()) {
      for (const f of group.files) {
        out.push({
          name: f.name,
          path: f.path,
          pairPath: f.pairPath ?? null,
          output: completedFiles.get(f.path),
        });
      }
    }
    return out;
  },
};

function notifyQueueChanged() {
  window.dispatchEvent(new CustomEvent('audiopro:queue-changed'));
}

// ── Self-update (⟳ pill in the titlebar) ──
// Mirrors HyperPremiere's ⟳: shows the current version, checks GitHub on
// launch and every 30 minutes, and highlights when a newer version is on
// the repo. Click = update + relaunch when one is available, otherwise
// re-check + reload the window.
const btnUpdate = document.getElementById('btn-update');
const updateIcon = document.getElementById('update-icon');
const versionLabel = document.getElementById('version-label');
let updateAvailable = false;

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;

if (window.api?.update) {
  window.api.update.getVersion().then(v => {
    if (!v) return;
    if (versionLabel) versionLabel.textContent = 'v' + v;
    const aboutVersion = document.getElementById('about-version');
    if (aboutVersion) aboutVersion.textContent = 'v' + v;
  }).catch(() => {});

  const checkForUpdate = async () => {
    try {
      const res = await window.api.update.check();
      if (!res) return;
      if (res.ok && res.changed) {
        updateAvailable = true;
        btnUpdate.classList.add('has-update');
        versionLabel.textContent = `v${res.current} \u2192 v${res.remote}`;
        btnUpdate.title = `New version v${res.remote} available on GitHub \u2014 click to update and relaunch.`;
      } else {
        updateAvailable = false;
        btnUpdate.classList.remove('has-update');
        if (res.ok && res.current) versionLabel.textContent = 'v' + res.current;
        btnUpdate.title = res.ok
          ? 'Up to date \u2014 click to re-check GitHub and reload'
          : `Update check failed: ${res.error ?? 'unknown'} \u2014 click to retry`;
      }
    } catch { /* offline or IPC unavailable — keep the pill quiet */ }
  };
  checkForUpdate();
  setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);

  btnUpdate.addEventListener('click', async () => {
    if (btnUpdate.disabled) return;
    btnUpdate.disabled = true;
    updateIcon.classList.add('spinning');
    try {
      if (updateAvailable) {
        btnUpdate.title = 'Downloading and applying the update\u2026';
        const unsubProgress = window.api.update.onProgress?.(({ percent }) => {
          versionLabel.textContent = `downloading ${percent}%`;
        });
        const res = await window.api.update.apply();
        unsubProgress?.();
        if (res?.ok && res.changed) {
          versionLabel.textContent = 'v' + res.version;
          btnUpdate.title = 'Updated \u2014 relaunching\u2026';
          await window.api.update.relaunch();
          return; // app is about to exit
        }
        if (res?.ok) {
          // Someone else already updated us, or remote rolled back — re-check.
          updateAvailable = false;
          btnUpdate.classList.remove('has-update');
          btnUpdate.title = `Already on the latest (v${res.version}).`;
        } else {
          btnUpdate.title = `Update failed: ${res?.error ?? 'unknown'} \u2014 click to retry`;
          window.api.log?.push('update', 'Update failed', res?.error);
        }
      } else {
        await checkForUpdate();
        if (!updateAvailable) {
          // Nothing new — plain reload, useful to recover a wedged renderer.
          window.location.reload();
          return;
        }
        btnUpdate.title = `New version found \u2014 click again to update.`;
      }
    } finally {
      btnUpdate.disabled = false;
      updateIcon.classList.remove('spinning');
    }
  });
}

// ── Init ──
loadPrefs();
renderQueue();
