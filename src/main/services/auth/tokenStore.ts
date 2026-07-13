/**
 * Token persistence (D3):
 *  1. App-side: Electron safeStorage (Keychain-backed) → <userData>/auth.enc
 *  2. Mirror:   ~/.codex/auth.json in the exact documented Codex CLI shape
 *     (mode 0600, atomic write) so Codex CLI inherits the same session.
 *  3. Adopt:    on startup with no app tokens, a valid existing ~/.codex/auth.json
 *     signs the user in instantly.
 *
 * Tokens never leave the main process.
 */
import { app, safeStorage } from 'electron'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { extractClaims } from './jwt'

export interface StoredAuth {
  idToken: string
  accessToken: string
  refreshToken: string
  /** chatgpt_account_id derived from the JWTs. */
  accountId: string | null
  /** Platform API key (D1 ladder steps 1-2), if any. */
  openaiApiKey: string | null
  apiKeySource: 'codex-auth-json' | 'token-exchange' | null
  /** RFC3339 UTC — mirrors Codex's last_refresh; used for clobber protection. */
  lastRefresh: string
}

// ---------- app-side store (safeStorage) ----------

interface AuthFileEnvelope {
  v: 1
  enc: boolean
  data: string // base64 — encrypted bytes when enc, plain utf8 JSON bytes when not
}

function appAuthPath(): string {
  return join(app.getPath('userData'), 'auth.enc')
}

export function loadStoredAuth(): StoredAuth | null {
  try {
    const path = appAuthPath()
    if (!existsSync(path)) return null
    const envelope = JSON.parse(readFileSync(path, 'utf8')) as AuthFileEnvelope
    if (!envelope || typeof envelope.data !== 'string') return null
    const raw = envelope.enc
      ? safeStorage.decryptString(Buffer.from(envelope.data, 'base64'))
      : Buffer.from(envelope.data, 'base64').toString('utf8')
    const parsed = JSON.parse(raw) as StoredAuth
    if (!parsed.accessToken || !parsed.refreshToken || !parsed.idToken) return null
    return parsed
  } catch {
    return null
  }
}

export function saveStoredAuth(auth: StoredAuth): void {
  const json = JSON.stringify(auth)
  const canEncrypt = safeStorage.isEncryptionAvailable()
  const envelope: AuthFileEnvelope = {
    v: 1,
    enc: canEncrypt,
    data: canEncrypt
      ? safeStorage.encryptString(json).toString('base64')
      : Buffer.from(json, 'utf8').toString('base64')
  }
  writeFileAtomic(appAuthPath(), JSON.stringify(envelope), 0o600)
}

export function clearStoredAuth(): void {
  try {
    unlinkSync(appAuthPath())
  } catch {
    /* already gone */
  }
}

// ---------- ~/.codex/auth.json mirror (documented Codex CLI shape) ----------

interface CodexAuthDotJson {
  OPENAI_API_KEY: string | null
  tokens: {
    id_token: string
    access_token: string
    refresh_token: string
    account_id: string | null
  } | null
  last_refresh: string | null
  auth_mode?: string
}

export function codexAuthJsonPath(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
  return join(
    codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex'),
    'auth.json'
  )
}

function readCodexAuthJson(): CodexAuthDotJson | null {
  try {
    const path = codexAuthJsonPath()
    if (!existsSync(path)) return null
    return JSON.parse(readFileSync(path, 'utf8')) as CodexAuthDotJson
  } catch {
    return null
  }
}

function parseTimeMs(rfc3339: string | null | undefined): number {
  if (!rfc3339) return 0
  const t = Date.parse(rfc3339)
  return Number.isFinite(t) ? t : 0
}

/**
 * Mirror our session into ~/.codex/auth.json (mode 0600, atomic rename).
 * Clobber protection: if an existing file has a strictly newer last_refresh
 * (e.g. the user ran `codex login` after our last refresh), leave it alone.
 */
export function mirrorToCodexAuthJson(auth: StoredAuth): void {
  try {
    const existing = readCodexAuthJson()
    if (existing && parseTimeMs(existing.last_refresh) > parseTimeMs(auth.lastRefresh)) {
      return
    }
    const payload: CodexAuthDotJson = {
      OPENAI_API_KEY: auth.openaiApiKey,
      tokens: {
        id_token: auth.idToken,
        access_token: auth.accessToken,
        refresh_token: auth.refreshToken,
        account_id: auth.accountId
      },
      last_refresh: auth.lastRefresh,
      auth_mode: 'chatgpt'
    }
    writeFileAtomic(codexAuthJsonPath(), JSON.stringify(payload, null, 2), 0o600)
  } catch {
    // Mirror is best-effort — the app-side store is authoritative.
  }
}

/**
 * Startup adoption: if ~/.codex/auth.json holds a usable ChatGPT session,
 * lift it into a StoredAuth (instant sign-in for existing Codex CLI users).
 * An expired access token is fine — the refresh flow renews it on first use.
 */
export function adoptCodexAuthJson(): StoredAuth | null {
  const codex = readCodexAuthJson()
  const tokens = codex?.tokens
  if (!codex || !tokens?.id_token || !tokens.access_token || !tokens.refresh_token) return null
  const claims = extractClaims(tokens.id_token, tokens.access_token)
  const hasKey = typeof codex.OPENAI_API_KEY === 'string' && codex.OPENAI_API_KEY.length > 0
  return {
    idToken: tokens.id_token,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    accountId: tokens.account_id ?? claims.accountId,
    openaiApiKey: hasKey ? codex.OPENAI_API_KEY : null,
    apiKeySource: hasKey ? 'codex-auth-json' : null,
    lastRefresh: codex.last_refresh ?? new Date().toISOString()
  }
}

/**
 * D1 ladder step 1: an existing codex login may carry a minted Platform key
 * even when our own token-exchange attempt failed. Read just that key.
 */
export function readCodexApiKey(): string | null {
  const codex = readCodexAuthJson()
  return typeof codex?.OPENAI_API_KEY === 'string' && codex.OPENAI_API_KEY.length > 0
    ? codex.OPENAI_API_KEY
    : null
}

/**
 * Sign-out: remove the mirror only when it is OUR session (same refresh token
 * or same account id) — never delete a login the user made separately with a
 * different account via `codex login`.
 */
export function removeCodexMirrorIfOurs(auth: StoredAuth): void {
  try {
    const existing = readCodexAuthJson()
    const tokens = existing?.tokens
    if (!tokens) return
    const ours =
      tokens.refresh_token === auth.refreshToken ||
      (auth.accountId !== null && tokens.account_id === auth.accountId)
    if (ours) unlinkSync(codexAuthJsonPath())
  } catch {
    /* best-effort */
  }
}

// ---------- helpers ----------

function writeFileAtomic(path: string, contents: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, contents, { mode })
  chmodSync(tmp, mode)
  renameSync(tmp, path)
}
