'use strict';

// Running a batch: the progress bar, the embedded Adobe Enhance stage that
// precedes it, and the pipeline event stream that drives the file rows.

import {
  badgeDone, btnAddFiles, btnAddFolders, btnProcessSelection, btnRemoveDone,
} from './dom.js';
import { completedFiles, queue, selectedFiles, ui } from './state.js';
import { formatEta } from './format.js';
import {
  findQueuedFile, notifyQueueChanged, patchFileFlags, patchFileMode,
  patchFileMetrics, patchFileStatus, patchFileVerify, renderQueue,
} from './queue.js';
import { recordHistory } from './history.js';

// ── Progress bar ──
const progressSection  = document.getElementById('progress-section');
const progressFilename = document.getElementById('progress-filename');
const progressStep     = document.getElementById('progress-step');
const progressFill     = document.getElementById('progress-fill');
const progressPercent  = document.getElementById('progress-percent');
const progressEta      = document.getElementById('progress-eta');

// ── Processing state ──
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

// Several files render at once, so the bar tracks the whole batch rather than
// whichever file reported last — otherwise it jumps backwards every time a
// different worker checks in. Per-file state still lives on the file rows.
const inFlight = new Map(); // path -> { pct, step, eta }
let batchTotal = 0;

function resetProgressTracking(total) {
  inFlight.clear();
  batchTotal = total;
}

function noteFileFinished(filePath) {
  inFlight.delete(filePath);
}

function setProgress(event) {
  const { file, pct, step, eta } = event;
  inFlight.set(file, { pct, step, eta });

  const activeCount = inFlight.size;
  const finished = completedFiles.size;
  // Each in-flight file contributes its own fraction of one slot.
  const activeFraction = [...inFlight.values()].reduce((a, p) => a + (p.pct ?? 0) / 100, 0);
  const overall = batchTotal > 0
    ? Math.min(99, Math.round(((finished + activeFraction) / batchTotal) * 100))
    : pct;

  progressFill.style.width = `${overall}%`;
  progressPercent.textContent = `${overall}%`;
  progressStep.textContent = activeCount > 1
    ? `${finished}/${batchTotal} done · ${activeCount} in progress`
    : `${finished}/${batchTotal} done · ${step}`;
  progressFilename.textContent = activeCount > 1
    ? [...inFlight.keys()].map(p => p.split('/').pop()).join(', ')
    : (file || '').split('/').pop();
  // The slowest remaining worker is what the batch actually waits on.
  const etas = [...inFlight.values()].map(p => p.eta).filter(v => v != null);
  progressEta.textContent = `ETA: ${formatEta(etas.length ? Math.max(...etas) : eta)}`;
}

function updateDoneBadge() {
  const count = completedFiles.size;
  badgeDone.textContent = count;
  badgeDone.hidden = count === 0;
}

function startProcessing() {
  if (ui.processing || !window.api) return;
  ui.processing = true;

  const files = [];
  for (const [, group] of queue) {
    for (const file of group.files) {
      if (file.status !== 'done' && selectedFiles.has(file.path)) {
        files.push({ path: file.path, duration: file.duration, ...(file.pairPath ? { pairPath: file.pairPath } : {}) });
      }
    }
  }
  if (!files.length) { ui.processing = false; return; }

  btnProcessSelection.textContent = 'Cancel';
  btnProcessSelection.classList.replace('btn-accent', 'btn-secondary');
  btnAddFolders.disabled = true;
  btnAddFiles.disabled = true;

  progressSection.hidden = false;
  resetProgressTracking(files.length);
  setProgress({ file: files[0].path, pct: 0, step: 'Starting…', eta: null });

  unsubPipeline = window.api.pipeline.onEvent(handlePipelineEvent);

  window.api.pipeline.start(files).catch(err => {
    console.error('Pipeline start error:', err);
    finishProcessing();
  });
}

function cancelProcessing() {
  if (!ui.processing || !window.api) return;
  window.api.pipeline.cancel();
  finishProcessing();
}

function finishProcessing() {
  ui.processing = false;
  if (unsubPipeline) { unsubPipeline(); unsubPipeline = null; }

  btnProcessSelection.textContent = '▶ Process Selection';
  btnProcessSelection.classList.replace('btn-secondary', 'btn-accent');
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
      setProgress(event);
      break;

    case 'qc':
      patchFileMode(event.file, event.mode, findQueuedFile);
      patchFileFlags(event.file, event.flags, findQueuedFile);
      patchFileMetrics(event.file, event, findQueuedFile);
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
      noteFileFinished(event.file);
      updateDoneBadge();
      notifyQueueChanged();
      btnRemoveDone.hidden = false;
      recordHistory(event, 'done');
      break;

    case 'file:error':
      patchFileStatus(event.file, 'error');
      for (const [, group] of queue) {
        const f = group.files.find(f => f.path === event.file);
        if (f) { f.status = 'error'; f.errorMsg = event.error; }
      }
      noteFileFinished(event.file);
      window.api?.log.push('renderer', `File error displayed: ${filename}`, event.error);
      recordHistory(event, 'error');
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

export {
  startProcessing,
  cancelProcessing,
};
