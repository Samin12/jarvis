import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '../shared/ipc'
import type {
  AuthStatus,
  ChatDelta,
  CodexEventRow,
  CodexTaskRow,
  ConnectorCard,
  JarvisSettings,
  RealtimeSessionGrant,
  VoiceLane,
} from '../shared/types'

type Unsubscribe = () => void

function on<T>(channel: string, cb: (payload: T) => void): Unsubscribe {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

/** The typed bridge every renderer feature codes against. */
const jarvis = {
  auth: {
    signIn: (): Promise<AuthStatus> => ipcRenderer.invoke(IPC.auth.signIn),
    signOut: (): Promise<void> => ipcRenderer.invoke(IPC.auth.signOut),
    getStatus: (): Promise<AuthStatus> => ipcRenderer.invoke(IPC.auth.getStatus),
    onStatusChanged: (cb: (s: AuthStatus) => void): Unsubscribe => on(IPC.auth.statusChanged, cb),
  },
  voice: {
    mintRealtimeSession: (): Promise<RealtimeSessionGrant | { error: string }> =>
      ipcRenderer.invoke(IPC.voice.mintRealtimeSession),
    laneAvailable: (): Promise<VoiceLane> => ipcRenderer.invoke(IPC.voice.laneAvailable),
    setManualApiKey: (key: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.voice.setManualApiKey, key),
    chatSend: (req: {
      requestId: string
      text: string
      history: { role: 'user' | 'assistant'; text: string }[]
    }): Promise<void> => ipcRenderer.invoke(IPC.voice.chatSend, req),
    onChatDelta: (cb: (d: ChatDelta) => void): Unsubscribe => on(IPC.voice.chatDelta, cb),
    executeTool: (req: {
      name: string
      argsJson: string
    }): Promise<{ ok: boolean; resultJson: string }> =>
      ipcRenderer.invoke(IPC.voice.executeTool, req),
  },
  connectors: {
    list: (): Promise<ConnectorCard[]> => ipcRenderer.invoke(IPC.connectors.list),
    connect: (slug: string): Promise<ConnectorCard> =>
      ipcRenderer.invoke(IPC.connectors.connect, slug),
    disconnect: (slug: string): Promise<ConnectorCard> =>
      ipcRenderer.invoke(IPC.connectors.disconnect, slug),
    onChanged: (cb: (cards: ConnectorCard[]) => void): Unsubscribe =>
      on(IPC.connectors.changed, cb),
    voiceTools: (): Promise<unknown[]> => ipcRenderer.invoke(IPC.connectors.voiceTools),
  },
  codex: {
    dispatch: (req: {
      prompt: string
      cwd?: string
      fullAccess?: boolean
      boundary?: { maxTurns?: number; wallClockMs?: number }
    }): Promise<{ taskId: string }> => ipcRenderer.invoke(IPC.codex.dispatch, req),
    cancel: (taskId: string): Promise<void> => ipcRenderer.invoke(IPC.codex.cancel, taskId),
    list: (): Promise<CodexTaskRow[]> => ipcRenderer.invoke(IPC.codex.list),
    onEvent: (cb: (p: { taskId: string; row: CodexEventRow }) => void): Unsubscribe =>
      on(IPC.codex.event, cb),
    onTaskChanged: (cb: (t: CodexTaskRow) => void): Unsubscribe => on(IPC.codex.taskChanged, cb),
    loginStatus: (): Promise<{ loggedIn: boolean }> => ipcRenderer.invoke(IPC.codex.loginStatus),
  },
  settings: {
    get: (): Promise<JarvisSettings> => ipcRenderer.invoke(IPC.settings.get),
    update: (patch: Partial<JarvisSettings>): Promise<JarvisSettings> =>
      ipcRenderer.invoke(IPC.settings.update, patch),
  },
}

export type JarvisBridge = typeof jarvis

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('jarvis', jarvis)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.jarvis = jarvis
}
