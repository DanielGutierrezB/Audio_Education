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
const badgeDone      = document.getElementById('badge-done');

// ── State ──
// Map<folderPath, { files: Array<{ path, name, size, duration, status }> }>
const queue = new Map();
// Map<originalFilePath, outputPath> — populated on file:done
const completedFiles = new Map();

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

// ── Mode toggle ──
const modeQuality = document.getElementById('mode-quality');
const modeFast    = document.getElementById('mode-fast');

function applyMode(mode) {
  modeQuality.classList.toggle('active', mode === 'quality');
  modeFast.classList.toggle('active', mode === 'fast');
}

modeQuality.addEventListener('click', () => {
  applyMode('quality');
  if (window.api) window.api.store.set('processingMode', 'quality');
});
modeFast.addEventListener('click', () => {
  applyMode('fast');
  if (window.api) window.api.store.set('processingMode', 'fast');
});

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

// ── Render queue ──
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

// ── Progress bar refs ──
const progressSection  = document.getElementById('progress-section');
const progressFilename = document.getElementById('progress-filename');
const progressStep     = document.getElementById('progress-step');
const progressFill     = document.getElementById('progress-fill');
const progressPercent  = document.getElementById('progress-percent');
const progressEta      = document.getElementById('progress-eta');

// ── Processing state ──
let processing = false;
let unsubPipeline = null;

