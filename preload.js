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
});
