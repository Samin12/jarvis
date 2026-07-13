/**
 * Mint ephemeral Realtime client secrets (ek_...) from the main process.
 * POST https://api.openai.com/v1/realtime/client_secrets — GA interface, no beta header.
 * Research: docs/research/gpt-live-voice.md §2.3–§2.4.
 */
import type { RealtimeSessionGrant } from '../../../shared/types'
import { JARVIS_PERSONA_REALTIME } from '../../../shared/persona'

const CLIENT_SECRETS_URL = 'https://api.openai.com/v1/realtime/client_secrets'
const SECRET_TTL_SECONDS = 600 // renderer connects immediately after minting

export interface MintOptions {
  model: string // gpt-realtime-2.1 | gpt-realtime-2.1-mini
  voice: string // marin, cedar, ...
}

function sessionBody(opts: MintOptions): Record<string, unknown> {
  return {
    expires_after: { anchor: 'created_at', seconds: SECRET_TTL_SECONDS },
    session: {
      type: 'realtime',
      model: opts.model,
      instructions: JARVIS_PERSONA_REALTIME,
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
          turn_detection: { type: 'semantic_vad', eagerness: 'auto' },
          transcription: { model: 'gpt-realtime-whisper' }
        },
        output: { voice: opts.voice, speed: 1.0 }
      }
    }
  }
}

function errorForStatus(status: number, bodySnippet: string): string {
  if (status === 401) {
    return 'OpenAI rejected the API key (401). It may be revoked or malformed — re-sign in, run `codex login`, or paste a fresh Platform key in Settings.'
  }
  if (status === 403) {
    return 'This API key is not allowed to use the Realtime API (403). Check that the key belongs to a Platform org with Realtime access.'
  }
  if (status === 429) {
    return 'OpenAI rate limit hit while starting the voice session (429). Wait a moment and try again.'
  }
  return `Could not mint a Realtime session (HTTP ${status}). ${bodySnippet}`.trim()
}

async function postClientSecret(
  key: string,
  opts: MintOptions
): Promise<RealtimeSessionGrant | { error: string; status?: number }> {
  let res: Response
  try {
    res = await fetch(CLIENT_SECRETS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(sessionBody(opts)),
      signal: AbortSignal.timeout(20_000)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { error: `Could not reach api.openai.com to start the voice session: ${msg}` }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return { error: errorForStatus(res.status, body.slice(0, 300)), status: res.status }
  }

  const json = (await res.json().catch(() => null)) as {
    value?: string
    expires_at?: number
  } | null
  if (!json || typeof json.value !== 'string' || json.value.length === 0) {
    return { error: 'OpenAI returned an unexpected client_secrets response (no value).' }
  }

  return {
    clientSecret: json.value,
    expiresAt:
      typeof json.expires_at === 'number'
        ? json.expires_at * 1000
        : Date.now() + SECRET_TTL_SECONDS * 1000,
    model: opts.model,
    voice: opts.voice
  }
}

/**
 * Mint a grant, retrying the older mini alias if the 2.1-mini id is not recognized
 * (naming inconsistency called out in the research — §2.1 trap note).
 */
export async function mintRealtimeSession(
  key: string,
  opts: MintOptions
): Promise<RealtimeSessionGrant | { error: string }> {
  const first = await postClientSecret(key, opts)
  if (!('error' in first)) return first
  if (
    opts.model === 'gpt-realtime-2.1-mini' &&
    typeof first.status === 'number' &&
    first.status >= 400 &&
    first.status < 500 &&
    first.status !== 401 &&
    first.status !== 403 &&
    first.status !== 429
  ) {
    const retry = await postClientSecret(key, { ...opts, model: 'gpt-realtime-mini' })
    if (!('error' in retry)) return retry
  }
  return { error: first.error }
}
