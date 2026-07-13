/**
 * IPC channel names. Renderer->main are invoke/handle (promise);
 * main->renderer are webContents.send / ipcRenderer.on push events.
 * SINGLE SOURCE OF TRUTH — feature agents add channels here, never inline strings.
 */

export const IPC = {
  // Auth (owner: agent A)
  auth: {
    signIn: 'auth:sign-in', // invoke -> AuthStatus (resolves when flow completes/fails)
    signOut: 'auth:sign-out', // invoke -> void
    getStatus: 'auth:get-status', // invoke -> AuthStatus
    statusChanged: 'auth:status-changed' // push AuthStatus
  },

  // Voice (owner: agent C)
  voice: {
    mintRealtimeSession: 'voice:mint-realtime-session', // invoke -> RealtimeSessionGrant | {error}
    laneAvailable: 'voice:lane-available', // invoke -> VoiceLane
    setManualApiKey: 'voice:set-manual-api-key', // invoke(key: string) -> boolean
    // fallback chat lane
    chatSend: 'chat:send', // invoke({requestId, text, history}) -> void (deltas pushed)
    chatDelta: 'chat:delta', // push ChatDelta
    // tool bridge: renderer realtime session asks main to run a connector tool
    executeTool: 'voice:execute-tool' // invoke({name, argsJson}) -> {ok, resultJson}
  },

  // Connectors (owner: agent D)
  connectors: {
    list: 'connectors:list', // invoke -> ConnectorCard[]
    connect: 'connectors:connect', // invoke(slug) -> ConnectorCard (resolves on ACTIVE/timeout)
    disconnect: 'connectors:disconnect', // invoke(slug) -> ConnectorCard
    changed: 'connectors:changed', // push ConnectorCard[]
    voiceTools: 'connectors:voice-tools' // invoke -> flattened function tool schemas for realtime session
  },

  // Codex (owner: agent E)
  codex: {
    dispatch: 'codex:dispatch', // invoke({prompt, cwd?, fullAccess?, boundary?}) -> {taskId}
    cancel: 'codex:cancel', // invoke(taskId) -> void
    list: 'codex:list', // invoke -> CodexTaskRow[]
    event: 'codex:event', // push {taskId, row: CodexEventRow}
    taskChanged: 'codex:task-changed', // push CodexTaskRow
    loginStatus: 'codex:login-status', // invoke -> {loggedIn: boolean}
    receipts: 'codex:receipts' // invoke -> CodexRunReceipt[] (run receipt history, newest first)
  },

  // Settings
  settings: {
    get: 'settings:get', // invoke -> JarvisSettings
    update: 'settings:update' // invoke(Partial<JarvisSettings>) -> JarvisSettings
  }
} as const
