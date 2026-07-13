/**
 * AuthService — ChatGPT OAuth (PKCE loopback), token lifecycle, IPC wiring.
 *
 * Integration: call registerAuth(ipcMain, getWindow) once after app.whenReady()
 * (safeStorage needs a ready app). Other main-process services import the
 * module-level accessors below (getAccessToken / getAccountId / getPlatformApiKey).
 */
import { shell, type BrowserWindow, type IpcMain } from 'electron'
import { IPC } from '../../../shared/ipc'
import type { AuthStatus } from '../../../shared/types'
import { extractClaims, tokenExpiryMs } from './jwt'
import {
  buildAuthorizeUrl,
  exchangeCode,
  exchangeForApiKey,
  REFRESH_MARGIN_MS,
  RefreshDeadError,
  refreshTokens
} from './oauth'
import { generatePkce, generateState } from './pkce'
import { startLoginServer, type LoginServerHandle } from './server'
import {
  adoptCodexAuthJson,
  clearStoredAuth,
  loadStoredAuth,
  mirrorToCodexAuthJson,
  readCodexApiKey,
  removeCodexMirrorIfOurs,
  saveStoredAuth,
  type StoredAuth
} from './tokenStore'

// ---------- module state (main process only — tokens never cross IPC) ----------

let stored: StoredAuth | null = null
let status: AuthStatus = { state: 'signed_out' }
let manualApiKey: string | null = null
let activeFlow: LoginServerHandle | null = null
let refreshInFlight: Promise<void> | null = null
let getWindowRef: (() => BrowserWindow | null) | null = null

// ---------- public accessors for sibling services (voice imports these) ----------

/**
 * Current ChatGPT access token, refreshed automatically when within 60s of
 * expiry. Returns null when signed out or when the refresh token died
 * (in which case status flips to signed_out and the HUD shows login).
 */
export async function getAccessToken(): Promise<string | null> {
  if (!stored) return null
  const exp = tokenExpiryMs(stored.accessToken)
  if (exp === null || exp - Date.now() < REFRESH_MARGIN_MS) {
    await ensureRefreshed()
  }
  return stored?.accessToken ?? null
}

/** chatgpt_account_id — send as ChatGPT-Account-ID header on backend-api calls. */
export function getAccountId(): string | null {
  return stored?.accountId ?? null
}

/**
 * Platform API key per the D1 ladder:
 * codex auth.json / token-exchange mint → pasted Settings key → OPENAI_API_KEY env.
 * Null means voice must use the no-key fallback lane.
 */
export function getPlatformApiKey(): string | null {
  return stored?.openaiApiKey ?? manualApiKey ?? envApiKey()
}

/** Raw id_token (needed for future RFC 8693 exchanges). */
export function getIdToken(): string | null {
  return stored?.idToken ?? null
}

/** Snapshot of the current auth status (same object pushed on auth:status-changed). */
export function getAuthStatus(): AuthStatus {
  return status
}

/**
 * Voice service calls this when the user pastes/clears a Platform key in
 * Settings (D1 ladder step 3) so status.voiceKeyAvailable stays truthful.
 */
export function setManualPlatformApiKey(key: string | null): void {
  manualApiKey = key && key.trim().length > 0 ? key.trim() : null
  recomputeStatus()
  pushStatus()
}

// ---------- registration ----------

export function registerAuth(ipcMain: IpcMain, getWindow: () => BrowserWindow | null): void {
  getWindowRef = getWindow

  // Load persisted session; else adopt an existing Codex CLI login (D3 read-side).
  stored = loadStoredAuth()
  if (!stored) {
    stored = adoptCodexAuthJson()
    if (stored) {
      try {
        saveStoredAuth(stored)
      } catch {
        /* adoption still works in-memory */
      }
    }
  } else if (!stored.openaiApiKey) {
    // Ladder step 1: a codex login done after our last save may carry a key.
    const codexKey = readCodexApiKey()
    if (codexKey) {
      stored = { ...stored, openaiApiKey: codexKey, apiKeySource: 'codex-auth-json' }
      try {
        saveStoredAuth(stored)
      } catch {
        /* non-fatal */
      }
    }
  }
  recomputeStatus()

  ipcMain.handle(IPC.auth.signIn, async (): Promise<AuthStatus> => signIn())
  ipcMain.handle(IPC.auth.signOut, async (): Promise<void> => signOut())
  ipcMain.handle(IPC.auth.getStatus, (): AuthStatus => status)
}

// ---------- sign-in flow ----------

