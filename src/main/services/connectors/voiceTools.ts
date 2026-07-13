/**
 * Curated Composio tools for the OpenAI Realtime voice session (PLAN D2).
 *
 * The Realtime API wants FLATTENED function tools:
 *   { type: 'function', name, description, parameters }
 * (not the Chat Completions nested { type, function: {...} } shape), so we
 * fetch raw Composio schemas via tools.getRawComposioTools and map ourselves.
 *
 * Confirmation protocol for side-effectful tools (send email / create event):
 *   1. The model calls e.g. GMAIL_SEND_EMAIL without `confirmed: true`.
 *   2. executeTool returns { ok: false, resultJson: '{"needs_confirmation":true,...}' }.
 *   3. The voice layer surfaces this to the user ("say confirm"); once the
 *      user confirms, the model re-calls the SAME tool with the SAME args
 *      plus `confirmed: true`, and the tool actually executes.
 * The `confirmed` parameter is injected into the tool schema so the model
 * knows it exists; it is stripped before hitting Composio.
 */
import { createHash } from 'node:crypto'
import { getAuthConfigId, getComposio, getUserId, hasComposioKey } from './composioClient'

export interface RealtimeFunctionTool {
  type: 'function'
  name: string
  description: string
  parameters: Record<string, unknown>
}

/** Curated slugs per toolkit — verified real in docs/research/composio-connectors.md §13. */
const CURATED: Record<string, string[]> = {
  GMAIL: [
    'GMAIL_FETCH_EMAILS',
    'GMAIL_SEND_EMAIL',
    'GMAIL_CREATE_EMAIL_DRAFT',
    'GMAIL_REPLY_TO_THREAD'
  ],
  GOOGLECALENDAR: [
    'GOOGLECALENDAR_EVENTS_LIST',
    'GOOGLECALENDAR_CREATE_EVENT',
    'GOOGLECALENDAR_FIND_EVENT',
    'GOOGLECALENDAR_FIND_FREE_SLOTS'
  ]
}

/** Tools with real-world side effects: require the confirmation round-trip. */
const CONFIRM_REQUIRED = new Set([
  'GMAIL_SEND_EMAIL',
  'GMAIL_REPLY_TO_THREAD',
  'GOOGLECALENDAR_CREATE_EVENT'
])

const ALL_CURATED = new Set(Object.values(CURATED).flat())

const MAX_RESULT_CHARS = 1_500
const TOOL_CACHE_TTL_MS = 10 * 60 * 1000

const CONFIRM_NOTE =
  ' SIDE-EFFECT TOOL: first call it WITHOUT `confirmed` to get a preview, ask the user to confirm out loud, then call again with the same arguments plus `confirmed: true` to actually perform the action.'

// ---------- tool schema fetch ----------

let toolCache: { tools: RealtimeFunctionTool[]; at: number; key: string } | null = null

function enabledSlugs(): string[] {
  return Object.entries(CURATED)
    .filter(([toolkit]) => getAuthConfigId(toolkit) !== null)
    .flatMap(([, slugs]) => slugs)
}

function injectConfirmed(parameters: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(parameters ?? { type: 'object', properties: {} })) as {
    type?: string
    properties?: Record<string, unknown>
    [k: string]: unknown
  }
  clone.type = clone.type ?? 'object'
  clone.properties = {
    ...(clone.properties ?? {}),
    confirmed: {
      type: 'boolean',
      description:
        'Set true ONLY after the user has explicitly confirmed this action out loud. Omit on the first call.'
    }
  }
  return clone as Record<string, unknown>
}

/**
 * Flattened function tools for the realtime session. Empty array when the
 * Composio key is missing, no toolkit is configured, or the fetch fails —
 * the voice session simply runs without connector tools.
 */
