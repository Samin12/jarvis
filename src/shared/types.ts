/**
 * Shared contracts between main, preload, and renderer.
 * SINGLE SOURCE OF TRUTH — feature agents extend carefully, never fork.
 */

// ---------- Auth ----------

export type AuthStatus =
  | { state: 'checking' }
  | { state: 'signed_out' }
  | {
      state: 'authorizing'
      phase?: 'opening_browser' | 'waiting_for_approval' | 'securing_session'
      loginId?: string
    }
  | {
      state: 'signed_in'
      email: string | null
      planType: string | null // e.g. "plus", "pro"
      accountId: string
    }
  | { state: 'error'; message: string }

// ---------- Voice ----------

export type CoreMode = 'idle' | 'working' | 'listening' | 'speaking' | 'error'

export type VoiceLane = 'realtime' | 'fallback' // realtime = WebRTC; fallback = local speech + app-server

/** Renderer-generated offer passed to the ChatGPT-authenticated app-server lane. */
export interface RealtimeStartRequest {
  requestId: string
  offerSdp: string
}

/** Opaque host session identity plus the remote SDP needed by RTCPeerConnection. */
export interface RealtimeStartResult {
  requestId: string
  sessionId: string
  answerSdp: string
}

/** Idempotent stop/cancel request; requestId also cancels a start still in flight. */
export interface RealtimeStopRequest {
  requestId: string
  sessionId?: string
}

/** Low-volume host lifecycle signal. Realtime media/events stay on WebRTC. */
export interface RealtimeHostEvent {
  requestId: string
  sessionId?: string
  kind: 'error' | 'closed'
  message?: string
  reason?: string
}

export type LocalVoiceState =
  | 'unavailable'
  | 'permission_unknown'
  | 'permission_denied'
  | 'ready'
  | 'listening'
  | 'transcribing'
  | 'speaking'
  | 'error'

export interface LocalVoiceEvent {
  kind: 'status' | 'partial' | 'final' | 'speech_started' | 'speech_finished' | 'error'
  state: LocalVoiceState
  text?: string
  code?: string
  message?: string
  requestId?: string
  sessionId?: string
  recoverable?: boolean
}

export interface TranscriptEntry {
  id: string
  role: 'user' | 'jarvis' | 'system'
  text: string
  at: number // epoch ms
  /** present when the entry is a tool call/result surface */
  tool?: { name: string; status: 'running' | 'done' | 'error' | 'awaiting_confirmation' }
}

// ---------- App-server conversation lane ----------

export interface ConversationSendRequest {
  requestId: string
  text: string
  appIds?: string[]
}

export interface ConversationDelta {
  requestId: string
  kind: 'started' | 'text_delta' | 'done' | 'blocked' | 'error'
  text?: string
  threadId?: string
  turnId?: string
  error?: string
}

// ---------- Connected ChatGPT Apps ----------

export type ConnectorStatus =
  | 'not_configured' // no auth config exists (e.g. Calendar before one-time setup)
  | 'disconnected'
  | 'connecting' // link() opened in browser, waiting for ACTIVE
  | 'connected'
  | 'error'

export interface ConnectorCard {
  slug: string // toolkit slug, e.g. GMAIL, GOOGLECALENDAR
  title: string // display, e.g. "Gmail"
  section: 'apps' | 'composio'
  status: ConnectorStatus
  detail?: string // e.g. connected account email or error text
}

export interface HostApprovalPreview {
  approvalId: string
  operation: string
  target: string
  capability: string
  dataClassification: 'public' | 'account' | 'sensitive' | 'secret'
  reason: string
  detail:
    | { kind: 'command'; command: string; cwd: string }
    | { kind: 'task_dispatch'; prompt: string; workspace: string }
    | {
        kind: 'file_change'
        changes: Array<{
          path: string
          changeType: 'add' | 'delete' | 'update'
          diff: string
          movePath: string | null
        }>
      }
    | null
  expiresAt: number
}

// ---------- Codex ----------

export type CodexTerminalState =
  | 'success'
  | 'clean_noop'
  | 'blocked'
  | 'approval_required'
  | 'exhausted'
  | 'no_progress'
  | 'unknown_outcome'

export interface CodexTaskRow {
  taskId: string
  threadId: string | null
  prompt: string
  startedAt: number
  state: 'running' | 'done' | 'failed' | 'cancelled'
  terminal?: CodexTerminalState
  spokenSummary?: string
  /** compact event feed for the HUD */
  events: CodexEventRow[]
}

export interface CodexEventRow {
  at: number
  kind:
    | 'thread_started'
    | 'turn_started'
    | 'agent_message'
    | 'reasoning'
    | 'command'
    | 'file_change'
    | 'mcp_tool_call'
    | 'web_search'
    | 'todo'
    | 'error'
    | 'turn_completed'
    | 'turn_failed'
  summary: string
}

/** Finite run boundary attached to every dispatched Codex task (loopy: never act without one). */
export interface CodexBoundary {
  maxTurns?: number
  wallClockMs?: number
}

/** Payload of IPC.codex.dispatch — mirrors the preload bridge signature exactly. */
export interface CodexDispatchRequest {
  prompt: string
  scopeId?: string
  boundary?: CodexBoundary
}

/** Truthful, host-owned receipt for one reviewed action attempt. */
export interface ActionReceiptRow {
  receiptId: string
  attemptId: string
  intentHash: string
  approvalId: string | null
  operation: string
  target: string
  terminal: 'success' | 'denied' | 'blocked' | 'unknown_outcome'
  verification: 'confirmed' | 'failed' | 'unavailable'
  providerRequestId: string | null
  providerResourceId: string | null
  summary: string
  createdAt: number
  finishedAt: number
}

// ---------- Settings ----------

export interface JarvisSettings {
  pushToTalkKey: string // e.g. 'Space'
}
