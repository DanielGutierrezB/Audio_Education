const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
    getAll: () => ipcRenderer.invoke('store:getAll'),
  },
  folders: {
    open: () => ipcRenderer.invoke('folders:open'),
    scan: (folderPath) => ipcRenderer.invoke('folders:scan', folderPath),
  },
  ffprobe: {
    getMetadata: (filePath) => ipcRenderer.invoke('ffprobe:metadata', filePath),
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
});
