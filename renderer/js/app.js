'use strict';

// ── DOM refs ──
const tabs           = document.querySelectorAll('.tab');
const views          = document.querySelectorAll('.view');
const btnAddFolders  = document.getElementById('btn-add-folders');
const btnProcessAll  = document.getElementById('btn-process-all');
const queueEmpty     = document.getElementById('queue-empty');
const queueList      = document.getElementById('queue-list');
const queueSummary   = document.getElementById('queue-summary');
const queueContainer = document.querySelector('.queue-container');

// ── State ──
// Map<folderPath, { files: Array<{ path, name, size, duration, status }> }>
const queue = new Map();

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

function statusLabel(status) {
  const map = { queued: 'Queued', processing: 'Processing…', done: 'Done ✓', error: 'Error ✗' };
  return map[status] ?? status;
}

// ── Queue management ──
async function addFoldersViaDialog() {
  if (!window.api) return;
  const paths = await window.api.folders.open();
  if (paths.length) await processFolderPaths(paths);
}

async function processFolderPaths(folderPaths) {
  const added = [];
  for (const fp of folderPaths) {
    if (queue.has(fp)) continue;
    const wavFiles = await window.api.folders.scan(fp);
    if (!wavFiles.length) continue;
    queue.set(fp, {
      files: wavFiles.map(f => ({ ...f, duration: null, status: 'queued' })),
    });
    added.push(fp);
  }
  if (!added.length) return;
  renderQueue();
  for (const fp of added) loadFolderMetadata(fp);
}

async function loadFolderMetadata(folderPath) {
  const group = queue.get(folderPath);
  if (!group || !window.api) return;
  for (const file of group.files) {
    const meta = await window.api.ffprobe.getMetadata(file.path);
    if (meta?.duration != null) {
      file.duration = meta.duration;
      patchFileDuration(file);
    }
  }
}

function removeFolder(folderPath) {
  queue.delete(folderPath);
  renderQueue();
}

// ── Render ──
function renderQueue() {
  const hasFiles = queue.size > 0;
  queueEmpty.hidden = hasFiles;
  queueList.hidden = !hasFiles;
  btnProcessAll.disabled = !hasFiles;

  if (!hasFiles) {
    queueList.innerHTML = '';
    queueSummary.textContent = '';
    return;
  }

  queueList.innerHTML = '';
  for (const [fp, group] of queue) {
    queueList.appendChild(buildFolderGroup(fp, group));
  }

  let total = 0;
  for (const g of queue.values()) total += g.files.length;
  const f = total === 1 ? 'file' : 'files';
  const d = queue.size === 1 ? 'folder' : 'folders';
  queueSummary.textContent = `${total} ${f} in ${queue.size} ${d}`;
}

function buildFolderGroup(folderPath, group) {
  const wrap = document.createElement('div');
  wrap.className = 'folder-group';
  wrap.dataset.folder = folderPath;

  const header = document.createElement('div');
  header.className = 'folder-group-header';

  const icon = document.createElement('span');
  icon.className = 'folder-icon';
  icon.textContent = '📁';

  const pathSpan = document.createElement('span');
  pathSpan.className = 'folder-path';
  pathSpan.title = folderPath;
  pathSpan.textContent = folderPath;

  const count = document.createElement('span');
  count.className = 'folder-count';
  count.textContent = `${group.files.length} file${group.files.length !== 1 ? 's' : ''}`;

  const removeBtn = document.createElement('button');
  removeBtn.className = 'btn-remove-folder';
  removeBtn.title = 'Remove this folder from the queue';
  removeBtn.textContent = '✕';
  removeBtn.addEventListener('click', () => removeFolder(folderPath));

  header.append(icon, pathSpan, count, removeBtn);
  wrap.appendChild(header);

  const fileList = document.createElement('div');
  fileList.className = 'file-list';
  for (const file of group.files) fileList.appendChild(buildFileItem(file));
  wrap.appendChild(fileList);

  return wrap;
}

function buildFileItem(file) {
  const item = document.createElement('div');
  item.className = 'file-item';
  item.dataset.filePath = file.path;

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

  const status = document.createElement('span');
  status.className = `file-status status-${file.status}`;
  status.textContent = statusLabel(file.status);

  item.append(name, dur, size, status);
  return item;
}

function patchFileDuration(file) {
  for (const el of queueList.querySelectorAll('.file-item')) {
    if (el.dataset.filePath === file.path) {
      el.querySelector('.file-duration').textContent = formatDuration(file.duration);
      return;
    }
  }
}

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

  const paths = [];
  for (const item of e.dataTransfer.items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry();
    if (entry?.isDirectory) {
      const file = item.getAsFile();
      if (file?.path) paths.push(file.path);
    }
  }
  if (paths.length) await processFolderPaths(paths);
});

// ── Event listeners ──
btnAddFolders.addEventListener('click', addFoldersViaDialog);

// ── Init ──
loadPrefs();
renderQueue();
