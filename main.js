const { app, BrowserWindow, ipcMain } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('node:path')

app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile('index.html')

  autoUpdater.on('update-downloaded', () => win.webContents.send('update-downloaded'))
  autoUpdater.checkForUpdates()
})

ipcMain.on('install-update', () => autoUpdater.quitAndInstall())

app.on('window-all-closed', () => app.quit())
