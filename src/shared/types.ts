/**
 * Shared contracts between main, preload, and renderer.
 * SINGLE SOURCE OF TRUTH — feature agents extend carefully, never fork.
 */

// ---------- Auth ----------

export type AuthStatus =
  | { state: 'signed_out' }
  | { state: 'authorizing' } // browser flow in progress
  | {
      state: 'signed_in'
      email: string | null
      planType: string | null // e.g. "plus", "pro"
      accountId: string
      /** Whether a Platform API key is available for Realtime voice (D1 ladder). */
      voiceKeyAvailable: boolean
      /** Where the voice key came from, if available. */
      voiceKeySource: 'codex-auth-json' | 'token-exchange' | 'env' | 'settings' | null
    }
  | { state: 'error'; message: string }

// ---------- Voice ----------

export type CoreMode = 'idle' | 'working' | 'listening' | 'speaking' | 'error'

/** Where the D1 key ladder found a Platform API key (mirrors AuthStatus.voiceKeySource). */
export type VoiceKeySource = 'codex-auth-json' | 'token-exchange' | 'env' | 'settings'

export type VoiceLane = 'realtime' | 'fallback' // realtime = WebRTC full duplex; fallback = text+speechSynthesis

export interface RealtimeSessionGrant {
  /** Ephemeral client secret (ek_...) minted by main via /v1/realtime/client_secrets */
  clientSecret: string
  expiresAt: number // epoch ms
  model: string // e.g. gpt-realtime-2.1
  voice: string // e.g. marin
}

export interface TranscriptEntry {
  id: string
  role: 'user' | 'jarvis' | 'system'
  text: string
  at: number // epoch ms
  /** present when the entry is a tool call/result surface */
  tool?: { name: string; status: 'running' | 'done' | 'error' | 'awaiting_confirmation' }
}

// ---------- Chat fallback lane (ChatGPT token -> backend-api/codex/responses) ----------

export interface ChatDelta {
  requestId: string
  kind: 'text_delta' | 'done' | 'error'
  text?: string
  error?: string
}

// ---------- Connectors (Composio) ----------

export type ConnectorStatus =
  | 'not_configured' // no auth config exists (e.g. Calendar before one-time setup)
  | 'disconnected'
  | 'connecting' // link() opened in browser, waiting for ACTIVE
  | 'connected'
  | 'error'

export interface ConnectorCard {
  slug: string // toolkit slug, e.g. GMAIL, GOOGLECALENDAR
  title: string // display, e.g. "Gmail"
  section: 'composio' // reserved for future non-composio sections
  status: ConnectorStatus
  detail?: string // e.g. connected account email or error text
}

// ---------- Codex ----------

export type CodexTerminalState =
  'success' | 'clean_noop' | 'blocked' | 'approval_required' | 'exhausted' | 'no_progress'

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
  cwd?: string
  fullAccess?: boolean
  boundary?: CodexBoundary
}

export interface CodexRunReceipt {
  taskId: string
  promptSha256: string
  boundary: { maxTurns?: number; wallClockMs?: number }
  terminal: CodexTerminalState
  evidence: string
  finishedAt: number
}

// ---------- Settings ----------

export interface JarvisSettings {
  voiceModel: 'gpt-realtime-2.1' | 'gpt-realtime-2.1-mini'
  voice: string // marin, cedar, ...
  costMode: boolean
  pushToTalkKey: string // e.g. 'Space'
  /** user-pasted platform key lives ONLY in main (safeStorage); this flags presence */
  hasManualApiKey: boolean
}
