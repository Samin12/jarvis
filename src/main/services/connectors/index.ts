/**
 * Connectors feature entry point (main process).
 *
 * Integration wiring (done by the integration agent in src/main/index.ts):
 *   import { registerConnectors } from './services/connectors'
 *   registerConnectors(ipcMain, () => mainWindow)
 *
 * The voice service consumes tools via dependency injection:
 *   import { executeTool, getVoiceTools } from '../connectors'
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { IPC } from '../../../shared/ipc'
import * as service from './service'
import { getVoiceTools } from './voiceTools'

export function registerConnectors(ipcMain: IpcMain, getWindow: () => BrowserWindow | null): void {
  service.onCardsChanged((cards) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.connectors.changed, cards)
    }
  })

  ipcMain.handle(IPC.connectors.list, () => service.list())
  ipcMain.handle(IPC.connectors.connect, (_event, slug: string) => service.connect(slug))
  ipcMain.handle(IPC.connectors.disconnect, (_event, slug: string) => service.disconnect(slug))
  ipcMain.handle(IPC.connectors.voiceTools, () => getVoiceTools())
}

// Voice-service dependency injection surface.
export { executeTool, getVoiceTools, invalidateVoiceToolCache } from './voiceTools'
export type { RealtimeFunctionTool, ToolExecutionResult } from './voiceTools'

// Integration hooks.
export { setUserIdProvider, hasComposioKey, connectorsConfigPath } from './composioClient'
export { refresh as refreshConnectors } from './service'
