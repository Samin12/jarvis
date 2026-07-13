/**
 * Read-only access to ~/.codex/auth.json (documented shape, see docs/research/chatgpt-oauth.md §7).
 * The auth service owns writing this file; voice only reads it (D1 rung 1 + fallback-lane tokens).
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface CodexAuthTokens {
  id_token?: string | null
  access_token?: string | null
  refresh_token?: string | null
  account_id?: string | null
}

export interface CodexAuthFile {
  OPENAI_API_KEY?: string | null
  tokens?: CodexAuthTokens | null
}

export function codexAuthPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
  return join(
    codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex'),
    'auth.json'
  )
}

export async function readCodexAuthFile(): Promise<CodexAuthFile | null> {
  try {
    const raw = await readFile(codexAuthPath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed as CodexAuthFile
    return null
  } catch {
    return null // missing file, bad JSON, permissions — all mean "no codex auth"
  }
}

/** Decode a JWT payload without verification (tokens come from OpenAI over TLS). */
export function decodeJwtClaims(jwt: string): Record<string, unknown> | null {
  try {
    const payload = jwt.split('.')[1]
    if (!payload) return null
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(
      'utf8'
    )
    const claims = JSON.parse(json)
    return claims && typeof claims === 'object' ? (claims as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Pull the ChatGPT account id out of an access/id token's namespaced auth claim. */
export function accountIdFromToken(jwt: string): string | null {
  const claims = decodeJwtClaims(jwt)
  const auth = claims?.['https://api.openai.com/auth']
  if (auth && typeof auth === 'object') {
    const id = (auth as Record<string, unknown>).chatgpt_account_id
    if (typeof id === 'string' && id.length > 0) return id
  }
  return null
}