function formatEta(seconds) {
  if (seconds == null || isNaN(seconds) || seconds < 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function setProgress(pct, step, stepIndex, stepTotal, filename, eta) {
  progressFill.style.width = `${pct}%`;
  progressPercent.textContent = `${pct}%`;
  progressStep.textContent = `Step ${stepIndex}/${stepTotal} · ${step}`;
  if (filename) progressFilename.textContent = filename;
  progressEta.textContent = `ETA: ${formatEta(eta)}`;
}

function patchFileStatus(filePath, status) {
  for (const el of queueList.querySelectorAll('.file-item')) {
    if (el.dataset.filePath === filePath) {
      const span = el.querySelector('.file-status');
      span.className = `file-status status-${status}`;
      span.textContent = statusLabel(status);
      return;
    }
  }
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

  progressSection.hidden = false;
  setProgress(0, 'Starting…', 1, 4, files[0].path.split('/').pop(), null);

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

  progressSection.hidden = true;
}

function handlePipelineEvent(event) {
  const filename = event.file ? event.file.split('/').pop() : '';

  switch (event.type) {
    case 'file:start':
      patchFileStatus(event.file, 'processing');
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
      break;

    case 'file:error':
      patchFileStatus(event.file, 'error');
      for (const [, group] of queue) {
        const f = group.files.find(f => f.path === event.file);
        if (f) f.status = 'error';
      }
      break;

    case 'batch:done':
      finishProcessing();
      break;

    case 'error':
      console.error('Pipeline error:', event.error);
      finishProcessing();
      break;
  }
}

// ── Event listeners ──
btnAddFolders.addEventListener('click', addFoldersViaDialog);
btnProcessAll.addEventListener('click', () => {
  if (processing) cancelProcessing();
  else startProcessing();
});

// ── Preview ──
const previewEmpty    = document.getElementById('preview-empty');
const previewContent  = document.getElementById('preview-content');
const previewSelect   = document.getElementById('preview-file-select');
const audioOriginal   = document.getElementById('audio-original');
const audioProcessed  = document.getElementById('audio-processed');
const btnPlayOriginal = document.getElementById('play-original');
const btnPlayProcessed = document.getElementById('play-processed');
const timeOriginal    = document.getElementById('time-original');
const timeProcessed   = document.getElementById('time-processed');
const waveformOriginal  = document.getElementById('waveform-original');
const waveformProcessed = document.getElementById('waveform-processed');
const loadingOriginal   = document.getElementById('loading-original');
const loadingProcessed  = document.getElementById('loading-processed');

let currentPreviewFile = null;
// Map<filePath, { original: Float32Array|null, processed: Float32Array|null }>
const waveformCache = new Map();

function addToPreviewSelector(filePath, outputPath) {
  previewEmpty.hidden = true;
  previewContent.hidden = false;

  const opt = document.createElement('option');
  opt.value = filePath;
  opt.textContent = filePath.split('/').pop();
  opt.dataset.outputPath = outputPath;
  previewSelect.appendChild(opt);

  if (previewSelect.options.length === 1) {
    loadPreviewFile(filePath, outputPath);
  }
}

previewSelect.addEventListener('change', () => {
  const opt = previewSelect.selectedOptions[0];
  if (opt) loadPreviewFile(opt.value, opt.dataset.outputPath);
});

async function loadPreviewFile(filePath, outputPath) {
  currentPreviewFile = filePath;

  stopAudio(audioOriginal, btnPlayOriginal);
  stopAudio(audioProcessed, btnPlayProcessed);

  audioOriginal.src = `file://${filePath}`;
  audioProcessed.src = `file://${outputPath}`;
  timeOriginal.textContent = '0:00';
  timeProcessed.textContent = '0:00';

  await Promise.all([
    drawWaveformForFile('waveform-original', 'loading-original', filePath),
    drawWaveformForFile('waveform-processed', 'loading-processed', outputPath),
  ]);
}

async function drawWaveformForFile(canvasId, loadingId, filePath) {
  const canvas = document.getElementById(canvasId);
  const loading = document.getElementById(loadingId);

  loading.hidden = false;
  canvas.style.opacity = '0';

  sizeCanvas(canvas);
  const numPeaks = canvas.width;

  let peaks = waveformCache.get(filePath)?.[canvasId];
  if (!peaks && window.api) {
    peaks = await window.api.audio.peaks(filePath, numPeaks);
    const cached = waveformCache.get(filePath) ?? {};
    cached[canvasId] = peaks;
    waveformCache.set(filePath, cached);
  }

  loading.hidden = true;
  canvas.style.opacity = '1';

  if (peaks) drawPeaks(canvas, peaks);
}

function sizeCanvas(canvas) {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth || 400;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(72 * dpr);
  canvas.style.width = w + 'px';
  canvas.style.height = '72px';
}

function drawPeaks(canvas, peaks) {
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const mid = H / 2;

  ctx.clearRect(0, 0, W, H);

  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(74,143,232,0.9)');
  grad.addColorStop(1, 'rgba(74,143,232,0.4)');
  ctx.strokeStyle = grad;
  ctx.lineWidth = Math.max(1, W / peaks.length);

  const step = peaks.length / W;
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    const idx = Math.floor(x * step);
    const v = peaks[idx] ?? 0;
    ctx.moveTo(x + 0.5, mid - v * mid * 0.95);
    ctx.lineTo(x + 0.5, mid + v * mid * 0.95);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, mid);
  ctx.lineTo(W, mid);
  ctx.stroke();
}

function drawPlayhead(canvas, audio) {
  if (!audio.duration) return;
  const ctx = canvas.getContext('2d');
  const x = Math.floor(audio.currentTime / audio.duration * canvas.width);
  ctx.strokeStyle = 'rgba(255,255,255,0.7)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, canvas.height);
  ctx.stroke();
}

function setupAudioPlayer(audio, playBtn, timeEl, canvas) {
  let rafId = null;
  let imageData = null;

  function tick() {
    if (imageData) ctx().putImageData(imageData, 0, 0);
    drawPlayhead(canvas, audio);
    timeEl.textContent = formatAudioTime(audio.currentTime);
    if (!audio.paused) rafId = requestAnimationFrame(tick);
  }

  function ctx() { return canvas.getContext('2d'); }

  audio.addEventListener('loadedmetadata', () => {
    timeEl.textContent = `0:00 / ${formatAudioTime(audio.duration)}`;
  });

  audio.addEventListener('play', () => {
    imageData = ctx().getImageData(0, 0, canvas.width, canvas.height);
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(tick);
    playBtn.textContent = '⏸';
    playBtn.title = 'Pause';
  });

  audio.addEventListener('pause', () => {
    cancelAnimationFrame(rafId);
    if (imageData) ctx().putImageData(imageData, 0, 0);
    playBtn.textContent = '▶';
    playBtn.title = playBtn.id === 'play-original' ? 'Play original audio' : 'Play processed audio';
  });

  audio.addEventListener('ended', () => {
    cancelAnimationFrame(rafId);
    if (imageData) ctx().putImageData(imageData, 0, 0);
    playBtn.textContent = '▶';
    audio.currentTime = 0;
    timeEl.textContent = `0:00 / ${formatAudioTime(audio.duration)}`;
  });

  playBtn.addEventListener('click', () => {
    if (audio.paused) audio.play().catch(() => {});
    else audio.pause();
  });
}

function stopAudio(audio, playBtn) {
  audio.pause();
  audio.currentTime = 0;
  audio.src = '';
  playBtn.textContent = '▶';
}

function formatAudioTime(sec) {
  if (!sec || isNaN(sec)) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

setupAudioPlayer(audioOriginal, btnPlayOriginal, timeOriginal, waveformOriginal);
setupAudioPlayer(audioProcessed, btnPlayProcessed, timeProcessed, waveformProcessed);

// ── Init ──
loadPrefs();
renderQueue();
