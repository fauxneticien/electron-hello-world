const { app, BrowserWindow, ipcMain, shell } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('node:path')

app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  win.loadFile('index.html')

  // Links in the page (e.g. the model licence) open in the user's browser, not in this window
  win.webContents.on('will-navigate', (event, url) => {
    event.preventDefault()
    if (url.startsWith('https://')) shell.openExternal(url)
  })

  autoUpdater.on('update-downloaded', () => win.webContents.send('update-downloaded'))
  autoUpdater.checkForUpdates()
})

ipcMain.on('install-update', () => autoUpdater.quitAndInstall())

app.on('window-all-closed', () => app.quit())