async function signIn(): Promise<AuthStatus> {
  // A retry while a browser flow is pending replaces the old flow.
  if (activeFlow) {
    activeFlow.cancel('Superseded by a new sign-in attempt')
    activeFlow = null
  }

  status = { state: 'authorizing' }
  pushStatus()

  try {
    const pkce = generatePkce()
    const state = generateState()

    const flow = await startLoginServer({
      expectedState: state,
      onCode: async (code, redirectUri) => {
        const tokens = await exchangeCode({
          code,
          redirectUri,
          codeVerifier: pkce.verifier
        })
        // D1 ladder step 2 — best-effort; consumer accounts get null, that's fine.
        const mintedKey = await exchangeForApiKey(tokens.idToken)
        const claims = extractClaims(tokens.idToken, tokens.accessToken)
        const codexKey = mintedKey ? null : readCodexApiKey()
        const next: StoredAuth = {
          idToken: tokens.idToken,
          accessToken: tokens.accessToken,
          refreshToken: tokens.refreshToken,
          accountId: claims.accountId,
          openaiApiKey: mintedKey ?? codexKey,
          apiKeySource: mintedKey ? 'token-exchange' : codexKey ? 'codex-auth-json' : null,
          lastRefresh: new Date().toISOString()
        }
        saveStoredAuth(next)
        mirrorToCodexAuthJson(next)
        stored = next
      }
    })
    activeFlow = flow

    const opened = await shell
      .openExternal(
        buildAuthorizeUrl({ redirectUri: flow.redirectUri, codeChallenge: pkce.challenge, state })
      )
      .then(() => true)
      .catch(() => false)
    if (!opened) {
      flow.cancel('Could not open the system browser')
    }

    await flow.done
    recomputeStatus()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    status = { state: 'error', message }
  } finally {
    activeFlow = null
  }

  pushStatus()
  return status
}

function signOut(): void {
  if (activeFlow) {
    activeFlow.cancel('Signed out')
    activeFlow = null
  }
  if (stored) {
    removeCodexMirrorIfOurs(stored)
  }
  clearStoredAuth()
  stored = null
  status = { state: 'signed_out' }
  pushStatus()
}

// ---------- refresh ----------

function ensureRefreshed(): Promise<void> {
  if (!refreshInFlight) {
    refreshInFlight = doRefresh().finally(() => {
      refreshInFlight = null
    })
  }
  return refreshInFlight
}

async function doRefresh(): Promise<void> {
  if (!stored) return
  try {
    const result = await refreshTokens(stored.refreshToken)
    const next: StoredAuth = {
      ...stored,
      idToken: result.idToken ?? stored.idToken,
      accessToken: result.accessToken ?? stored.accessToken,
      refreshToken: result.refreshToken ?? stored.refreshToken,
      lastRefresh: new Date().toISOString()
    }
    if (!next.accountId) {
      next.accountId = extractClaims(next.idToken, next.accessToken).accountId
    }
    saveStoredAuth(next)
    mirrorToCodexAuthJson(next)
    stored = next
    recomputeStatus()
    pushStatus()
  } catch (err) {
    if (err instanceof RefreshDeadError) {
      // Permanent — force a full re-login.
      clearStoredAuth()
      stored = null
      status = { state: 'signed_out' }
      pushStatus()
      return
    }
    // Transient (network etc.) — keep the session, caller may retry.
  }
}

// ---------- status ----------

function envApiKey(): string | null {
  const key = process.env.OPENAI_API_KEY?.trim()
  return key && key.length > 0 ? key : null
}

function recomputeStatus(): void {
  if (!stored) {
    if (status.state !== 'authorizing' && status.state !== 'error') {
      status = { state: 'signed_out' }
    }
    return
  }
  const claims = extractClaims(stored.idToken, stored.accessToken)
  let voiceKeySource: 'codex-auth-json' | 'token-exchange' | 'env' | 'settings' | null = null
  if (stored.openaiApiKey) voiceKeySource = stored.apiKeySource
  else if (manualApiKey) voiceKeySource = 'settings'
  else if (envApiKey()) voiceKeySource = 'env'
  status = {
    state: 'signed_in',
    email: claims.email,
    planType: claims.planType,
    accountId: stored.accountId ?? claims.accountId ?? '',
    voiceKeyAvailable: voiceKeySource !== null,
    voiceKeySource
  }
}

function pushStatus(): void {
  const win = getWindowRef?.()
  if (win && !win.isDestroyed()) {
    win.webContents.send(IPC.auth.statusChanged, status)
  }
}
