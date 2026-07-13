/**
 * CodexBridge — Jarvis's hands (PLAN D3 + codex task protocol).
 *
 * Wraps @openai/codex-sdk (spawns the bundled `codex exec --experimental-json`).
 * Every dispatch carries a finite boundary and ends in a named terminal state
 * (loopy: Success | Clean no-op | Blocked | Approval required | Exhausted | No progress),
 * persisted as a run receipt and summarized for voice.
 */
import { Codex } from '@openai/codex-sdk'
import type { ThreadEvent, ThreadItem } from '@openai/codex-sdk'
import { app } from 'electron'
import { randomUUID } from 'crypto'
import type {
  CodexBoundary,
  CodexDispatchRequest,
  CodexEventRow,
  CodexTaskRow,
  CodexTerminalState
} from '../../../shared/types'
import { appendReceipt, sha256Hex } from './receipts'

// ---------- emitter (wired to webContents.send by index.ts) ----------

export interface CodexBridgeEmitter {
  onEvent(taskId: string, row: CodexEventRow): void
  onTaskChanged(task: CodexTaskRow): void
}

// ---------- singleton SDK client ----------

let codexSingleton: Codex | null = null

function getCodex(): Codex {
  if (!codexSingleton) {
    // No apiKey: the child inherits the ChatGPT OAuth session in ~/.codex/auth.json (PLAN D3).
    codexSingleton = new Codex()
  }
  return codexSingleton
}

// ---------- task registry ----------

interface TaskRecord {
  row: CodexTaskRow
  abort: AbortController
  boundary: Required<CodexBoundary>
  promptSha256: string
  cancelRequested: boolean
  boundaryExceeded: boolean
  boundaryTimer: NodeJS.Timeout | null
}

const tasks = new Map<string, TaskRecord>()

const DEFAULT_WALL_CLOCK_MS = 10 * 60_000
const DEFAULT_MAX_TURNS = 25
const MAX_EVENT_ROWS = 500
const TERMINAL_STATES: readonly CodexTerminalState[] = [
  'success',
  'clean_noop',
  'blocked',
  'approval_required',
  'exhausted',
  'no_progress'
]

export function listTasks(): CodexTaskRow[] {
  return [...tasks.values()].map((t) => t.row).sort((a, b) => b.startedAt - a.startedAt)
}

export function cancelTask(taskId: string): void {
  const record = tasks.get(taskId)
  if (!record || record.row.state !== 'running') return
  record.cancelRequested = true
  record.abort.abort()
}

// ---------- dispatch ----------

export function dispatchCodexTask(
  req: CodexDispatchRequest,
  emit: CodexBridgeEmitter
): { taskId: string } {
  const prompt = typeof req?.prompt === 'string' ? req.prompt.trim() : ''
  if (!prompt) throw new Error('codex:dispatch requires a non-empty prompt')

  const taskId = randomUUID()
  const boundary: Required<CodexBoundary> = {
    maxTurns: clampInt(req.boundary?.maxTurns, 1, 100, DEFAULT_MAX_TURNS),
    wallClockMs: clampInt(req.boundary?.wallClockMs, 10_000, 4 * 60 * 60_000, DEFAULT_WALL_CLOCK_MS)
  }
  const record: TaskRecord = {
    row: {
      taskId,
      threadId: null,
      prompt,
      startedAt: Date.now(),
      state: 'running',
      events: []
    },
    abort: new AbortController(),
    boundary,
    promptSha256: sha256Hex(prompt),
    cancelRequested: false,
    boundaryExceeded: false,
    boundaryTimer: null
  }
  tasks.set(taskId, record)
  emit.onTaskChanged(record.row)

  void runTask(record, req, emit).catch((err) => {
    // Absolute backstop — runTask has its own try/catch; never let a rejection escape.
    console.error('[codex] unexpected bridge failure', err)
  })
  return { taskId }
}

