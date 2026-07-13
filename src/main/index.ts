import { app, shell, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerAuth, getAccountId } from './services/auth'
import { registerSettings, getSettingsSnapshot } from './services/settings'
import { registerConnectors, executeTool, setUserIdProvider } from './services/connectors'
import { registerCodex } from './services/codex'
import { registerVoice } from './services/voice'

let mainWindow: BrowserWindow | null = null

const getWindow = (): BrowserWindow | null =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow : null

function createWindow(): void {
  // The HUD is a desktop-only fixed composition (>=1280px assumed by the
  // design system) — enforce the floor at the window level.
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1440,
    minHeight: 900,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#07090c',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('us.aianswer.jarvis')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // --- service registration -------------------------------------------------
  // Order matters: auth first (it needs a ready app for safeStorage and does
  // startup adoption of ~/.codex/auth.json; voice/connectors read its module
  // accessors), settings before voice (voice reads the settings snapshot).
  registerAuth(ipcMain, getWindow)
  registerSettings(ipcMain)
  registerConnectors(ipcMain, getWindow)
  // Composio userId follows the live ChatGPT account (falls back to the
  // tokenStore read inside the connectors service when this returns null).
  setUserIdProvider(() => getAccountId())
  registerCodex(ipcMain, getWindow)
  registerVoice(ipcMain, getWindow, {
    executeTool,
    getSettings: () => getSettingsSnapshot()
  })

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
