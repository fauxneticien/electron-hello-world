const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('updater', {
  onDownloaded: (callback) => ipcRenderer.on('update-downloaded', callback),
  install: () => ipcRenderer.send('install-update'),
})
