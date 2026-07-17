const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  log: {
    getFormatted: () => ipcRenderer.invoke('log:getFormatted'),
    push: (category, message, data) => ipcRenderer.invoke('log:push', category, message, data),
  },
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    getAll: () => ipcRenderer.invoke('store:getAll'),
  },
  folders: {
    open: () => ipcRenderer.invoke('folders:open'),
    scan: (folderPath) => ipcRenderer.invoke('folders:scan', folderPath),
  },
  files: {
    open: () => ipcRenderer.invoke('files:open'),
  },
  shell: {
    openPath: (filePath) => ipcRenderer.invoke('shell:openPath', filePath),
  },
  output: {
    chooseDir: () => ipcRenderer.invoke('output:chooseDir'),
    openDir: () => ipcRenderer.invoke('output:openDir'),
  },
  ffprobe: {
    getMetadata: (filePath) => ipcRenderer.invoke('ffprobe:metadata', filePath),
  },
  spectrogram: {
    generate: (filePath) => ipcRenderer.invoke('spectrogram:generate', filePath),
  },
  fusion: {
    preview: (originalPath, pairPath) => ipcRenderer.invoke('fusion:preview', originalPath, pairPath),
  },
  qc: {
    saveReport: (fileSummaries) => ipcRenderer.invoke('qc:saveReport', fileSummaries),
  },
  adobe: {
    status: () => ipcRenderer.invoke('adobe:status'),
    connect: () => ipcRenderer.invoke('adobe:connect'),
    disconnect: () => ipcRenderer.invoke('adobe:disconnect'),
    onConn: (cb) => {
      const handler = (_, data) => cb(data);
      ipcRenderer.on('adobe:conn', handler);
      return () => ipcRenderer.removeListener('adobe:conn', handler);
    },
  },
  pipeline: {
    start: (files) => ipcRenderer.invoke('pipeline:start', files),
    cancel: () => ipcRenderer.invoke('pipeline:cancel'),
    onEvent: (cb) => {
      const handler = (_, event) => cb(event);
      ipcRenderer.on('pipeline:event', handler);
      return () => ipcRenderer.removeListener('pipeline:event', handler);
    },
  },
  update: {
    getVersion: () => ipcRenderer.invoke('app:getVersion'),
    check: () => ipcRenderer.invoke('update:check'),
    apply: () => ipcRenderer.invoke('update:apply'),
    relaunch: () => ipcRenderer.invoke('update:relaunch'),
    onProgress: (cb) => {
      const handler = (_, data) => cb(data);
      ipcRenderer.on('update:progress', handler);
      return () => ipcRenderer.removeListener('update:progress', handler);
    },
  },
});
