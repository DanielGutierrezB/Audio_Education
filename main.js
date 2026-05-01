const { app, BrowserWindow, ipcMain, dialog, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Store = require('electron-store');
const pipeline = require('./src/pipeline');

const store = new Store({
  defaults: {
    processingMode: 'quality',
    lufsTarget: -16,
    hpfFrequency: 80,
    deEsserEnabled: true,
    parallelFiles: 1,
    customEqPresets: [],
    showNotifications: true,
  },
});

function createWindow() {
  const win = new BrowserWindow({
    width: 960,
    height: 600,
    minWidth: 720,
    minHeight: 450,
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

ipcMain.handle('store:get', (_, key) => store.get(key));
ipcMain.handle('store:set', (_, key, value) => store.set(key, value));
ipcMain.handle('store:getAll', () => store.store);

ipcMain.handle('folders:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const result = await dialog.showOpenDialog(win, {
    title: 'Select folders containing WAV files',
    properties: ['openDirectory', 'multiSelections'],
  });
  return result.canceled ? [] : result.filePaths;
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
    mode: store.get('processingMode'),
    lufsTarget: store.get('lufsTarget'),
    hpfFrequency: store.get('hpfFrequency'),
    deEsserEnabled: store.get('deEsserEnabled'),
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
    if (!state?.cancelled && Notification.isSupported()) {
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

ipcMain.handle('ffprobe:metadata', (_, filePath) => {
  return new Promise(resolve => {
    const proc = spawn('ffprobe', [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      filePath,
    ]);
    let out = '';
    proc.stdout.on('data', chunk => { out += chunk; });
    proc.on('close', code => {
      if (code !== 0) return resolve(null);
      try {
        const data = JSON.parse(out);
        const duration = parseFloat(data.format?.duration);
        resolve(isNaN(duration) ? null : { duration });
      } catch {
        resolve(null);
      }
    });
    proc.on('error', () => resolve(null));
  });
});