export async function getVoiceTools(): Promise<RealtimeFunctionTool[]> {
  if (!hasComposioKey()) return []
  const slugs = enabledSlugs()
  if (slugs.length === 0) return []

  const cacheKey = slugs.join(',')
  if (toolCache && toolCache.key === cacheKey && Date.now() - toolCache.at < TOOL_CACHE_TTL_MS) {
    return toolCache.tools
  }

  try {
    const composio = await getComposio()
    if (!composio) return []
    const rawTools = await composio.tools.getRawComposioTools({ tools: slugs })
    const tools: RealtimeFunctionTool[] = rawTools.map((tool) => {
      const confirmable = CONFIRM_REQUIRED.has(tool.slug)
      const parameters = (tool.inputParameters ?? { type: 'object', properties: {} }) as Record<
        string,
        unknown
      >
      return {
        type: 'function',
        name: tool.slug,
        description: (tool.description ?? tool.name) + (confirmable ? CONFIRM_NOTE : ''),
        parameters: confirmable
          ? injectConfirmed(parameters)
          : (JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>)
      }
    })
    toolCache = { tools, at: Date.now(), key: cacheKey }
    return tools
  } catch (error) {
    console.error('[connectors] getVoiceTools failed:', error)
    return []
  }
}

/** Drop the schema cache (e.g. after connectors.json changes). */
export function invalidateVoiceToolCache(): void {
  toolCache = null
}

// ---------- execution ----------

export interface ToolExecutionResult {
  ok: boolean
  resultJson: string
}

function failure(payload: Record<string, unknown>): ToolExecutionResult {
  return { ok: false, resultJson: JSON.stringify(payload) }
}

// ---------- confirmation state (two-step preview → confirm protocol) ----------

const CONFIRM_TTL_MS = 2 * 60 * 1000

/** Last previewed arguments per side-effect tool; confirm must match exactly. */
const pendingConfirmations = new Map<string, { argsHash: string; at: number }>()

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    return `{${entries.join(',')}}`
  }
  // Args come from JSON.parse, so primitives are string/number/boolean/null.
  return JSON.stringify(value ?? null)
}

function confirmationHash(name: string, args: Record<string, unknown>): string {
  const rest: Record<string, unknown> = { ...args }
  delete rest.confirmed
  return createHash('sha256')
    .update(`${name}:${stableStringify(rest)}`)
    .digest('hex')
}

/**
 * Execute a curated connector tool on behalf of the realtime session.
 * Never throws — every outcome is an { ok, resultJson } envelope the voice
 * layer feeds straight back as the function_call_output.
 */
export async function executeTool(name: string, argsJson: string): Promise<ToolExecutionResult> {
  if (!ALL_CURATED.has(name)) {
    return failure({
      error: `Unknown tool: ${name}. Only curated Gmail/Calendar tools are available.`
    })
  }
  if (!hasComposioKey()) {
    return failure({
      error:
        'Composio is not configured. Ask the user to add COMPOSIO_API_KEY (docs/CONNECTORS.md).'
    })
  }

  let args: Record<string, unknown>
  try {
    args = argsJson.trim() ? (JSON.parse(argsJson) as Record<string, unknown>) : {}
    if (args === null || typeof args !== 'object' || Array.isArray(args)) {
      throw new Error('arguments must be a JSON object')
    }
  } catch (error) {
    return failure({ error: `Invalid tool arguments JSON: ${String(error)}` })
  }

  // Confirmation gate for side-effectful tools. `confirmed: true` is only
  // honored when the SAME tool+arguments were previewed first — a bare
  // confirmed-on-first-call (e.g. induced by prompt-injected content the model
  // just read) is rejected and restarts the preview step. It never becomes a
  // valid preview itself, so injection cannot self-confirm in one round.
  if (CONFIRM_REQUIRED.has(name)) {
    const argsHash = confirmationHash(name, args)
    if (args.confirmed !== true) {
      pendingConfirmations.set(name, { argsHash, at: Date.now() })
      return failure({
        needs_confirmation: true,
        tool: name,
        preview: compactPreview(args),
        message:
          'This action needs explicit user confirmation. Read the preview back to the user, ask them to confirm out loud, then call the tool again with the same arguments plus confirmed: true.'
      })
    }
    const pending = pendingConfirmations.get(name)
    const previewed =
      pending !== undefined &&
      pending.argsHash === argsHash &&
      Date.now() - pending.at < CONFIRM_TTL_MS
    if (!previewed) {
      return failure({
        needs_confirmation: true,
        tool: name,
        preview: compactPreview(args),
        message:
          'Confirmation rejected: this exact action was never previewed to the user (or the arguments changed). Call the tool WITHOUT confirmed first, read the preview back to the user, wait for their spoken confirmation, then retry with confirmed: true.'
      })
    }
    pendingConfirmations.delete(name)
  }
  delete args.confirmed // Composio schemas do not know this parameter

  try {
    const composio = await getComposio()
    if (!composio) return failure({ error: 'Composio client unavailable' })
    const result = await composio.tools.execute(name, {
      userId: getUserId(),
      arguments: args
    })
    if (!result.successful) {
      return failure({ error: result.error ?? 'Tool execution failed' })
    }
    return { ok: true, resultJson: truncateResult(name, result.data) }
  } catch (error) {
    return failure({ error: error instanceof Error ? error.message : String(error) })
  }
}