async function runTask(
  record: TaskRecord,
  req: CodexDispatchRequest,
  emit: CodexBridgeEmitter
): Promise<void> {
  const { row } = record
  const fullAccess = req.fullAccess === true

  record.boundaryTimer = setTimeout(() => {
    if (row.state !== 'running') return
    record.boundaryExceeded = true
    record.abort.abort()
  }, record.boundary.wallClockMs)

  let finalAgentMessage = ''
  let turnFailedMessage: string | null = null
  let fatalError: string | null = null

  try {
    const thread = getCodex().startThread({
      workingDirectory: req.cwd || app.getPath('home'),
      skipGitRepoCheck: true,
      sandboxMode: fullAccess ? 'danger-full-access' : 'workspace-write',
      approvalPolicy: 'never',
      networkAccessEnabled: fullAccess
    })

    const { events } = await thread.runStreamed(buildDispatchPrompt(req.prompt, record.boundary), {
      signal: record.abort.signal
    })

    for await (const ev of events) {
      if (ev.type === 'thread.started') {
        row.threadId = ev.thread_id
        emit.onTaskChanged(row)
      }
      if (ev.type === 'turn.failed') turnFailedMessage = ev.error.message
      if (ev.type === 'error') fatalError = ev.message
      if (
        (ev.type === 'item.completed' || ev.type === 'item.updated') &&
        ev.item.type === 'agent_message'
      ) {
        finalAgentMessage = ev.item.text
      }
      const eventRow = mapThreadEvent(ev)
      if (eventRow) pushEvent(record, eventRow, emit)
    }
  } catch (err) {
    if (!record.cancelRequested && !record.boundaryExceeded) {
      fatalError = err instanceof Error ? err.message : String(err)
    }
  } finally {
    if (record.boundaryTimer) clearTimeout(record.boundaryTimer)
    record.boundaryTimer = null
  }

  finishTask(record, { finalAgentMessage, turnFailedMessage, fatalError }, emit)
}

interface TaskOutcome {
  finalAgentMessage: string
  turnFailedMessage: string | null
  fatalError: string | null
}

function finishTask(record: TaskRecord, outcome: TaskOutcome, emit: CodexBridgeEmitter): void {
  const { row } = record
  if (row.state !== 'running') return // already finalized

  const parsed = parseFinalJson(outcome.finalAgentMessage)
  let terminal: CodexTerminalState
  let evidence: string
  let spokenSummary: string

  if (record.cancelRequested) {
    row.state = 'cancelled'
    terminal = 'exhausted'
    evidence = 'Cancelled by user before completion.'
    spokenSummary = 'I stopped that task at your request.'
  } else if (record.boundaryExceeded) {
    row.state = 'failed'
    terminal = 'exhausted'
    evidence = `Wall-clock boundary of ${Math.round(record.boundary.wallClockMs / 1000)}s exceeded.`
    spokenSummary = 'That task ran out of time before finishing.'
  } else if (outcome.fatalError || outcome.turnFailedMessage) {
    row.state = 'failed'
    terminal = parsed?.terminalState ?? 'blocked'
    evidence =
      parsed?.evidence ??
      truncate(outcome.fatalError ?? outcome.turnFailedMessage ?? 'Unknown failure', 500)
    spokenSummary =
      parsed?.spokenSummary ??
      `That task hit an error: ${truncate(outcome.fatalError ?? outcome.turnFailedMessage ?? 'unknown', 140)}`
  } else {
    terminal = parsed?.terminalState ?? 'success'
    // Loopy rule: never report blocked/exhausted/no-progress as a "done" success —
    // still state 'done' (the run completed), the terminal carries the truth.
    row.state = 'done'
    evidence = parsed?.evidence ?? truncate(outcome.finalAgentMessage || 'Turn completed.', 500)
    spokenSummary =
      parsed?.spokenSummary ?? truncate(outcome.finalAgentMessage || 'Task completed.', 240)
  }

  row.terminal = terminal
  row.spokenSummary = spokenSummary
  pushEvent(
    record,
    {
      at: Date.now(),
      kind: row.state === 'failed' ? 'turn_failed' : 'turn_completed',
      summary: `terminal: ${terminal}`
    },
    emit
  )
  emit.onTaskChanged(row)

  void appendReceipt({
    taskId: row.taskId,
    promptSha256: record.promptSha256,
    boundary: record.boundary,
    terminal,
    evidence,
    finishedAt: Date.now()
  })
}

