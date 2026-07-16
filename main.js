const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const Store = require('electron-store');
const pipeline = require('./src/pipeline');
const binPaths = require('./src/bin-paths');
const logger = require('./src/logger');
const pairing = require('./src/pairing');
const fusion = require('./src/fusion');
const spectrogram = require('./src/spectrogram');
const qcReport = require('./src/qc-report');
const updater = require('./src/updater');
const adobeAuth = require('./src/adobe-auth');
const enhanceBatch = require('./src/enhance/batch');
const { DELIVERY_PRESETS, DEFAULT_PRESET } = require('./src/presets');

// Adobe processes ~5 tracks per account concurrently — same ceiling the
// standalone `adobe-podcast-batch` uses.
const ENHANCE_CONCURRENCY = 5;

const VALID_STORE_KEYS = new Set([
  'hpfFrequency', 'deEsserEnabled',
  'outputFormat', 'sampleRate', 'showNotifications',
  // Manual EQ override (FFmpeg filter chain string + on/off flag).
  // When manualEqApply is true the pipeline uses manualEqChain in place
  // of the built-in base EQ.
  'manualEqChain', 'manualEqApply',
  // Custom output directory ('' = default sibling Audio_Pro/ next to source).
  'customOutputDir',
  // Delivery target (docs/PLAN.md §2.3).
  'platformPreset',
  // Dynamics / tone extras (docs/PLAN.md §2.6).
  'denoiseMode', 'compressionMode', 'bodyPct', 'airExtraEnabled', 'trimSilence', 'normalizeMode',
  // Mode 2 fusion — original + Adobe Podcast Enhance 100% (docs/PLAN.md §2.4).
  'fusionEnabled', 'fusionMode', 'fusionCrossoverHz', 'fusionOriginalPct',
  // Embedded Adobe Enhance (docs/PLAN.md §3.1 Nivel 2 / Fase 10).
  'enhanceEnabled', 'enhanceMixPct',
]);

const ENUM_VALUES = {
  platformPreset:  Object.keys(DELIVERY_PRESETS),
  denoiseMode:     ['auto', 'off'],
  compressionMode: ['auto', 'off'],
  normalizeMode:   ['both', 'raiseOnly'],
  fusionMode:      ['bands', 'bed', 'bands_bed'],
};
const RANGE_VALUES = {
  bodyPct:           [0, 100],
  fusionCrossoverHz: [80, 500],
  fusionOriginalPct: [0, 40],
  enhanceMixPct:     [0, 100],
};

const store = new Store({
  defaults: {
    hpfFrequency: 80,
    deEsserEnabled: false,
    outputFormat: 'wav24',
    sampleRate: 48000,
    showNotifications: true,
    manualEqChain: '',
    manualEqApply: false,
    customOutputDir: '',
    platformPreset: DEFAULT_PRESET,
    denoiseMode: 'auto',
    compressionMode: 'auto',
    bodyPct: 0,
    airExtraEnabled: false,
    trimSilence: true,
    normalizeMode: 'both',
    fusionEnabled: true,
    fusionMode: 'bands',
    fusionCrossoverHz: 200,
    fusionOriginalPct: 20,
    enhanceEnabled: false,
    enhanceMixPct: 100,
  },
});

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 640,
    minWidth: 760,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    transparent: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  logger.init();
  logger.push('bin', `ffmpeg: ${binPaths.ffmpeg()}`);
  logger.push('bin', `ffprobe: ${binPaths.ffprobe()}`);
  createWindow();
  // Restore the Adobe session (embedded Enhance). Only attempt the
  // silent refresh when a token was ever stored — never open the hidden
  // podcast.adobe.com window for users who don't use the feature.
  if (adobeAuth.loadStoredToken()) {
    adobeAuth.silentReauth().then(tok => {
      if (!tok) return;
      logger.push('enhance', `Adobe session restored: ${adobeAuth.tokenEmail()}`);
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('adobe:conn', { connected: true, email: adobeAuth.tokenEmail() });
      }
    });
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (pipelineState) {
    pipelineState.cancelled = true;
    pipelineState.currentProc?.kill('SIGTERM');
  }
  for (const f of previewTempFiles) {
    try { fs.unlinkSync(f); } catch { /* best effort */ }
  }
});

// ── Logger IPC ──
ipcMain.handle('log:getFormatted', () => logger.formatForClipboard());
ipcMain.handle('log:push', (_, category, message, data) => {
  const cat = String(category ?? 'renderer').slice(0, 32);
  const msg = String(message ?? '').slice(0, 500);
  const d = data !== undefined ? String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 2000) : undefined;
  logger.push(cat, msg, d);
});