// ---------- result truncation ----------

function compactPreview(args: Record<string, unknown>): Record<string, unknown> {
  const preview: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(args)) {
    if (key === 'confirmed') continue
    preview[key] =
      typeof value === 'string' && value.length > 200 ? `${value.slice(0, 200)}…` : value
  }
  return preview
}

function clipString(value: unknown, max: number): unknown {
  return typeof value === 'string' && value.length > max ? `${value.slice(0, max)}…` : value
}

function pickFirst(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    const value = obj[key]
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/** Compact one Gmail message object down to sender/subject/date/snippet. */
function compactMessage(message: Record<string, unknown>): Record<string, unknown> {
  const compact: Record<string, unknown> = {}
  const from = pickFirst(message, ['sender', 'from', 'fromEmail', 'from_email'])
  const subject = pickFirst(message, ['subject'])
  const date = pickFirst(message, ['messageTimestamp', 'message_timestamp', 'date', 'internalDate'])
  const snippet = pickFirst(message, ['preview', 'snippet', 'messageText', 'message_text', 'body'])
  const id = pickFirst(message, ['messageId', 'message_id', 'id'])
  const threadId = pickFirst(message, ['threadId', 'thread_id'])
  if (from !== undefined) compact.from = clipString(from, 120)
  if (subject !== undefined) compact.subject = clipString(subject, 150)
  if (date !== undefined) compact.date = clipString(date, 40)
  if (snippet !== undefined) compact.snippet = clipString(snippet, 200)
  if (id !== undefined) compact.id = id
  if (threadId !== undefined) compact.threadId = threadId
  return compact
}

/**
 * Voice models don't need raw MIME parts. Gmail fetches are compacted to
 * sender/subject/date/snippet; everything is capped near MAX_RESULT_CHARS
 * while staying valid JSON.
 */
export function truncateResult(name: string, data: Record<string, unknown>): string {
  let shaped: unknown = data

  if (name === 'GMAIL_FETCH_EMAILS') {
    const messages = (['messages', 'emails', 'items'] as const)
      .map((key) => data[key])
      .find((value) => Array.isArray(value)) as unknown[] | undefined
    if (messages) {
      shaped = {
        messages: messages
          .slice(0, 10)
          .map((m) =>
            m && typeof m === 'object' ? compactMessage(m as Record<string, unknown>) : m
          ),
        totalFetched: messages.length
      }
    }
  } else if (name === 'GOOGLECALENDAR_EVENTS_LIST' || name === 'GOOGLECALENDAR_FIND_EVENT') {
    const events = (['events', 'items'] as const)
      .map((key) => data[key])
      .find((value) => Array.isArray(value)) as unknown[] | undefined
    if (events) {
      shaped = {
        events: events.slice(0, 15).map((event) => {
          if (!event || typeof event !== 'object') return event
          const e = event as Record<string, unknown>
          return {
            summary: clipString(pickFirst(e, ['summary', 'title']), 120),
            start: pickFirst(e, ['start', 'startTime', 'start_time']),
            end: pickFirst(e, ['end', 'endTime', 'end_time']),
            location: clipString(pickFirst(e, ['location']), 100),
            id: pickFirst(e, ['id', 'eventId', 'event_id'])
          }
        }),
        totalFetched: events.length
      }
    }
  }

  let json = JSON.stringify(shaped)
  if (json.length <= MAX_RESULT_CHARS) return json

  // Still too big: wrap a sliced preview so the payload stays valid JSON.
  json = JSON.stringify({
    truncated: true,
    note: `Result truncated to ${MAX_RESULT_CHARS} chars for the voice session`,
    preview: json.slice(0, MAX_RESULT_CHARS)
  })
  return json
}