// ---------- dispatch preamble (Observe/Choose/Act/Verify/Record + boundary + final JSON) ----------

export function buildDispatchPrompt(prompt: string, boundary: Required<CodexBoundary>): string {
  const minutes = Math.max(1, Math.round(boundary.wallClockMs / 60_000))
  return [
    'You are a task agent dispatched by Jarvis, a voice assistant. Nobody is watching a terminal; work autonomously and end cleanly.',
    '',
    'Work in bounded passes using this cycle:',
    '1. OBSERVE — read fresh state; collect concrete evidence.',
    '2. CHOOSE — pick the highest-value in-scope action.',
    '3. ACT — one bounded, reversible change per pass.',
    '4. VERIFY — run the same acceptance check each pass.',
    '5. RECORD — note action, evidence, outcome, remaining work.',
    'Repeat only while progress is measurable and the run boundary remains; otherwise stop in a named terminal state.',
    '',
    `RUN BOUNDARY: at most ${boundary.maxTurns} passes and about ${minutes} minute${minutes === 1 ? '' : 's'} of wall clock. If the goal is already satisfied, stop immediately with terminal_state "clean_noop". Never report an error or an exhausted budget as success.`,
    '',
    'If an action would be destructive, irreversible, or outside your sandbox/scope, do not attempt it — stop with terminal_state "approval_required" and state exactly what needs approval.',
    '',
    'Your FINAL message must be exactly one JSON object and nothing else (no markdown fences, no prose before or after):',
    '{"spoken_summary": "<at most 2 conversational sentences, written to be spoken aloud>", "terminal_state": "success" | "clean_noop" | "blocked" | "approval_required" | "exhausted" | "no_progress", "evidence": "<one short paragraph of concrete evidence: commands run, checks passed, files changed>"}',
    '',
    'TASK:',
    prompt
  ].join('\n')
}

// ---------- final-message parsing ----------

interface ParsedFinal {
  spokenSummary: string | null
  terminalState: CodexTerminalState | null
  evidence: string | null
}

export function parseFinalJson(text: string): ParsedFinal | null {
  if (!text) return null
  const candidate = extractJsonObject(text)
  if (!candidate) return null
  try {
    const obj = JSON.parse(candidate) as Record<string, unknown>
    const spoken = typeof obj.spoken_summary === 'string' ? obj.spoken_summary : null
    const evidence = typeof obj.evidence === 'string' ? obj.evidence : null
    const terminal =
      typeof obj.terminal_state === 'string' ? normalizeTerminal(obj.terminal_state) : null
    if (spoken === null && evidence === null && terminal === null) return null
    return { spokenSummary: spoken, terminalState: terminal, evidence }
  } catch {
    return null
  }
}

/** Pull the last top-level {...} block out of text (tolerates ```json fences and stray prose). */
function extractJsonObject(text: string): string | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim()
  const end = cleaned.lastIndexOf('}')
  if (end === -1) return null
  let depth = 0
  for (let i = end; i >= 0; i--) {
    const ch = cleaned[i]
    if (ch === '}') depth++
    else if (ch === '{') {
      depth--
      if (depth === 0) return cleaned.slice(i, end + 1)
    }
  }
  return null
}

export function normalizeTerminal(value: string): CodexTerminalState | null {
  const normalized = value
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z_]/g, '')
  const aliases: Record<string, CodexTerminalState> = {
    clean_no_op: 'clean_noop',
    noop: 'clean_noop',
    no_op: 'clean_noop',
    approval: 'approval_required',
    needs_approval: 'approval_required'
  }
  const resolved = aliases[normalized] ?? (normalized as CodexTerminalState)
  return TERMINAL_STATES.includes(resolved) ? resolved : null
}