ipcMain.handle('store:get', (_, key) => store.get(key));
ipcMain.handle('store:set', (_, key, value) => {
  if (typeof key !== 'string' || !VALID_STORE_KEYS.has(key)) return;
  const BOOL_KEYS = new Set([
    'deEsserEnabled', 'showNotifications', 'manualEqApply',
    'airExtraEnabled', 'trimSilence', 'fusionEnabled', 'enhanceEnabled',
  ]);
  const STRING_KEYS = new Set(['outputFormat', 'manualEqChain', 'customOutputDir']);
  const INT_KEYS = new Set(['hpfFrequency', 'sampleRate', 'bodyPct', 'fusionCrossoverHz', 'fusionOriginalPct', 'enhanceMixPct']);
  if (BOOL_KEYS.has(key) && typeof value !== 'boolean') return;
  if (STRING_KEYS.has(key) && typeof value !== 'string') return;
  if (INT_KEYS.has(key) && (typeof value !== 'number' || !Number.isFinite(value))) return;
  if (ENUM_VALUES[key] && !ENUM_VALUES[key].includes(value)) return;
  if (RANGE_VALUES[key]) {
    const [lo, hi] = RANGE_VALUES[key];
    if (value < lo || value > hi) return;
  }
  if (key === 'manualEqChain') {
    if (value.length > 4096) return;
    if (/[`$;&|<>\\\n\r]/.test(value)) return;
  }
  if (key === 'customOutputDir') {
    if (value !== '' && (!path.isAbsolute(value) || value.includes('..') || value.length > 1024)) return;
  }
  store.set(key, value);
});
ipcMain.handle('store:getAll', () => store.store);

ipcMain.handle('folders:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Select folders containing WAV files',
    properties: ['openDirectory', 'multiSelections'],
  });
  if (!result.canceled) logger.push('files', `Folders selected: ${result.filePaths.length}`, result.filePaths);
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('files:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Select audio files',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'Audio Files', extensions: pairing.AUDIO_EXTS.map(e => e.slice(1)) }],
  });
  if (result.canceled) return [];
  return result.filePaths.map(filePath => {
    try {
      const { size } = fs.statSync(filePath);
      return { path: filePath, name: path.basename(filePath), size };
    } catch { return null; }
  }).filter(Boolean);
});

ipcMain.handle('shell:openPath', (_, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return;
  const resolved = path.resolve(filePath);
  if (resolved !== filePath && resolved !== path.normalize(filePath)) return;
  if (filePath.includes('..')) return;
  shell.showItemInFolder(resolved);
});

ipcMain.handle('output:chooseDir', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose output folder for processed audio',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const chosen = result.filePaths[0];
  if (!path.isAbsolute(chosen) || chosen.length > 1024) return null;
  store.set('customOutputDir', chosen);
  logger.push('settings', `Custom output dir set: ${chosen}`);
  return chosen;
});

ipcMain.handle('output:openDir', () => {
  const dir = store.get('customOutputDir');
  if (typeof dir !== 'string' || !dir) return false;
  if (!fs.existsSync(dir)) return false;
  shell.openPath(dir);
  return true;
});

// Scans a dropped/selected folder for audio files and auto-detects Mode 2
// candidates via the `adobe-podcast-batch` `Enhanced/` convention
// (docs/PLAN.md §2.1, §2.4, §3). Originals that pair with an enhanced
// counterpart carry a `pairPath`; everything else queues as Mode 1.
ipcMain.handle('folders:scan', (_, folderPath) => {
  if (typeof folderPath !== 'string' || !folderPath || folderPath.includes('..')) return [];
  try {
    const { pairs, singles } = pairing.findPairs(folderPath);
    const paired = pairs.map(({ original, enhanced }) => ({ ...original, pairPath: enhanced.path }));
    const result = [...paired, ...singles];
    if (pairs.length) {
      logger.push('files', `Mode 2 pairs detected in ${folderPath}: ${pairs.length}`, pairs.map(p => path.basename(p.original.path)));
    }
    return result;
  } catch {
    return [];
  }
});

// ── Adobe session (embedded Enhance — docs/PLAN.md §3.1 Nivel 2) ──

ipcMain.handle('adobe:status', () => ({
  connected: !!adobeAuth.getToken(),
  email: adobeAuth.tokenEmail(),
}));

ipcMain.handle('adobe:connect', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const tok = await adobeAuth.connectInteractive(win);
  if (tok) logger.push('enhance', `Adobe connected: ${adobeAuth.tokenEmail()}`);
  return { connected: !!tok, email: adobeAuth.tokenEmail() };
});

ipcMain.handle('adobe:disconnect', () => {
  adobeAuth.clearToken();
  logger.push('enhance', 'Adobe session cleared');
  return { connected: false, email: null };
});

// ── Pipeline ──

let pipelineState = null;

// Stage 0 of the batch when "Enhance with Adobe" is on: uploads every
// file that arrived WITHOUT an Enhanced/ pair to Adobe Podcast, saves
// the 100% clean voice to Enhanced/<stem>.wav (plus the optional local
// dry/wet mix in Enhanced/Mix <pct>/) and attaches it as the file's
// pairPath so the regular Mode 2 fusion + mastering chain takes over.
// Files that already had a pair (or a leftover Enhanced/ file on disk)
// skip the upload — no Adobe credits are spent twice.
async function runEnhanceStage(files, emit) {
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
          logger.push('enhance', `${data.ok ? '✓' : '✗'} ${path.basename(data.file)}${data.reused ? ' (reused existing Enhanced/)' : ''}`, data.error ?? data.enhancedPath);
        }
        if (type === 'enhance:limit') logger.push('enhance', `Adobe credits exhausted — waiting ${data.seconds}s`);
      },
      getToken: () => adobeAuth.getToken(),
      reauth: async () => {
        const tok = await adobeAuth.silentReauth();
        if (tok) {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send('adobe:conn', { connected: true, email: adobeAuth.tokenEmail() });
          }
        }
        return tok;
      },
      isCanceled: () => pipelineState?.cancelled ?? false,
      ffmpeg: binPaths.ffmpeg(),
    }
  );

  const failed = new Set();
  for (const f of targets) {
    const res = results.get(f.path);
    if (res?.ok && res.enhancedPath) {
      f.pairPath = res.enhancedPath;
    } else if (!(pipelineState?.cancelled)) {
      failed.add(f.path);
      emit('file:error', { file: f.path, error: `Adobe Enhance failed: ${res?.error ?? 'unknown'}` });
    }
  }
  emit('enhance:batch-done', { total: targets.length, failed: failed.size });
  return files.filter(f => !failed.has(f.path));
}

ipcMain.handle('pipeline:start', (event, files) => {
  if (pipelineState?.running) return { error: 'Already processing' };
  if (!Array.isArray(files) || files.length === 0 || files.length > 10000) {
    return { error: 'Invalid files list' };
  }
  for (const f of files) {
    if (typeof f?.path !== 'string' || !f.path || f.path.includes('..')) {
      return { error: 'Invalid file path in list' };
    }
    if (f.pairPath !== undefined && (typeof f.pairPath !== 'string' || !f.pairPath || f.pairPath.includes('..'))) {
      return { error: 'Invalid pair path in list' };
    }
  }

  const win = BrowserWindow.fromWebContents(event.sender);
  const settings = {
    hpfFrequency:      store.get('hpfFrequency'),
    deEsserEnabled:    store.get('deEsserEnabled'),
    outputFormat:      store.get('outputFormat'),
    sampleRate:        store.get('sampleRate'),
    manualEqChain:     store.get('manualEqChain'),
    manualEqApply:     store.get('manualEqApply'),
    customOutputDir:   store.get('customOutputDir'),
    platformPreset:    store.get('platformPreset'),
    denoiseMode:       store.get('denoiseMode'),
    compressionMode:   store.get('compressionMode'),
    bodyPct:           store.get('bodyPct'),
    airExtraEnabled:   store.get('airExtraEnabled'),
    trimSilence:       store.get('trimSilence'),
    normalizeMode:     store.get('normalizeMode'),
    fusionEnabled:     store.get('fusionEnabled'),
    fusionMode:        store.get('fusionMode'),
    fusionCrossoverHz: store.get('fusionCrossoverHz'),
    fusionOriginalPct: store.get('fusionOriginalPct'),
  };

  pipelineState = { running: true, cancelled: false, currentProc: null };

  const pairedCount = files.filter(f => f.pairPath).length;
  logger.push('pipeline', `Starting batch: ${files.length} files (${pairedCount} Mode 2 pairs)`, {
    outputFormat: settings.outputFormat,
    sampleRate: settings.sampleRate,
    manualEq: settings.manualEqApply,
    platformPreset: settings.platformPreset,
  });

  const emit = (type, data) => {
    if (!win.isDestroyed()) win.webContents.send('pipeline:event', { type, ...data });
    if (type === 'file:start') logger.push('pipeline', `▶ Processing: ${data.file}`, `${data.index + 1}/${data.total}`);
    if (type === 'file:done') logger.push('pipeline', `✓ Done: ${data.file} [Mode ${data.mode}]`, `→ ${data.outputPath}`);
    if (type === 'file:error') logger.push('pipeline', `✗ Error: ${data.file}`, data.error);
    if (type === 'loudness') logger.push('loudness', data.message, path.basename(data.file));
    if (type === 'qc') logger.push('qc', `Flags for ${path.basename(data.file)} [Mode ${data.mode}]`, data.flags.map(f => f.code).join(', ') || 'none');
    if (type === 'progress' && data.stepIndex !== undefined) {
      const stepKey = `${data.file}:${data.stepIndex}`;
      if (!emit._loggedSteps) emit._loggedSteps = new Set();
      if (!emit._loggedSteps.has(stepKey)) {
        emit._loggedSteps.add(stepKey);
        logger.push('pipeline', `  Step ${data.stepIndex}/${data.stepTotal}: ${data.step}`, path.basename(data.file));
      }
    }
    if (type === 'batch:done') logger.push('pipeline', `Batch complete: ${data.done}/${data.total} files`);
  };

  const enhanceEnabled = store.get('enhanceEnabled') === true;

  (async () => {
    const queueFiles = enhanceEnabled ? await runEnhanceStage(files, emit) : files;
    if (pipelineState?.cancelled) {
      emit('batch:done', { total: files.length, done: 0 });
      return;
    }
    if (!queueFiles.length) {
      emit('batch:done', { total: files.length, done: 0 });
      return;
    }
    await pipeline.processQueue(queueFiles, {
      emit,
      isCancelled: () => pipelineState?.cancelled ?? false,
      setCurrent: proc => { if (pipelineState) pipelineState.currentProc = proc; },
      settings,
    });
  })().catch(err => {
    logger.push('pipeline', `Batch error: ${err.message}`);
    emit('error', { error: err.message });
  }).finally(() => {
    const state = pipelineState;
    pipelineState = null;
    if (!state?.cancelled && store.get('showNotifications') && Notification.isSupported()) {
      new Notification({
        title: 'AudioPro',
        body: `Processing complete — ${files.length} file${files.length !== 1 ? 's' : ''} saved to Audio_Pro/`,
      }).show();
    }
  });

  return { ok: true };
});

ipcMain.handle('pipeline:cancel', () => {
  if (pipelineState) {
    logger.push('pipeline', 'Processing cancelled by user');
    pipelineState.cancelled = true;
    pipelineState.currentProc?.kill();
  }
});

// ── EQ preview helpers: spectrogram, fusion 3-way A/B, QC report export ──
// (docs/PLAN.md §4 Fase 8). Spectrogram and fusion preview write disposable
// files under a dedicated temp subfolder — unlike the pipeline's real
// output, none of this is meant to persist, so before-quit sweeps it up.

const previewTempFiles = new Set();

function previewTempDir() {
  const dir = path.join(os.tmpdir(), 'audiopro-previews');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function forgetAndUnlink(filePath) {
  previewTempFiles.delete(filePath);
  try { fs.unlinkSync(filePath); } catch { /* already gone or never existed */ }
}

ipcMain.handle('spectrogram:generate', async (_, filePath) => {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('..')) return { error: 'Invalid file path' };
  const outPath = path.join(previewTempDir(), `spec-${crypto.randomBytes(6).toString('hex')}.png`);
  previewTempFiles.add(outPath);
  try {
    await spectrogram.generateSpectrogram(filePath, outPath);
    logger.push('spectrogram', `Generated spectrogram for ${path.basename(filePath)}`);
    return { path: outPath };
  } catch (err) {
    forgetAndUnlink(outPath);
    logger.push('spectrogram', `Failed for ${path.basename(filePath)}`, err.message);
    return { error: err.message };
  }
});

// Caches the last fusion preview per original file so re-selecting
// "Fusion" in the EQ tab's 3-way A/B doesn't re-render on every click —
// a fusion settings change (crossover, strategy, original %) invalidates
// it automatically since the cache key is a hash of those settings.
const fusionPreviewCache = new Map(); // originalPath -> { key, path }

ipcMain.handle('fusion:preview', async (_, originalPath, pairPath) => {
  if (typeof originalPath !== 'string' || !originalPath || originalPath.includes('..')) return { error: 'Invalid file path' };
  if (typeof pairPath !== 'string' || !pairPath || pairPath.includes('..')) return { error: 'Invalid pair path' };

  const settings = {
    fusionMode:        store.get('fusionMode'),
    fusionCrossoverHz: store.get('fusionCrossoverHz'),
    fusionOriginalPct: store.get('fusionOriginalPct'),
  };
  const key = JSON.stringify(settings);
  const cached = fusionPreviewCache.get(originalPath);
  if (cached && cached.key === key && fs.existsSync(cached.path)) {
    return { path: cached.path };
  }

  const outPath = path.join(previewTempDir(), `fusion-${crypto.randomBytes(6).toString('hex')}.wav`);
  try {
    await fusion.runFusion(originalPath, pairPath, outPath, settings);
    previewTempFiles.add(outPath);
    if (cached) forgetAndUnlink(cached.path);
    fusionPreviewCache.set(originalPath, { key, path: outPath });
    logger.push('fusion', `Preview rendered for ${path.basename(originalPath)}`, settings);
    return { path: outPath };
  } catch (err) {
    forgetAndUnlink(outPath);
    logger.push('fusion', `Preview failed for ${path.basename(originalPath)}`, err.message);
    return { error: err.message };
  }
});

ipcMain.handle('qc:saveReport', async (event, fileSummaries) => {
  if (!Array.isArray(fileSummaries) || fileSummaries.length > 10000) return { error: 'Invalid file list' };
  const win = BrowserWindow.fromWebContents(event.sender);
  const markdown = qcReport.buildQcReportMarkdown(fileSummaries);
  const result = await dialog.showSaveDialog(win, {
    title: 'Export QC report',
    defaultPath: qcReport.defaultReportFilename(),
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  });
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    fs.writeFileSync(result.filePath, markdown, 'utf8');
    logger.push('qc', `Report exported: ${result.filePath}`, `${fileSummaries.length} files`);
    return { path: result.filePath };
  } catch (err) {
    return { error: err.message };
  }
});

// ── Self-update (⟳ button in the titlebar) ──
// The app checks the GitHub repo's version and updates itself in place —
// same pattern as HyperPremiere's ⟳. With asar disabled, __dirname is the
// live app root both in dev (repo checkout) and packaged (Resources/app),
// so the updater reads and writes the exact files this process runs from.

ipcMain.handle('app:getVersion', () => app.getVersion());

ipcMain.handle('update:check', async () => {
  const res = await updater.checkUpdate(__dirname);
  if (res.ok && res.changed) {
    logger.push('update', `Nueva versión disponible: v${res.current} → v${res.remote}`);
  } else if (!res.ok) {
    logger.push('update', `Chequeo de actualización falló: ${res.error}`);
  }
  return res;
});

let updateInFlight = false;
ipcMain.handle('update:apply', async () => {
  if (updateInFlight) return { ok: false, error: 'Ya hay una actualización en curso' };
  if (pipelineState?.running) return { ok: false, error: 'Hay un lote procesándose — esperá a que termine antes de actualizar' };
  updateInFlight = true;
  try {
    logger.push('update', 'Aplicando actualización desde GitHub…');
    const res = await updater.applyUpdate(__dirname);
    if (res.ok && res.changed) {
      logger.push('update', `Actualizado: v${res.previous} → v${res.version}. Reiniciando…`);
    } else if (res.ok) {
      logger.push('update', `Ya en la última versión (v${res.version}).`);
    } else {
      logger.push('update', `Actualización falló: ${res.error}`);
    }
    return res;
  } finally {
    updateInFlight = false;
  }
});

ipcMain.handle('update:relaunch', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('ffprobe:metadata', (_, filePath) => {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('..')) return null;
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 15_000);
    const done = (val) => { clearTimeout(timer); resolve(val); };
    const proc = spawn(binPaths.ffprobe(), [
      '-v', 'quiet', '-print_format', 'json', '-show_format', filePath,
    ]);
    let out = '';
    proc.stdout.on('data', chunk => { out += chunk; });
    proc.on('close', code => {
      if (code !== 0) return done(null);
      try {
        const data = JSON.parse(out);
        const duration = parseFloat(data.format?.duration);
        done(isNaN(duration) ? null : { duration });
      } catch {
        done(null);
      }
    });
    proc.on('error', () => done(null));
  });
});
