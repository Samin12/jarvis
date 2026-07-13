/**
 * Minimal JWT claim extraction WITHOUT signature verification.
 * Tokens come straight from auth.openai.com over TLS, same posture as Codex CLI
 * (codex-rs/login/src/token_data.rs). We only base64url-decode the payload.
 */

/** Namespaced claim object carrying ChatGPT account metadata. */
export const AUTH_CLAIM = 'https://api.openai.com/auth'
export const PROFILE_CLAIM = 'https://api.openai.com/profile'

export interface JarvisClaims {
  email: string | null
  /** e.g. "free" | "plus" | "pro" | "business" | "enterprise" | "edu" */
  planType: string | null
  /** chatgpt_account_id — sent as ChatGPT-Account-ID header on every model call. */
  accountId: string | null
  /** epoch seconds */
  exp: number | null
  isFedramp: boolean
}

export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length < 2 || !parts[1]) return null
  try {
    const json = Buffer.from(parts[1], 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
    return null
  } catch {
    return null
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

function claimsFromPayload(payload: Record<string, unknown>): JarvisClaims {
  const auth = asRecord(payload[AUTH_CLAIM])
  const profile = asRecord(payload[PROFILE_CLAIM])
  const email = asString(payload['email']) ?? asString(profile?.['email'])
  const planType = asString(auth?.['chatgpt_plan_type'])
  const accountId = asString(auth?.['chatgpt_account_id'])
  const exp = typeof payload['exp'] === 'number' ? payload['exp'] : null
  const isFedramp = auth?.['chatgpt_account_is_fedramp'] === true
  return { email, planType, accountId, exp, isFedramp }
}

/**
 * Extract the claims Jarvis cares about, trying the id_token first and
 * falling back to the access_token per field (mirrors opencoredev deriveAccountId).
 */
export function extractClaims(
  idToken: string | null | undefined,
  accessToken?: string | null
): JarvisClaims {
  const primary = idToken ? decodeJwtPayload(idToken) : null
  const secondary = accessToken ? decodeJwtPayload(accessToken) : null
  const a: JarvisClaims = primary
    ? claimsFromPayload(primary)
    : { email: null, planType: null, accountId: null, exp: null, isFedramp: false }
  if (!secondary) return a
  const b = claimsFromPayload(secondary)
  return {
    email: a.email ?? b.email,
    planType: a.planType ?? b.planType,
    accountId: a.accountId ?? b.accountId,
    exp: a.exp ?? b.exp,
    isFedramp: a.isFedramp || b.isFedramp
  }
}

/** Expiry of a JWT in epoch milliseconds, or null when undecodable. */
export function tokenExpiryMs(token: string): number | null {
  const payload = decodeJwtPayload(token)
  if (!payload || typeof payload['exp'] !== 'number') return null
  return payload['exp'] * 1000
}
