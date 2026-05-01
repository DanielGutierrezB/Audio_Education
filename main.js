const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const Store = require('electron-store');

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
