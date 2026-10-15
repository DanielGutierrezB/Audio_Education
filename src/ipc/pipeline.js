'use strict';

// Batch orchestration from the renderer's side: validate the queue, optionally
// run the embedded Adobe Enhance stage, then hand off to src/pipeline.js and
// relay its events back to the window and the log.

const { ipcMain, BrowserWindow, Notification } = require('electron');
const path = require('path');

const pipeline = require('../pipeline');
const enhanceBatch = require('../enhance/batch');
const adobeAuth = require('../adobe-auth');
const binPaths = require('../bin-paths');
const logger = require('../logger');
const settings = require('../settings');
const adobeIpc = require('./adobe');

// Adobe processes ~5 tracks per account concurrently — the same ceiling the
// standalone `adobe-podcast-batch` uses.
const ENHANCE_CONCURRENCY = 5;
const MAX_QUEUE_FILES = 10000;

let state = null;

// The queue renders several files at once (src/pipeline.js processQueue), so a
// cancel has to reach every ffmpeg currently running, not just the most
// recently started one. Each stage reports its process as it starts and says
// which one ended as it exits — a bare null could not identify anything with
// several in flight.
function trackProc(proc, finished) {
  if (!state) return;
  if (proc) state.procs.add(proc);
  else if (finished) state.procs.delete(finished);
}

function killTrackedProcs(signal) {
  if (!state) return;
  for (const proc of state.procs) {
    try { proc.kill(signal); } catch { /* already gone */ }
  }
  state.procs.clear();
}

// Called from app before-quit so a batch doesn't outlive the window.
function shutdown() {
  if (!state) return;
  state.cancelled = true;
  killTrackedProcs('SIGTERM');
}

function validateQueue(files) {
  if (!Array.isArray(files) || files.length === 0 || files.length > MAX_QUEUE_FILES) {
    return 'Invalid files list';
  }
  for (const f of files) {
    if (typeof f?.path !== 'string' || !f.path || f.path.includes('..')) {
      return 'Invalid file path in list';
    }
    if (f.pairPath !== undefined && (typeof f.pairPath !== 'string' || !f.pairPath || f.pairPath.includes('..'))) {
      return 'Invalid pair path in list';
    }
  }
  return null;
}

// Stage 0 of the batch when "Enhance with Adobe" is on: uploads every file
// that arrived WITHOUT an Enhanced/ pair to Adobe Podcast, saves the 100%
// clean voice to Enhanced/<stem>.wav (plus the optional local dry/wet mix in
// Enhanced/Mix <pct>/) and attaches it as the file's pairPath so the regular
// Mode 2 fusion + mastering chain takes over. Files that already had a pair
// (or a leftover Enhanced/ file on disk) skip the upload — no Adobe credits
// are spent twice.
async function runEnhanceStage(files, emit, store) {
  const targets = files.filter(f => !f.pairPath);
  if (!targets.length) return files;

  if (!adobeAuth.getToken()) {
    throw new Error('"Enhance with Adobe" is on but there is no Adobe session — connect from Settings, or turn the toggle off.');
  }

  const mixPct = store.get('enhanceMixPct');
  emit('enhance:start', { total: targets.length, mixPct });
  logger.push('enhance', `Embedded enhance: ${targets.length} file(s) → Adobe Podcast`, `mix ${mixPct}%`);

  const results = await enhanceBatch.runEnhanceBatch(
    { files: targets.map(f => f.path), mixPct, concurrency: ENHANCE_CONCURRENCY },
    {
      send: (type, data) => {
        emit(type, data);
        if (type === 'enhance:done') {
          logger.push('enhance',
            `${data.ok ? '✓' : '✗'} ${path.basename(data.file)}${data.reused ? ' (reused existing Enhanced/)' : ''}`,
            data.error ?? data.enhancedPath);
        }
        if (type === 'enhance:limit') logger.push('enhance', `Adobe credits exhausted — waiting ${data.seconds}s`);
      },
      getToken: () => adobeAuth.getToken(),
      reauth: async () => {
        const tok = await adobeAuth.silentReauth();
        if (tok) adobeIpc.broadcastConnection();
        return tok;
      },
      isCanceled: () => state?.cancelled ?? false,
      ffmpeg: binPaths.ffmpeg(),
    }
  );

  const failed = new Set();
  for (const f of targets) {
    const res = results.get(f.path);
    if (res?.ok && res.enhancedPath) {
      f.pairPath = res.enhancedPath;
    } else if (!state?.cancelled) {
      failed.add(f.path);
      emit('file:error', { file: f.path, error: `Adobe Enhance failed: ${res?.error ?? 'unknown'}` });
    }
  }
  emit('enhance:batch-done', { total: targets.length, failed: failed.size });
  return files.filter(f => !failed.has(f.path));
}

