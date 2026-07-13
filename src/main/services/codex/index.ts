/**
 * registerCodex — wires IPC.codex.* to the CodexBridge.
 * The integration agent calls this from src/main/index.ts after app ready:
 *   registerCodex(ipcMain, () => mainWindow)
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { IPC } from '../../../shared/ipc'
import type { CodexDispatchRequest, CodexEventRow, CodexTaskRow } from '../../../shared/types'
import { cancelTask, dispatchCodexTask, listTasks } from './bridge'
import type { CodexBridgeEmitter } from './bridge'
import { loadReceipts } from './receipts'
import { getCodexLoginStatus } from './loginStatus'

export { dispatchCodexTask, cancelTask, listTasks } from './bridge'
export type { CodexBridgeEmitter } from './bridge'

export function registerCodex(ipcMain: IpcMain, getWindow: () => BrowserWindow | null): void {
  const send = (channel: string, payload: unknown): void => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }
  const emitter: CodexBridgeEmitter = {
    onEvent: (taskId: string, row: CodexEventRow) => send(IPC.codex.event, { taskId, row }),
    onTaskChanged: (task: CodexTaskRow) => send(IPC.codex.taskChanged, task)
  }

  ipcMain.handle(IPC.codex.dispatch, (_e, req: CodexDispatchRequest) =>
    dispatchCodexTask(req, emitter)
  )
  ipcMain.handle(IPC.codex.cancel, (_e, taskId: string) => cancelTask(taskId))
  ipcMain.handle(IPC.codex.list, () => listTasks())
  ipcMain.handle(IPC.codex.receipts, () => loadReceipts())
  ipcMain.handle(IPC.codex.loginStatus, () => getCodexLoginStatus())
}
