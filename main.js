const { app, BrowserWindow, ipcMain, dialog, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Store = require('electron-store');
const pipeline = require('./src/pipeline');
const binPaths = require('./src/bin-paths');

const VALID_STORE_KEYS = new Set([
  'processingMode', 'lufsTarget', 'hpfFrequency', 'deEsserEnabled',
  'noiseGateEnabled', 'stereoToMonoEnabled', 'silenceTrimEnabled',
  'breathReductionEnabled', 'multiBandCompEnabled', 'outputFormat',
  'sampleRate', 'showNotifications',
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

ipcMain.handle('store:get', (_, key) => store.get(key));
ipcMain.handle('store:set', (_, key, value) => {
  if (typeof key !== 'string' || !VALID_STORE_KEYS.has(key)) return;
  store.set(key, value);
});
ipcMain.handle('store:getAll', () => store.store);

ipcMain.handle('folders:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Select folders containing WAV files',
    properties: ['openDirectory', 'multiSelections'],
  });
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
  shell.showItemInFolder(filePath);
});

ipcMain.handle('folders:scan', (_, folderPath) => {
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
  };

  pipelineState = { running: true, cancelled: false, currentProc: null };

  const emit = (type, data) => {
    if (!win.isDestroyed()) win.webContents.send('pipeline:event', { type, ...data });
  };

  pipeline.processQueue(files, {
    emit,
    isCancelled: () => pipelineState?.cancelled ?? false,
    setCurrent: proc => { if (pipelineState) pipelineState.currentProc = proc; },
    settings,
  }).catch(err => {
    emit('error', { error: err.message });
  }).finally(() => {
    const state = pipelineState;
    pipelineState = null;
    if (!state?.cancelled && store.get('showNotifications') && Notification.isSupported()) {
      const done = files.length;
      new Notification({
        title: 'AudioPro',
        body: `Processing complete — ${done} file${done !== 1 ? 's' : ''} saved to Audio_Pro/`,
      }).show();
    }
  });

  return { ok: true };
});

ipcMain.handle('pipeline:cancel', () => {
  if (pipelineState) {
    pipelineState.cancelled = true;
    pipelineState.currentProc?.kill();
  }
});

ipcMain.handle('audio:peaks', (_, filePath, numPeaks) => {
  if (typeof filePath !== 'string' || !filePath) return null;
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
      proc.on('error', () => done(null));
    });
    probeProc.on('error', () => done(null));
  });
});

ipcMain.handle('ffprobe:metadata', (_, filePath) => {
  if (typeof filePath !== 'string' || !filePath) return null;
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