// ---------- ThreadEvent -> CodexEventRow mapping ----------

export function mapThreadEvent(ev: ThreadEvent): CodexEventRow | null {
  const at = Date.now()
  switch (ev.type) {
    case 'thread.started':
      return { at, kind: 'thread_started', summary: `thread ${ev.thread_id}` }
    case 'turn.started':
      return { at, kind: 'turn_started', summary: 'turn started' }
    case 'turn.completed':
      return {
        at,
        kind: 'turn_completed',
        summary: `tokens: ${ev.usage.input_tokens} in (${ev.usage.cached_input_tokens} cached) / ${ev.usage.output_tokens} out`
      }
    case 'turn.failed':
      return { at, kind: 'turn_failed', summary: truncate(ev.error.message, 300) }
    case 'error':
      return { at, kind: 'error', summary: truncate(ev.message, 300) }
    case 'item.started':
      return mapItem(ev.item, 'started', at)
    case 'item.updated':
      return mapItem(ev.item, 'updated', at)
    case 'item.completed':
      return mapItem(ev.item, 'completed', at)
    default:
      return null
  }
}

function mapItem(
  item: ThreadItem,
  phase: 'started' | 'updated' | 'completed',
  at: number
): CodexEventRow | null {
  switch (item.type) {
    case 'command_execution': {
      // one row when the command launches, one when it settles — skip noisy output updates
      if (phase === 'started')
        return { at, kind: 'command', summary: `$ ${truncate(item.command, 220)}` }
      if (phase === 'completed') {
        const exit = item.exit_code === undefined ? item.status : `exit ${item.exit_code}`
        return { at, kind: 'command', summary: `$ ${truncate(item.command, 200)} → ${exit}` }
      }
      return null
    }
    case 'file_change': {
      if (phase !== 'completed') return null
      const summary = item.changes
        .map((c) => `${c.kind.charAt(0).toUpperCase()} ${c.path}`)
        .join(', ')
      return {
        at,
        kind: 'file_change',
        summary:
          item.status === 'failed' ? `FAILED: ${truncate(summary, 260)}` : truncate(summary, 280)
      }
    }
    case 'mcp_tool_call': {
      if (phase !== 'completed') return null
      const suffix =
        item.status === 'failed' ? ` — ${truncate(item.error?.message ?? 'failed', 120)}` : ''
      return {
        at,
        kind: 'mcp_tool_call',
        summary: `${item.server}.${item.tool} ${item.status}${suffix}`
      }
    }
    case 'web_search':
      if (phase !== 'started') return null
      return { at, kind: 'web_search', summary: `search: ${truncate(item.query, 200)}` }
    case 'todo_list': {
      if (phase === 'started') return null
      // encode the checklist as lines — CodexPanel renders "[x] " / "[ ] " prefixes as a checklist
      const lines = item.items
        .slice(0, 12)
        .map((t) => `${t.completed ? '[x]' : '[ ]'} ${truncate(t.text, 120)}`)
      return { at, kind: 'todo', summary: lines.join('\n') }
    }
    case 'reasoning':
      if (phase !== 'completed') return null
      return { at, kind: 'reasoning', summary: truncate(item.text, 160) }
    case 'agent_message':
      if (phase !== 'completed') return null
      return { at, kind: 'agent_message', summary: truncate(item.text, 240) }
    case 'error':
      if (phase !== 'completed') return null
      return { at, kind: 'error', summary: truncate(item.message, 300) }
    default:
      return null
  }
}

// ---------- helpers ----------

function pushEvent(record: TaskRecord, row: CodexEventRow, emit: CodexBridgeEmitter): void {
  record.row.events.push(row)
  if (record.row.events.length > MAX_EVENT_ROWS) {
    record.row.events.splice(0, record.row.events.length - MAX_EVENT_ROWS)
  }
  emit.onEvent(record.row.taskId, row)
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= max ? oneLine : oneLine.slice(0, max - 1) + '…'
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.round(value)))
}
