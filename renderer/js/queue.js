'use strict';

// The file queue: adding, removing and reordering, selection, rendering the
// rows with their mode badge and QC chips, the right-click menu, drag & drop,
// and the view of the queue the EQ editor reads.

import {
  btnClearAll, btnClearSelection, btnProcessSelection, btnRemoveDone,
  btnRetryFailed, btnSelectAll,
  queueContainer, queueEmpty, queueList, queueSummary,
} from './dom.js';
import { completedFiles, isFinished, queue, selectedFiles, ui } from './state.js';
import { formatDuration, formatEta, formatSize, isAudioFileName, statusIcon } from './format.js';
import { showSpectrogram } from './qc-tools.js';

// ── Queue management ──
// Default queue order is by file name, natural/numeric so "10" follows "9"
// (not "1") and case doesn't matter. Applied when files enter the queue;
// manual Move up/down still overrides it afterwards.
function fileSortKey(f) {
  return f.name || (f.path || '').split(/[\\/]/).pop() || '';
}
function byFileName(a, b) {
  return fileSortKey(a).localeCompare(fileSortKey(b), undefined, { numeric: true, sensitivity: 'base' });
}

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
    const sorted = [...wavFiles].sort(byFileName);
    queue.set(fp, {
      files: sorted.map(f => ({ ...f, duration: null, status: 'queued' })),
      collapsed: false,
    });
    // New files start selected so the common "process everything" case still
    // works in one click; Clear selection + pick lets the user narrow it down.
    for (const f of sorted) selectedFiles.add(f.path);
    added.push(fp);
  }
  if (!added.length) return;
  renderQueue();
  for (const fp of added) loadFolderMetadata(fp);
}

function addIndividualFiles(fileInfos) {
  // Group by parent directory
  const touched = new Set();
  for (const fi of fileInfos) {
    const dir = fi.path.substring(0, fi.path.lastIndexOf('/'));
    if (!queue.has(dir)) {
      queue.set(dir, { files: [], collapsed: false });
    }
    const group = queue.get(dir);
    if (!group.files.find(f => f.path === fi.path)) {
      group.files.push({ ...fi, duration: null, status: 'queued' });
      selectedFiles.add(fi.path);
      touched.add(dir);
    }
  }
  // Keep each group that got new files ordered by name (natural sort).
  for (const dir of touched) queue.get(dir)?.files.sort(byFileName);
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
      if (isFinished(f.status)) { selectedFiles.delete(f.path); return false; }
      return true;
    });
    if (group.files.length === 0) queue.delete(fp);
  }
  renderQueue();
}

// ── Selection ──
// How many queued files are both selected and still processable (not done).
// This is what "Process Selection" acts on and what gates the button.
function processableSelectedCount() {
  let n = 0;
  for (const [, group] of queue) {
    for (const f of group.files) {
      if (!isFinished(f.status) && selectedFiles.has(f.path)) n++;
    }
  }
  return n;
}

function selectAllFiles() {
  for (const [, group] of queue) {
    for (const f of group.files) {
      if (!isFinished(f.status)) selectedFiles.add(f.path);
    }
  }
  renderQueue();
}

// Narrows the selection to just the files that failed, so a batch where two
// of forty errored can be re-run without hand-picking them or re-rendering
// the other thirty-eight. Also resets their status, since an 'error' row is
// otherwise still an error row after a successful re-run.
function selectFailedOnly() {
  selectedFiles.clear();
  for (const [, group] of queue) {
    for (const f of group.files) {
      if (f.status !== 'error') continue;
      selectedFiles.add(f.path);
      f.status = 'queued';
      f.errorMsg = null;
    }
  }
  renderQueue();
}

function clearSelection() {
  selectedFiles.clear();
  renderQueue();
}

// Keeps the process button + selection toolbar in sync with the current
// selection. Called from renderQueue and on every checkbox toggle.
function refreshSelectionControls() {
  const hasFiles = queue.size > 0;
  btnSelectAll.hidden = !hasFiles;
  btnClearSelection.hidden = !hasFiles;
  if (!ui.processing) btnProcessSelection.disabled = processableSelectedCount() === 0;
}

// ── Render queue ──
function renderQueue() {
  // Single source of truth for the EQ editor's file dropdown: every time
  // the queue is rendered (add/remove/reset), notify the editor.
  notifyQueueChanged();
  const hasFiles = queue.size > 0;
  queueEmpty.hidden = hasFiles;
  queueList.hidden = !hasFiles;
  btnClearAll.hidden = !hasFiles;
  refreshSelectionControls();

  const hasFailed = hasFiles && [...queue.values()].some(g => g.files.some(f => f.status === 'error'));
  btnRetryFailed.hidden = !hasFailed;

  const hasDone = hasFiles && [...queue.values()].some(g => g.files.some(f => isFinished(f.status)));
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
    badge.title = `Will fuse with ${file.pairPath.split('/').pop()} on Process Selection`;
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
    refreshSelectionControls();
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
  PAIR_MISMATCH: 'warn', PAIR_REALIGNED: 'warn',
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

// Measurements the file row doesn't show but the QC report needs: the source
// tilt and the input loudness behind the chips.
function patchFileMetrics(filePath, metrics, findFile) {
  const file = findFile(filePath);
  if (!file) return;
  if (metrics.tilt != null) file.tilt = metrics.tilt;
  if (metrics.loudnessIn) file.loudnessIn = metrics.loudnessIn;
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

export {
  addFoldersViaDialog,
  addFilesViaDialog,
  clearAll,
  removeCompleted,
  selectAllFiles,
  selectFailedOnly,
  clearSelection,
  renderQueue,
  findQueuedFile,
  notifyQueueChanged,
  patchFileStatus,
  patchFileMode,
  patchFileFlags,
  patchFileMetrics,
  patchFileVerify,
  FLAG_SEVERITY,
};
