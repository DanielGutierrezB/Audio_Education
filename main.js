'use strict';

// Electron main process: window lifecycle and wiring. Every IPC channel lives
// in its own module under src/ipc/, grouped by what it touches — settings,
// files, the Adobe session, the batch, the EQ tab's previews, the updater.

const { app, BrowserWindow } = require('electron');
const path = require('path');
const Store = require('electron-store');

const settings = require('./src/settings');
const binPaths = require('./src/bin-paths');
const logger = require('./src/logger');

const storeIpc = require('./src/ipc/store');
const filesIpc = require('./src/ipc/files');
const adobeIpc = require('./src/ipc/adobe');
const pipelineIpc = require('./src/ipc/pipeline');
const previewIpc = require('./src/ipc/preview');
const updateIpc = require('./src/ipc/update');

const store = new Store({ defaults: settings.DEFAULTS });

const WINDOW = {
  width: 960,
  height: 640,
  minWidth: 760,
  minHeight: 520,
};

function createWindow() {
  const win = new BrowserWindow({
    ...WINDOW,
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
  return win;
}

for (const mod of [storeIpc, filesIpc, adobeIpc, pipelineIpc, previewIpc, updateIpc]) {
  mod.register({ store, appRoot: __dirname });
}

app.whenReady().then(() => {
  logger.init();
  logger.push('bin', `ffmpeg: ${binPaths.ffmpeg()}`);
  logger.push('bin', `ffprobe: ${binPaths.ffprobe()}`);
  createWindow();
  adobeIpc.restoreSession();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  pipelineIpc.shutdown();
  previewIpc.shutdown();
});
