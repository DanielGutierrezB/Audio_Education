'use strict';

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
  applyMode(prefs.processingMode ?? 'quality');
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

// ── Mode toggle ──
const modeQuality = document.getElementById('mode-quality');
const modeFast    = document.getElementById('mode-fast');
const modeAuto    = document.getElementById('mode-auto');

function applyMode(mode) {
  modeQuality.classList.toggle('active', mode === 'quality');
  modeFast.classList.toggle('active', mode === 'fast');
  modeAuto.classList.toggle('active', mode === 'auto');
}

modeQuality.addEventListener('click', () => {
  applyMode('quality');
  if (window.api) window.api.store.set('processingMode', 'quality');
  updateQueueSummary();
});
modeFast.addEventListener('click', () => {
  applyMode('fast');
  if (window.api) window.api.store.set('processingMode', 'fast');
  updateQueueSummary();
});
modeAuto.addEventListener('click', () => {
  applyMode('auto');
  if (window.api) window.api.store.set('processingMode', 'auto');
  updateQueueSummary();
});

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

  // Rough estimate: quality ≈ 0.75× realtime, fast ≈ 0.12× realtime
  const mode = modeQuality.classList.contains('active') ? 'quality' : 'fast';
  const mul = mode === 'quality' ? 0.75 : 0.12;
  const estSec = totalDuration > 0 ? Math.round(totalDuration * mul) : null;
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

function buildFileItem(file) {
  const item = document.createElement('div');
  item.className = 'file-item' + (selectedFiles.has(file.path) ? ' selected' : '');
  item.dataset.filePath = file.path;

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

  item.append(cb, statusEl, name, dur, size, removeBtn);

  // Right-click context menu
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, file.path);
  });

  return item;
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
  const wavFileInfos = [];

  for (const item of e.dataTransfer.items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file?.path) continue;
    const entry = item.webkitGetAsEntry();
    if (entry?.isDirectory) {
      folderPaths.push(file.path);
    } else if (file.name.toLowerCase().endsWith('.wav')) {
      wavFileInfos.push({ path: file.path, name: file.name, size: file.size });
    }
  }

  if (folderPaths.length) await processFolderPaths(folderPaths);
  if (wavFileInfos.length) addIndividualFiles(wavFileInfos);
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
      if (file.status !== 'done') files.push({ path: file.path, duration: file.duration });
    }
  }
  if (!files.length) { processing = false; return; }

  btnProcessAll.textContent = 'Cancel';
  btnProcessAll.classList.replace('btn-accent', 'btn-secondary');
  btnAddFolders.disabled = true;
  btnAddFiles.disabled = true;

  progressSection.hidden = false;
  setProgress(0, 'Starting…', 1, 6, files[0].path.split('/').pop(), null);

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
  renderQueue();
}

function handlePipelineEvent(event) {
  const filename = event.file ? event.file.split('/').pop() : '';

  switch (event.type) {
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

    case 'file:done':
      patchFileStatus(event.file, 'done');
      for (const [, group] of queue) {
        const f = group.files.find(f => f.path === event.file);
        if (f) f.status = 'done';
      }
      completedFiles.set(event.file, event.outputPath);
      updateDoneBadge();
      addToPreviewSelector(event.file, event.outputPath);
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

    case 'analysis':
      // Analysis complete — pipeline step text already reflects individual status updates
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

const setLufs          = document.getElementById('set-lufs');
const setHpf           = document.getElementById('set-hpf');
const setDeEsser       = document.getElementById('set-deesser');
const setNoiseGate     = document.getElementById('set-noisegate');
const setSilenceTrim   = document.getElementById('set-silencetrim');
const setBreathRed     = document.getElementById('set-breathreduction');
const setStereoMono    = document.getElementById('set-stereomono');
const setMBC           = document.getElementById('set-mbc');
const setAdaptiveEq    = document.getElementById('set-adaptive-eq');
const setFormat        = document.getElementById('set-format');
const setSampleRate    = document.getElementById('set-samplerate');
const lufsValue        = document.getElementById('lufs-value');
const hpfValue         = document.getElementById('hpf-value');

btnSettings.addEventListener('click', () => {
  const open = !settingsPanel.hidden;
  settingsPanel.hidden = open;
  btnSettings.setAttribute('aria-expanded', String(!open));
});

function applySettingsUI(p) {
  setLufs.value = p.lufsTarget ?? -16;
  lufsValue.textContent = `${setLufs.value} LUFS`;
  setHpf.value = p.hpfFrequency ?? 80;
  hpfValue.textContent = `${setHpf.value} Hz`;
  setDeEsser.checked = p.deEsserEnabled !== false;
  setNoiseGate.checked = p.noiseGateEnabled !== false;
  setSilenceTrim.checked = p.silenceTrimEnabled !== false;
  setBreathRed.checked = p.breathReductionEnabled === true;
  setStereoMono.checked = p.stereoToMonoEnabled !== false;
  setMBC.checked = p.multiBandCompEnabled !== false;
  setAdaptiveEq.checked = p.adaptiveEqEnabled === true;
  setFormat.value = p.outputFormat ?? 'wav24';
  setSampleRate.value = String(p.sampleRate ?? 48000);
  applyOutputDirUI(p.customOutputDir || '');
}

function savePref(key, value) {
  if (window.api) window.api.store.set(key, value);
}

setLufs.addEventListener('input', () => {
  const v = parseInt(setLufs.value);
  lufsValue.textContent = `${v} LUFS`;
  savePref('lufsTarget', v);
});

setHpf.addEventListener('input', () => {
  const v = parseInt(setHpf.value);
  hpfValue.textContent = `${v} Hz`;
  savePref('hpfFrequency', v);
});

setDeEsser.addEventListener('change', () => savePref('deEsserEnabled', setDeEsser.checked));
setNoiseGate.addEventListener('change', () => savePref('noiseGateEnabled', setNoiseGate.checked));
setSilenceTrim.addEventListener('change', () => savePref('silenceTrimEnabled', setSilenceTrim.checked));
setBreathRed.addEventListener('change', () => savePref('breathReductionEnabled', setBreathRed.checked));
setStereoMono.addEventListener('change', () => savePref('stereoToMonoEnabled', setStereoMono.checked));
setMBC.addEventListener('change', () => savePref('multiBandCompEnabled', setMBC.checked));
setAdaptiveEq.addEventListener('change', () => savePref('adaptiveEqEnabled', setAdaptiveEq.checked));
setFormat.addEventListener('change', () => savePref('outputFormat', setFormat.value));
setSampleRate.addEventListener('change', () => savePref('sampleRate', parseInt(setSampleRate.value)));

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

// ── Processed-files registry ──
// Tracks completed files so the EQ editor can list them in its file selector.
// Preview/playback lives in the EQ tab now (see eq-editor.js).
const processedFiles = [];

window.audioProQueue = {
  listFiles() {
    return processedFiles.map(f => ({
      name: f.name,
      path: f.filePath,
      output: f.outputPath,
    }));
  },
};

function addToPreviewSelector(filePath, outputPath) {
  const existing = processedFiles.find(f => f.filePath === filePath);
  if (existing) {
    existing.outputPath = outputPath;
  } else {
    const name = filePath.split('/').pop();
    processedFiles.push({ filePath, outputPath, name });
  }
  window.dispatchEvent(new CustomEvent('audiopro:queue-changed'));
}

// ── Init ──
loadPrefs();
renderQueue();
