/**
 * PKCE (RFC 7636) + state generation for the ChatGPT OAuth flow.
 * Mirrors codex-rs/login/src/pkce.rs exactly:
 *   verifier  = base64url(64 random bytes), no padding
 *   challenge = base64url(SHA256(verifier)), no padding  (S256)
 *   state     = base64url(32 random bytes), no padding
 */
import { createHash, randomBytes } from 'node:crypto'

export interface PkcePair {
  /** URL-safe base64 (no pad) of 64 random bytes — sent as code_verifier on token exchange. */
  verifier: string
  /** base64url(SHA256(verifier)) — sent as code_challenge with method S256. */
  challenge: string
}

export function generatePkce(): PkcePair {
  const verifier = randomBytes(64).toString('base64url')
  const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
  return { verifier, challenge }
}

/** 32 random bytes, base64url no pad. Validated verbatim on the loopback callback. */
export function generateState(): string {
  return randomBytes(32).toString('base64url')
}
