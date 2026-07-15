import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type {
  AuthStatus,
  ConversationDelta,
  ConversationSendRequest,
  CodexEventRow,
  ActionReceiptRow,
  CodexTaskRow,
  ConnectorCard,
  JarvisSettings,
  HostApprovalPreview,
  LocalVoiceEvent,
  LocalVoiceState,
  RealtimeHostEvent,
  RealtimeStartRequest,
  RealtimeStartResult,
  RealtimeStopRequest,
  VoiceLane
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
    cancelSignIn: (): Promise<void> => ipcRenderer.invoke(IPC.auth.cancelSignIn),
    signOut: (): Promise<void> => ipcRenderer.invoke(IPC.auth.signOut),
    getStatus: (): Promise<AuthStatus> => ipcRenderer.invoke(IPC.auth.getStatus),
    onStatusChanged: (cb: (s: AuthStatus) => void): Unsubscribe => on(IPC.auth.statusChanged, cb)
  },
  core: {
    send: (request: ConversationSendRequest): Promise<void> =>
      ipcRenderer.invoke(IPC.core.send, request),
    cancel: (requestId: string): Promise<void> => ipcRenderer.invoke(IPC.core.cancel, requestId),
    onDelta: (cb: (delta: ConversationDelta) => void): Unsubscribe => on(IPC.core.delta, cb)
  },
  voice: {
    laneAvailable: (): Promise<VoiceLane> => ipcRenderer.invoke(IPC.voice.laneAvailable),
    realtimeStart: (request: RealtimeStartRequest): Promise<RealtimeStartResult> =>
      ipcRenderer.invoke(IPC.voice.realtimeStart, request),
    realtimeStop: (request: RealtimeStopRequest): Promise<void> =>
      ipcRenderer.invoke(IPC.voice.realtimeStop, request),
    onRealtimeEvent: (cb: (event: RealtimeHostEvent) => void): Unsubscribe =>
      on(IPC.voice.realtimeEvent, cb),
    localStatus: (): Promise<LocalVoiceState> => ipcRenderer.invoke(IPC.voice.localStatus),
    localPermission: (): Promise<LocalVoiceState> => ipcRenderer.invoke(IPC.voice.localPermission),
    localStart: (): Promise<void> => ipcRenderer.invoke(IPC.voice.localStart),
    localStop: (): Promise<void> => ipcRenderer.invoke(IPC.voice.localStop),
    localCancel: (): Promise<void> => ipcRenderer.invoke(IPC.voice.localCancel),
    localSpeak: (text: string): Promise<void> => ipcRenderer.invoke(IPC.voice.localSpeak, text),
    localStopSpeaking: (): Promise<void> => ipcRenderer.invoke(IPC.voice.localStopSpeaking),
    onLocalEvent: (cb: (event: LocalVoiceEvent) => void): Unsubscribe =>
      on(IPC.voice.localEvent, cb)
  },
  connectors: {
    list: (): Promise<ConnectorCard[]> => ipcRenderer.invoke(IPC.connectors.list),
    connect: (slug: string): Promise<ConnectorCard> =>
      ipcRenderer.invoke(IPC.connectors.connect, slug),
    onChanged: (cb: (cards: ConnectorCard[]) => void): Unsubscribe => on(IPC.connectors.changed, cb)
  },
  approvals: {
    list: (): Promise<HostApprovalPreview[]> => ipcRenderer.invoke(IPC.approvals.list),
    decide: (approvalId: string, decision: 'approve' | 'deny'): Promise<void> =>
      ipcRenderer.invoke(IPC.approvals.decide, { approvalId, decision }),
    onChanged: (cb: (approvals: HostApprovalPreview[]) => void): Unsubscribe =>
      on(IPC.approvals.changed, cb)
  },
  codex: {
    dispatch: (req: {
      prompt: string
      scopeId?: string
      boundary?: { maxTurns?: number; wallClockMs?: number }
    }): Promise<{ taskId: string }> =>
      ipcRenderer.invoke(IPC.codex.dispatch, {
        prompt: req.prompt,
        scopeId: req.scopeId,
        boundary: req.boundary
      }),
    selectWorkspace: (): Promise<{ scopeId: string; path: string } | null> =>
      ipcRenderer.invoke(IPC.codex.selectWorkspace),
    cancel: (taskId: string): Promise<void> => ipcRenderer.invoke(IPC.codex.cancel, taskId),
    list: (): Promise<CodexTaskRow[]> => ipcRenderer.invoke(IPC.codex.list),
    onEvent: (cb: (p: { taskId: string; row: CodexEventRow }) => void): Unsubscribe =>
      on(IPC.codex.event, cb),
    onTaskChanged: (cb: (t: CodexTaskRow) => void): Unsubscribe => on(IPC.codex.taskChanged, cb),
    loginStatus: (): Promise<{ loggedIn: boolean; taskEligible: boolean }> =>
      ipcRenderer.invoke(IPC.codex.loginStatus),
    receipts: (): Promise<ActionReceiptRow[]> => ipcRenderer.invoke(IPC.codex.receipts)
  },
  settings: {
    get: (): Promise<JarvisSettings> => ipcRenderer.invoke(IPC.settings.get),
    update: (patch: Partial<JarvisSettings>): Promise<JarvisSettings> =>
      ipcRenderer.invoke(IPC.settings.update, patch)
  }
}

export type JarvisBridge = typeof jarvis

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('jarvis', jarvis)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.jarvis = jarvis
}
