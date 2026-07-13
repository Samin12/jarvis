#!/usr/bin/env node
/**
 * Sanity check for the ChatGPT OAuth authorize URL.
 * Standalone re-implementation of src/main/services/auth/{pkce,oauth}.ts —
 * run with: node scripts/test-auth-url.mjs
 */
import { createHash, randomBytes } from 'node:crypto'
import assert from 'node:assert/strict'

const ISSUER = 'https://auth.openai.com'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const SCOPES = 'openid profile email offline_access'
const ORIGINATOR = 'codex_cli_rs'
const PORT = 1455
const REDIRECT_URI = `http://localhost:${PORT}/auth/callback`

// PKCE per codex-rs/login/src/pkce.rs
const verifier = randomBytes(64).toString('base64url')
const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url')
const state = randomBytes(32).toString('base64url')

const q = new URLSearchParams({
  response_type: 'code',
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  scope: SCOPES,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  id_token_add_organizations: 'true',
  codex_cli_simplified_flow: 'true',
  state,
  originator: ORIGINATOR
})
const url = `${ISSUER}/oauth/authorize?${q.toString()}`

// ---- assertions ----
const parsed = new URL(url)
assert.equal(parsed.origin, 'https://auth.openai.com', 'origin')
assert.equal(parsed.pathname, '/oauth/authorize', 'path')

const expect = {
  response_type: 'code',
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT_URI,
  scope: SCOPES,
  code_challenge_method: 'S256',
  id_token_add_organizations: 'true',
  codex_cli_simplified_flow: 'true',
  originator: ORIGINATOR
}
for (const [key, value] of Object.entries(expect)) {
  assert.equal(parsed.searchParams.get(key), value, `param ${key}`)
}

// PKCE shape: 64 bytes -> 86 base64url chars, SHA-256 -> 43 chars, no padding
assert.equal(verifier.length, 86, 'verifier length')
assert.ok(!/[+/=]/.test(verifier), 'verifier is base64url no-pad')
const gotChallenge = parsed.searchParams.get('code_challenge')
assert.equal(gotChallenge, challenge, 'challenge in url')
assert.equal(gotChallenge.length, 43, 'challenge length (S256)')
assert.ok(!/[+/=]/.test(gotChallenge), 'challenge is base64url no-pad')
assert.equal(
  gotChallenge,
  createHash('sha256').update(verifier, 'ascii').digest('base64url'),
  'challenge = BASE64URL(SHA256(verifier))'
)

// state: 32 bytes -> 43 base64url chars, no padding
const gotState = parsed.searchParams.get('state')
assert.equal(gotState, state, 'state in url')
assert.equal(gotState.length, 43, 'state length')
assert.ok(!/[+/=]/.test(gotState), 'state is base64url no-pad')

console.log(url)
console.log('\nOK — all authorize-URL params present and PKCE/state shapes correct.')
