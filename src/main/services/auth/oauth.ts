/**
 * ChatGPT OAuth against auth.openai.com, mirroring the Codex CLI flow
 * (docs/research/chatgpt-oauth.md — verified against codex-rs/login sources).
 *
 * - authorize:      GET  https://auth.openai.com/oauth/authorize  (PKCE S256)
 * - code exchange:  POST https://auth.openai.com/oauth/token      (form-encoded)
 * - refresh:        POST https://auth.openai.com/oauth/token      (JSON body!)
 * - api-key mint:   POST https://auth.openai.com/oauth/token      (RFC 8693, best-effort)
 */

export const ISSUER = 'https://auth.openai.com'
export const AUTHORIZE_URL = `${ISSUER}/oauth/authorize`
export const TOKEN_URL = `${ISSUER}/oauth/token`
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
export const SCOPES = 'openid profile email offline_access'
export const ORIGINATOR = 'codex_cli_rs'

/** Refresh when the access token is within 60s of expiry (opencoredev EXPIRY_MARGIN_MS). */
export const REFRESH_MARGIN_MS = 60_000

/** Error codes that mean the refresh token is dead → full re-login required. */
const DEAD_REFRESH_ERRORS = [
  'refresh_token_expired',
  'refresh_token_reused',
  'refresh_token_invalidated',
  'invalid_grant'
]

export class RefreshDeadError extends Error {
  constructor(code: string) {
    super(`Refresh token is no longer valid (${code}); sign in again`)
    this.name = 'RefreshDeadError'
  }
}

export interface TokenSet {
  idToken: string
  accessToken: string
  refreshToken: string
}

export function buildAuthorizeUrl(params: {
  redirectUri: string
  codeChallenge: string
  state: string
}): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: params.redirectUri,
    scope: SCOPES,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state: params.state,
    originator: ORIGINATOR
  })
  return `${AUTHORIZE_URL}?${q.toString()}`
}

/** Authorization-code → tokens (server.rs exchange_code_for_tokens). Form-encoded. */
export async function exchangeCode(params: {
  code: string
  redirectUri: string
  codeVerifier: string
}): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: CLIENT_ID,
    code_verifier: params.codeVerifier
  })
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })
  if (!res.ok) {
    const text = await safeText(res)
    throw new Error(`Token exchange failed (${res.status}): ${truncate(text, 300)}`)
  }
  const json = (await res.json()) as {
    id_token?: string
    access_token?: string
    refresh_token?: string
  }
  if (!json.id_token || !json.access_token || !json.refresh_token) {
    throw new Error('Token exchange response missing id_token/access_token/refresh_token')
  }
  return {
    idToken: json.id_token,
    accessToken: json.access_token,
    refreshToken: json.refresh_token
  }
}

export interface RefreshResult {
  idToken?: string
  accessToken?: string
  refreshToken?: string
}

/**
 * Refresh flow (manager.rs 1334-1443). NOTE: JSON body here, unlike the code exchange.
 * Throws RefreshDeadError on permanent-failure codes → caller must force re-login.
 */
export async function refreshTokens(refreshToken: string): Promise<RefreshResult> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: SCOPES
    })
  })
  if (!res.ok) {
    const text = await safeText(res)
    const dead = DEAD_REFRESH_ERRORS.find((code) => text.includes(code))
    if (dead) throw new RefreshDeadError(dead)
    throw new Error(`Token refresh failed (${res.status}): ${truncate(text, 300)}`)
  }
  const json = (await res.json()) as {
    id_token?: string
    access_token?: string
    refresh_token?: string
  }
  return {
    idToken: json.id_token,
    accessToken: json.access_token,
    refreshToken: json.refresh_token
  }
}

/**
 * RFC 8693 token exchange to mint a real Platform API key (server.rs obtain_api_key).
 * Best-effort: consumer ChatGPT accounts without API-org access fail here — that is
 * expected and fine (D1 ladder step 2). Never throws; returns null on any failure.
 */
export async function exchangeForApiKey(idToken: string): Promise<string | null> {
  try {
    const body = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: CLIENT_ID,
      requested_token: 'openai-api-key',
      subject_token: idToken,
      subject_token_type: 'urn:ietf:params:oauth:token-type:id_token'
    })
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    })
    if (!res.ok) return null
    const json = (await res.json()) as { access_token?: string }
    return typeof json.access_token === 'string' && json.access_token.length > 0
      ? json.access_token
      : null
  } catch {
    return null
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
