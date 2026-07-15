import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerSettings } from './services/settings'
import { registerVoice, type RegisteredVoiceService } from './services/voice'
import { secureSession, secureWindow } from './security'
import { createJarvisRuntime, type JarvisRuntime } from './services/runtime'

let mainWindow: BrowserWindow | null = null
let runtime: JarvisRuntime | null = null
let voiceService: RegisteredVoiceService | null = null
let shutdownStarted = false
const ownsSingleInstance = app.requestSingleInstanceLock()

const getWindow = (): BrowserWindow | null =>
  mainWindow && !mainWindow.isDestroyed() ? mainWindow : null

function createWindow(): void {
  // Jarvis has one privileged main frame. The renderer is treated as untrusted
  // presentation code and receives only the explicit preload bridge.
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#07090c',
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  })

  secureWindow(mainWindow)
  secureSession(mainWindow.webContents.session, getWindow)

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!ownsSingleInstance) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = getWindow()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })

  void app
    .whenReady()
    .then(async () => {
      electronApp.setAppUserModelId('us.aianswer.jarvis')

      // Default open or close DevTools by F12 in development
      // and ignore CommandOrControl + R in production.
      app.on('browser-window-created', (_, window) => {
        optimizer.watchWindowShortcuts(window)
      })

      // ChatGPT identity, apps, conversation, live voice, and Codex are owned by
      // the isolated app-server runtime. Local speech remains the fallback lane.
      registerSettings(ipcMain, getWindow)
      runtime = await createJarvisRuntime(ipcMain, getWindow)
      voiceService = registerVoice(ipcMain, getWindow, { core: runtime.core })

      createWindow()
      void runtime.start().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        console.error('[runtime]', message)
        dialog.showErrorBox('Jarvis could not secure its local state', message)
        app.quit()
      })

      app.on('activate', function () {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (BrowserWindow.getAllWindows().length === 0) createWindow()
      })
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error('[startup]', message)
      dialog.showErrorBox('Jarvis could not start', message)
      app.quit()
    })
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', (event) => {
  if (!runtime || shutdownStarted) return
  event.preventDefault()
  shutdownStarted = true
  void Promise.allSettled([runtime.stop(), voiceService?.close() ?? Promise.resolve()]).finally(
    () => app.quit()
  )
})