// Relays pipeline events to the window and mirrors the interesting ones into
// the copyable log. Progress is logged once per step rather than per frame,
// which is why the seen-steps set lives here.
function makeEmitter(win) {
  const loggedSteps = new Set();
  return (type, data) => {
    if (!win.isDestroyed()) win.webContents.send('pipeline:event', { type, ...data });
    if (type === 'file:start') logger.push('pipeline', `▶ Processing: ${data.file}`, `${data.index + 1}/${data.total}`);
    if (type === 'file:done') logger.push('pipeline', `✓ Done: ${data.file} [Mode ${data.mode}]`, `→ ${data.outputPath}`);
    if (type === 'file:error') logger.push('pipeline', `✗ Error: ${data.file}`, data.error);
    if (type === 'loudness') logger.push('loudness', data.message, path.basename(data.file));
    if (type === 'qc') {
      logger.push('qc', `Flags for ${path.basename(data.file)} [Mode ${data.mode}]`,
        data.flags.map(f => f.code).join(', ') || 'none');
    }
    if (type === 'progress' && data.stepIndex !== undefined) {
      const stepKey = `${data.file}:${data.stepIndex}`;
      if (!loggedSteps.has(stepKey)) {
        loggedSteps.add(stepKey);
        logger.push('pipeline', `  Step ${data.stepIndex}/${data.stepTotal}: ${data.step}`, path.basename(data.file));
      }
    }
    if (type === 'batch:done') logger.push('pipeline', `Batch complete: ${data.done}/${data.total} files`);
  };
}

function register({ store }) {
  ipcMain.handle('pipeline:start', (event, files) => {
    if (state?.running) return { error: 'Already processing' };
    const invalid = validateQueue(files);
    if (invalid) return { error: invalid };

    const win = BrowserWindow.fromWebContents(event.sender);
    const runSettings = settings.pipelineSettings(store);
    state = { running: true, cancelled: false, procs: new Set() };

    const pairedCount = files.filter(f => f.pairPath).length;
    logger.push('pipeline', `Starting batch: ${files.length} files (${pairedCount} Mode 2 pairs)`, {
      outputFormat: runSettings.outputFormat,
      sampleRate: runSettings.sampleRate,
      manualEq: runSettings.manualEqApply,
      platformPreset: runSettings.platformPreset,
    });

    const emit = makeEmitter(win);
    const enhanceEnabled = store.get('enhanceEnabled') === true;

    (async () => {
      const queueFiles = enhanceEnabled ? await runEnhanceStage(files, emit, store) : files;
      if (state?.cancelled || !queueFiles.length) {
        emit('batch:done', { total: files.length, done: 0 });
        return;
      }
      await pipeline.processQueue(queueFiles, {
        emit,
        isCancelled: () => state?.cancelled ?? false,
        setCurrent: trackProc,
        settings: runSettings,
      });
    })().catch(err => {
      logger.push('pipeline', `Batch error: ${err.message}`);
      emit('error', { error: err.message });
    }).finally(() => {
      const finished = state;
      state = null;
      if (!finished?.cancelled && store.get('showNotifications') && Notification.isSupported()) {
        new Notification({
          title: 'AudioPro',
          body: `Processing complete — ${files.length} file${files.length !== 1 ? 's' : ''} saved to Audio_Pro/`,
        }).show();
      }
    });

    return { ok: true };
  });

  ipcMain.handle('pipeline:cancel', () => {
    if (!state) return;
    logger.push('pipeline', 'Processing cancelled by user');
    state.cancelled = true;
    killTrackedProcs();
  });
}

module.exports = { register, shutdown, validateQueue, isRunning: () => !!state?.running };
