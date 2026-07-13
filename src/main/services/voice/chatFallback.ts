/**
 * No-key fallback lane (D1): text chat over the ChatGPT-token Codex backend.
 * POST https://chatgpt.com/backend-api/codex/responses (SSE) — transport details verified in
 * docs/research/chatgpt-oauth.md §6 (headers, client_version gate, stateless body rules).
 */
import type { ChatDelta } from '../../../shared/types'
import { JARVIS_PERSONA } from '../../../shared/persona'
import { accountIdFromToken, readCodexAuthFile } from './codexAuthFile'
import { getAccessToken, getAccountId } from '../auth'

const RESPONSES_URL = 'https://chatgpt.com/backend-api/codex/responses'
/** Keep near the bundled @openai/codex-sdk version — the backend gates models on it. */
const CODEX_CLIENT_VERSION = process.env.JARVIS_CODEX_CLIENT_VERSION?.trim() || '0.144.3'
const FALLBACK_MODEL = process.env.JARVIS_FALLBACK_MODEL?.trim() || 'gpt-5.5'
const MAX_HISTORY_TURNS = 24
const STREAM_TIMEOUT_MS = 180_000

export interface ChatSendRequest {
  requestId: string
  text: string
  history: { role: 'user' | 'assistant'; text: string }[]
}

async function resolveChatGptAuth(): Promise<{ accessToken: string; accountId: string } | null> {
  let accessToken: string | null = null
  let accountId: string | null = null
  try {
    accessToken = await getAccessToken()
    accountId = getAccountId()
  } catch {
    // auth service not registered yet — fall through to the on-disk mirror
  }

  if (!accessToken || !accountId) {
    // Mirror on disk (auth service writes it; codex login produces the same shape).
    const file = await readCodexAuthFile()
    const tokens = file?.tokens
    if (!accessToken && typeof tokens?.access_token === 'string' && tokens.access_token) {
      accessToken = tokens.access_token
    }
    if (!accountId && typeof tokens?.account_id === 'string' && tokens.account_id) {
      accountId = tokens.account_id
    }
    if (!accountId && accessToken) accountId = accountIdFromToken(accessToken)
    if (!accountId && typeof tokens?.id_token === 'string' && tokens.id_token) {
      accountId = accountIdFromToken(tokens.id_token)
    }
  }

  if (!accessToken || !accountId) return null
  return { accessToken, accountId }
}

type ResponsesInputItem = {
  type: 'message'
  role: 'user' | 'assistant'
  content: { type: 'input_text' | 'output_text'; text: string }[]
}

function buildInput(req: ChatSendRequest): ResponsesInputItem[] {
  const turns = req.history.slice(-MAX_HISTORY_TURNS)
  const items: ResponsesInputItem[] = turns
    .filter((t) => typeof t.text === 'string' && t.text.trim().length > 0)
    .map((t) => ({
      type: 'message' as const,
      role: t.role,
      content: [
        {
          type: t.role === 'assistant' ? ('output_text' as const) : ('input_text' as const),
          text: t.text
        }
      ]
    }))
  items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: req.text }] })
  return items
}

/** Stateless body per research §6c: store:false, reasoning on, encrypted content included. */
function buildBody(req: ChatSendRequest): Record<string, unknown> {
  return {
    model: FALLBACK_MODEL,
    store: false,
    stream: true,
    instructions: JARVIS_PERSONA,
    input: buildInput(req),
    reasoning: { effort: 'low', summary: 'auto' },
    include: ['reasoning.encrypted_content'],
    tools: [],
    tool_choice: 'none',
    parallel_tool_calls: false
    // NOTE: max_output_tokens is rejected by this backend — never send it.
  }
}

type SseEvent = { type?: string } & Record<string, unknown>

function parseSseData(data: string): SseEvent | null {
  try {
    const parsed = JSON.parse(data)
    return parsed && typeof parsed === 'object' ? (parsed as SseEvent) : null
  } catch {
    return null
  }
}

function extractErrorMessage(ev: SseEvent): string {
  const err =
    (ev.error as Record<string, unknown> | undefined) ??
    ((ev.response as Record<string, unknown> | undefined)?.error as
      Record<string, unknown> | undefined)
  const msg = err?.message
  return typeof msg === 'string' && msg.length > 0 ? msg : 'The model stream reported an error.'
}

/**
 * Stream one fallback-lane turn. Deltas are delivered through `push` (IPC chat:delta).
 * Always terminates with a `done` or `error` delta for the requestId.
 */
export async function streamChatFallback(
  req: ChatSendRequest,
  push: (delta: ChatDelta) => void
): Promise<void> {
  const requestId = req.requestId
  const auth = await resolveChatGptAuth()
  if (!auth) {
    push({
      requestId,
      kind: 'error',
      error: 'Not signed in with ChatGPT — sign in first, then try again.'
    })
    return
  }

  let finished = false
  const finish = (delta: ChatDelta): void => {
    if (finished) return
    finished = true
    push(delta)
  }

  try {
    const url = `${RESPONSES_URL}?client_version=${encodeURIComponent(CODEX_CLIENT_VERSION)}`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'ChatGPT-Account-ID': auth.accountId,
        'OpenAI-Beta': 'responses=experimental',
        originator: 'codex_cli_rs',
        'Content-Type': 'application/json',
        Accept: 'text/event-stream'
      },
      body: JSON.stringify(buildBody(req)),
      signal: AbortSignal.timeout(STREAM_TIMEOUT_MS)
    })

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '')
      const hint =
        res.status === 401
          ? 'The ChatGPT session token was rejected — sign in again.'
          : res.status === 429
            ? 'Rate limited by the ChatGPT backend — wait a moment.'
            : body.slice(0, 200)
      finish({
        requestId,
        kind: 'error',
        error: `Chat request failed (HTTP ${res.status}). ${hint}`
      })
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let dataLines: string[] = []

    const handleEvent = (ev: SseEvent): void => {
      const type = typeof ev.type === 'string' ? ev.type : ''
      if (type === 'response.output_text.delta') {
        const delta = ev.delta
        if (typeof delta === 'string' && delta.length > 0) {
          push({ requestId, kind: 'text_delta', text: delta })
        }
      } else if (type === 'response.completed' || type === 'response.incomplete') {
        finish({ requestId, kind: 'done' })
      } else if (type === 'response.failed' || type === 'error') {
        finish({ requestId, kind: 'error', error: extractErrorMessage(ev) })
      }
    }

    const flushEvent = (): void => {
      if (dataLines.length === 0) return
      const data = dataLines.join('\n')
      dataLines = []
      if (data === '[DONE]') {
        finish({ requestId, kind: 'done' })
        return
      }
      const ev = parseSseData(data)
      if (ev) handleEvent(ev)
    }

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        if (line === '') flushEvent()
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
        // ignore event:/id:/retry:/comment lines
        newlineIndex = buffer.indexOf('\n')
      }
      if (finished) {
        await reader.cancel().catch(() => undefined)
        return
      }
    }
    flushEvent()
    // Stream ended without a terminal event — an empty stream usually means the stateless
    // body rules were violated or the model is unavailable; still resolve the turn.
    finish({ requestId, kind: 'done' })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    finish({ requestId, kind: 'error', error: `Chat stream failed: ${msg}` })
  }
}
