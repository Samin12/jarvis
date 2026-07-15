/**
 * IPC channel names. Renderer->main are invoke/handle (promise);
 * main->renderer are webContents.send / ipcRenderer.on push events.
 * SINGLE SOURCE OF TRUTH — feature agents add channels here, never inline strings.
 */

export const IPC = {
  // Auth (owner: agent A)
  auth: {
    signIn: 'auth:sign-in', // invoke -> AuthStatus (resolves when flow completes/fails)
    cancelSignIn: 'auth:cancel-sign-in', // invoke -> void
    signOut: 'auth:sign-out', // invoke -> void
    getStatus: 'auth:get-status', // invoke -> AuthStatus
    statusChanged: 'auth:status-changed' // push AuthStatus
  },

  core: {
    send: 'core:send',
    delta: 'core:delta',
    cancel: 'core:cancel'
  },

  // Voice (owner: agent C)
  voice: {
    laneAvailable: 'voice:lane-available', // invoke -> VoiceLane
    realtimeStart: 'voice:realtime-start', // invoke RealtimeStartRequest -> RealtimeStartResult
    realtimeStop: 'voice:realtime-stop', // invoke RealtimeStopRequest -> void
    realtimeEvent: 'voice:realtime-event', // push RealtimeHostEvent
    localStatus: 'voice:local-status',
    localPermission: 'voice:local-permission',
    localStart: 'voice:local-start',
    localStop: 'voice:local-stop',
    localCancel: 'voice:local-cancel',
    localSpeak: 'voice:local-speak',
    localStopSpeaking: 'voice:local-stop-speaking',
    localEvent: 'voice:local-event'
  },

  // Connectors (owner: agent D)
  connectors: {
    list: 'connectors:list', // invoke -> ConnectorCard[]
    connect: 'connectors:connect', // invoke(slug) -> ConnectorCard (resolves on ACTIVE/timeout)
    changed: 'connectors:changed' // push ConnectorCard[]
  },

  // Codex (owner: agent E)
  codex: {
    dispatch: 'codex:dispatch', // invoke({prompt, scopeId, boundary?}) -> {taskId}
    selectWorkspace: 'codex:select-workspace', // invoke -> {scopeId, path} | null
    cancel: 'codex:cancel', // invoke(taskId) -> void
    list: 'codex:list', // invoke -> CodexTaskRow[]
    event: 'codex:event', // push {taskId, row: CodexEventRow}
    taskChanged: 'codex:task-changed', // push CodexTaskRow
    loginStatus: 'codex:login-status', // invoke -> {loggedIn: boolean, taskEligible: boolean}
    receipts: 'codex:receipts' // invoke -> ActionReceiptRow[] (host action receipts, newest first)
  },

  approvals: {
    list: 'approvals:list',
    decide: 'approvals:decide',
    changed: 'approvals:changed'
  },

  // Settings
  settings: {
    get: 'settings:get', // invoke -> JarvisSettings
    update: 'settings:update' // invoke(Partial<JarvisSettings>) -> JarvisSettings
  }
} as const
