const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Store = require('electron-store');
const pipeline = require('./src/pipeline');
const binPaths = require('./src/bin-paths');
const logger = require('./src/logger');

const VALID_STORE_KEYS = new Set([
  'processingMode', 'lufsTarget', 'hpfFrequency', 'deEsserEnabled',
  'noiseGateEnabled', 'stereoToMonoEnabled', 'silenceTrimEnabled',
  'breathReductionEnabled', 'multiBandCompEnabled', 'outputFormat',
  'sampleRate', 'showNotifications',
  // Manual EQ override (FFmpeg filter chain string + on/off flag).
  // When manualEqApply is true the pipeline uses manualEqChain in place
  // of its built-in voice-warm EQ.
  'manualEqChain', 'manualEqApply',
  // Adaptive EQ — when ON, appends voice-profile-derived notches to the
  // static voice-warm EQ. OFF by default; the static curve is unchanged.
  'adaptiveEqEnabled',
  // Custom output directory ('' = default sibling Audio_Pro/ next to source)
  'customOutputDir',
]);

const store = new Store({
  defaults: {
    processingMode: 'quality',
    lufsTarget: -16,
    hpfFrequency: 80,
    deEsserEnabled: true,
    noiseGateEnabled: true,
    stereoToMonoEnabled: true,
    silenceTrimEnabled: true,
    breathReductionEnabled: false,
    multiBandCompEnabled: true,
    outputFormat: 'wav24',
    sampleRate: 48000,
    showNotifications: true,
    manualEqChain: '',
    manualEqApply: false,
    adaptiveEqEnabled: false,
    // Empty = sibling Audio_Pro/ behavior. Otherwise an absolute path.
    customOutputDir: '',
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
  logger.push('bin', `deep-filter: ${binPaths.deepFilter()}`);
  createWindow();
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
});

// ── Logger IPC ──
ipcMain.handle('log:getFormatted', () => logger.formatForClipboard());
ipcMain.handle('log:push', (_, category, message, data) => {
  // Cap renderer log input to prevent abuse
  const cat = String(category ?? 'renderer').slice(0, 32);
  const msg = String(message ?? '').slice(0, 500);
  const d = data !== undefined ? String(typeof data === 'string' ? data : JSON.stringify(data)).slice(0, 2000) : undefined;
  logger.push(cat, msg, d);
});

ipcMain.handle('store:get', (_, key) => store.get(key));
ipcMain.handle('store:set', (_, key, value) => {
  if (typeof key !== 'string' || !VALID_STORE_KEYS.has(key)) return;
  // Type-validate values to prevent store corruption
  const BOOL_KEYS = new Set(['deEsserEnabled', 'noiseGateEnabled', 'stereoToMonoEnabled',
    'silenceTrimEnabled', 'breathReductionEnabled', 'multiBandCompEnabled', 'showNotifications',
    'manualEqApply', 'adaptiveEqEnabled']);
  const STRING_KEYS = new Set(['processingMode', 'outputFormat', 'manualEqChain', 'customOutputDir']);
  const INT_KEYS = new Set(['lufsTarget', 'hpfFrequency', 'sampleRate']);
  if (BOOL_KEYS.has(key) && typeof value !== 'boolean') return;
  if (STRING_KEYS.has(key) && typeof value !== 'string') return;
  if (INT_KEYS.has(key) && (typeof value !== 'number' || !Number.isFinite(value))) return;
  // manualEqChain: cap length and reject obvious shell metacharacters that
  // could break out of the FFmpeg `-af` argument.
  if (key === 'manualEqChain') {
    if (value.length > 4096) return;
    if (/[`$;&|<>\\\n\r]/.test(value)) return;
  }
  // customOutputDir: empty (= default behavior) or an absolute path.
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
    title: 'Select WAV files',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'WAV Files', extensions: ['wav'] }],
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
  // Block path traversal — only allow absolute paths without .. components
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

ipcMain.handle('folders:scan', (_, folderPath) => {
  if (typeof folderPath !== 'string' || !folderPath || folderPath.includes('..')) return [];
  try {
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    return entries
      .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.wav'))
      .map(e => {
        const filePath = path.join(folderPath, e.name);
        const { size } = fs.statSync(filePath);
        return { path: filePath, name: e.name, size };
      });
  } catch {
    return [];
  }
});

// ── Pipeline ──

let pipelineState = null;

ipcMain.handle('pipeline:start', (event, files) => {
  if (pipelineState?.running) return { error: 'Already processing' };
  // Validate files array from renderer
  if (!Array.isArray(files) || files.length === 0 || files.length > 10000) {
    return { error: 'Invalid files list' };
  }
  for (const f of files) {
    if (typeof f?.path !== 'string' || !f.path || f.path.includes('..')) {
      return { error: 'Invalid file path in list' };
    }
  }

  const win = BrowserWindow.fromWebContents(event.sender);
  const settings = {
    mode:                  store.get('processingMode'),
    lufsTarget:            store.get('lufsTarget'),
    hpfFrequency:          store.get('hpfFrequency'),
    deEsserEnabled:        store.get('deEsserEnabled'),
    noiseGateEnabled:      store.get('noiseGateEnabled'),
    stereoToMonoEnabled:   store.get('stereoToMonoEnabled'),
    silenceTrimEnabled:    store.get('silenceTrimEnabled'),
    breathReductionEnabled:store.get('breathReductionEnabled'),
    multiBandCompEnabled:  store.get('multiBandCompEnabled'),
    outputFormat:          store.get('outputFormat'),
    sampleRate:            store.get('sampleRate'),
    manualEqChain:         store.get('manualEqChain'),
    manualEqApply:         store.get('manualEqApply'),
    adaptiveEqEnabled:     store.get('adaptiveEqEnabled'),
    customOutputDir:       store.get('customOutputDir'),
  };

  pipelineState = { running: true, cancelled: false, currentProc: null };

  logger.push('pipeline', `Starting batch: ${files.length} files`, {
    mode: settings.mode,
    lufsTarget: settings.lufsTarget,
    outputFormat: settings.outputFormat,
    sampleRate: settings.sampleRate,
  });

  const emit = (type, data) => {
    if (!win.isDestroyed()) win.webContents.send('pipeline:event', { type, ...data });
    // Log significant pipeline events
    if (type === 'file:start') logger.push('pipeline', `▶ Processing: ${data.file}`, `${data.index + 1}/${data.total}`);
    if (type === 'file:done') logger.push('pipeline', `✓ Done: ${data.file}`, `→ ${data.outputPath}`);
    if (type === 'file:error') logger.push('pipeline', `✗ Error: ${data.file}`, data.error);
    if (type === 'analysis') logger.push('analysis', `Analysis: ${data.file}`, data.recommendations?.reasoning);
    if (type === 'progress' && data.stepIndex !== undefined) {
      // Log step transitions (first progress event per step, identified by low pct or new step name)
      const stepKey = `${data.file}:${data.stepIndex}`;
      if (!emit._loggedSteps) emit._loggedSteps = new Set();
      if (!emit._loggedSteps.has(stepKey)) {
        emit._loggedSteps.add(stepKey);
        logger.push('pipeline', `  Step ${data.stepIndex}/${data.stepTotal}: ${data.step}`, path.basename(data.file));
      }
    }
    if (type === 'batch:done') logger.push('pipeline', `Batch complete: ${data.done}/${data.total} files`);
  };

  pipeline.processQueue(files, {
    emit,
    isCancelled: () => pipelineState?.cancelled ?? false,
    setCurrent: proc => { if (pipelineState) pipelineState.currentProc = proc; },
    settings,
  }).catch(err => {
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

ipcMain.handle('audio:peaks', (_, filePath, numPeaks) => {
  if (typeof filePath !== 'string' || !filePath || filePath.includes('..')) return null;
  if (typeof numPeaks !== 'number' || numPeaks < 10 || numPeaks > 10000) numPeaks = 800;
  logger.push('waveform', `Generating peaks: ${path.basename(filePath)} (${numPeaks} points)`);
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 30_000);
    const done = (val) => { clearTimeout(timer); resolve(val); };
    const probeProc = spawn(binPaths.ffprobe(), [
      '-v', 'quiet', '-print_format', 'json', '-show_format', filePath,
    ]);
    let probeOut = '';
    probeProc.stdout.on('data', c => { probeOut += c; });
    probeProc.on('close', code => {
      if (code !== 0) return done(null);
      let duration = 1;
      try { duration = parseFloat(JSON.parse(probeOut).format?.duration) || 1; } catch { /* ok */ }

      const rate = Math.max(50, Math.ceil(numPeaks / duration));
      const proc = spawn(binPaths.ffmpeg(), [
        '-i', filePath,
        '-af', `aresample=${rate}`,
        '-f', 'f32le', '-ac', '1', 'pipe:1',
      ]);
      const chunks = [];
      proc.stdout.on('data', chunk => chunks.push(chunk));
      proc.on('close', code2 => {
        if (code2 !== 0) return done(null);
        const buf = Buffer.concat(chunks);
        const count = Math.floor(buf.length / 4);
        const floats = new Float32Array(buf.buffer, buf.byteOffset, count);
        const step = Math.max(1, Math.floor(count / numPeaks));
        const peaks = [];
        for (let i = 0; i < numPeaks; i++) {
          let max = 0;
          for (let j = 0; j < step; j++) {
            const v = Math.abs(floats[i * step + j] ?? 0);
            if (v > max) max = v;
          }
          peaks.push(max);
        }
        done(peaks);
      });
      proc.on('error', (err) => { logger.push('waveform', `ffmpeg error: ${err.message}`); done(null); });
    });
    probeProc.on('error', (err) => { logger.push('waveform', `ffprobe error: ${err.message}`); done(null); });
  });
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
