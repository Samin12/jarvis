# "Sign in with ChatGPT" OAuth for Desktop Apps — Deep Findings

Research date: 2026-07-13. For the Jarvis macOS desktop app (sign in with the user's own
ChatGPT account, then call OpenAI on that user's ChatGPT plan).

> **Implementation note (2026-07-13):** the direct-token conclusions below remain correct for
> calls Jarvis would make itself. Jarvis 0.2 does not make those calls or copy the token; the
> pinned Codex app-server owns ChatGPT auth and its experimental `thread/realtime/*` sideband.

Primary sources (raw source read, not just docs):
- OpenAI Codex CLI (Rust), `main` branch: https://github.com/openai/codex — crate `codex-rs/login`
- opencoredev/login-with-chatgpt (TypeScript SDK, a faithful port of the Codex flow):
  https://github.com/opencoredev/login-with-chatgpt
- Live demo: https://log-in-chatgpt.vercel.app (device-code flow, tokens kept server-side)

> TL;DR: There is no official public "Sign in with ChatGPT" product. Both Codex and the
> opencoredev SDK reuse the **Codex CLI's public OAuth client** (`app_EMoamEEZ73f0CkXaXp7hrann`)
> against `https://auth.openai.com`, do **PKCE S256**, and then call the model with the resulting
> **ChatGPT access token** against `https://chatgpt.com/backend-api/codex/responses` (NOT
> `api.openai.com`). This is an unofficial/undocumented integration path. It works today but can
> break if OpenAI changes the client allow-list or endpoints.

---

## 1. Exact OAuth parameters (authoritative, from Codex Rust source)

Source: `codex-rs/login/src/server.rs`, `codex-rs/login/src/auth/manager.rs`,
`codex-rs/login/src/pkce.rs`.

| Item | Value | Source line |
|---|---|---|
| Issuer / auth server | `https://auth.openai.com` | server.rs:57 `DEFAULT_ISSUER` |
| Authorize endpoint | `https://auth.openai.com/oauth/authorize` | server.rs:588 |
| Token endpoint | `https://auth.openai.com/oauth/token` | server.rs:802 |
| Revoke endpoint | `https://auth.openai.com/oauth/revoke` | manager.rs:190 `REVOKE_TOKEN_URL` |
| Refresh endpoint | `https://auth.openai.com/oauth/token` | manager.rs:189 `REFRESH_TOKEN_URL` |
| **client_id** | `app_EMoamEEZ73f0CkXaXp7hrann` | manager.rs:1446 `pub const CLIENT_ID` |
| Default loopback port | `1455` | server.rs:58 `DEFAULT_PORT` |
| Fallback port | `1457` | server.rs:60 `FALLBACK_PORT` (Hydra redirect allow-list) |
| **redirect_uri** | `http://localhost:{port}/auth/callback` | server.rs:167 |
| PKCE method | `S256` | server.rs:574 |
| client_id override env | `CODEX_APP_SERVER_LOGIN_CLIENT_ID` | manager.rs:193 |
| refresh URL override env | `CODEX_REFRESH_TOKEN_URL_OVERRIDE` | manager.rs:191 |

Note: the redirect URI uses `localhost` (not `127.0.0.1`) and the literal path `/auth/callback`.
The port is normally `1455`; if busy, Codex first tries to cancel a previous login server, then
falls back to `1457`. **Both `1455` and `1457` are on OpenAI's redirect-URI allow-list for this
client** (comment at server.rs:59). Do not invent other ports — an unregistered `redirect_uri`
will be rejected by the authorize endpoint.

### 1a. Authorize URL query params (server.rs:553-589 `build_authorize_url`)

```
response_type            = code
client_id                = app_EMoamEEZ73f0CkXaXp7hrann
redirect_uri             = http://localhost:1455/auth/callback
scope                    = openid profile email offline_access api.connectors.read api.connectors.invoke
code_challenge           = <BASE64URL(SHA256(verifier)) no pad>
code_challenge_method    = S256
id_token_add_organizations = true
codex_cli_simplified_flow  = true
state                    = <32 random bytes, base64url no pad>
originator               = codex_cli_rs
# optional, only when restricting to specific workspaces:
allowed_workspace_id     = <comma-joined account ids>
```

Final URL shape: `https://auth.openai.com/oauth/authorize?<urlencoded querystring>`.

**Scope discrepancy to be aware of:**
- Current Codex Rust source requests: `openid profile email offline_access api.connectors.read api.connectors.invoke`
  (the two `api.connectors.*` scopes are new — for the Codex "connectors" feature).
- The opencoredev SDK (`packages/core/src/constants.ts:18`) and older Codex builds request just:
  `openid profile email offline_access`.
- **For Jarvis, `openid profile email offline_access` is the minimum** you need (id_token + a
  refreshable session). `offline_access` is what makes the refresh_token be issued. Only add the
  connectors scopes if you actually use Codex connectors.

`originator` string = `codex_cli_rs` (const `DEFAULT_ORIGINATOR`,
`codex-rs/login/src/auth/default_client.rs:42`; override env `CODEX_INTERNAL_ORIGINATOR_OVERRIDE`).
It is sent both as an authorize query param and as an HTTP header on model calls.

### 1b. PKCE generation (server.rs:152, pkce.rs)

```rust
// codex-rs/login/src/pkce.rs
let mut bytes = [0u8; 64];
rand::rng().fill_bytes(&mut bytes);
let code_verifier  = base64::URL_SAFE_NO_PAD.encode(bytes);          // 64 random bytes -> verifier
let digest         = Sha256::digest(code_verifier.as_bytes());
let code_challenge = base64::URL_SAFE_NO_PAD.encode(digest);         // S256 challenge
```

`state` = 32 random bytes, URL-safe base64 no pad (server.rs:591 `generate_state`). The callback
handler rejects the request if `state` does not match (server.rs:335, 344).

TS equivalent (opencoredev `packages/core/src/pkce.ts`) is identical (WebCrypto
`crypto.getRandomValues` + SHA-256 + base64url).

---

## 2. Authorization-code -> tokens exchange (server.rs:784-858 `exchange_code_for_tokens`)

`POST https://auth.openai.com/oauth/token`
`Content-Type: application/x-www-form-urlencoded`

Body (url-encoded):
```
grant_type=authorization_code
&code=<authorization code from callback>
&redirect_uri=http://localhost:1455/auth/callback
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&code_verifier=<pkce verifier>
```

Response JSON (only these 3 fields are read):
```json
{ "id_token": "<JWT>", "access_token": "<JWT>", "refresh_token": "<opaque>" }
```

opencoredev sends the same body (`packages/core/src/oauth.ts:exchangeAuthorizationCode`) and also
reads optional `expires_in`.

---

## 3. Token-exchange to mint an OpenAI API key (server.rs:1110-1146 `obtain_api_key`)

After the code exchange, Codex tries (best-effort, failure is ignored) to mint a real API key via
RFC 8693 token exchange:

`POST https://auth.openai.com/oauth/token`
`Content-Type: application/x-www-form-urlencoded`

Body:
```
grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&requested_token=openai-api-key
&subject_token=<id_token>
&subject_token_type=urn:ietf:params:oauth:token-type:id_token
```

Response: `{ "access_token": "<API key>" }`. Codex stores this string as `OPENAI_API_KEY` in
`auth.json`. **This is the ONLY path that yields a key usable against `api.openai.com/v1`
(including Realtime).** It is called with `.ok()` (server.rs:414) so a failure is swallowed —
plenty of pure-ChatGPT (Plus/Pro) accounts without API-org provisioning will get nothing here.
The opencoredev SDK omits this step entirely; it never touches `api.openai.com`.

**Implication for Jarvis Realtime/voice:** see §8 (Risks). A ChatGPT access token does NOT work
with the Realtime API; you need this minted API key (if the account even has API access) or a
separately supplied `OPENAI_API_KEY`.

---

## 4. Refresh flow (manager.rs:1334-1443)

`POST https://auth.openai.com/oauth/token`
`Content-Type: application/json`   ← note: JSON here, form-encoded for the code exchange

Body (Rust `RefreshRequest`, manager.rs:1431):
```json
{ "client_id": "app_EMoamEEZ73f0CkXaXp7hrann",
  "grant_type": "refresh_token",
  "refresh_token": "<refresh token>" }
```
opencoredev also adds `"scope": "openid profile email offline_access"` (oauth.ts:refreshTokens).

Response (`RefreshResponse`, manager.rs:1438): `{ id_token?, access_token?, refresh_token? }`.
The new `refresh_token` (if present) replaces the old one; otherwise keep the old one.

Permanent-failure error codes (force full re-login) — manager.rs:1376-1385:
`refresh_token_expired`, `refresh_token_reused`, `refresh_token_invalidated`
(opencoredev also treats `invalid_grant` as dead — oauth.ts:DEAD_REFRESH_ERRORS).

Refresh cadence: opencoredev refreshes when the access token is within **60 s** of expiry
(`tokens.ts:EXPIRY_MARGIN_MS = 60_000`). Codex refreshes lazily on 401 and on a periodic check.

---

## 5. id_token / access_token claims (token_data.rs:71-161)

Both are JWTs. Codex decodes the payload WITHOUT signature verification (they come straight from
OpenAI over TLS). Claims that matter:

- Top-level `email`
- Namespaced object **`https://api.openai.com/auth`** (constant `AUTH_CLAIM`), containing:
  - `chatgpt_plan_type` — e.g. `free`, `plus`, `pro`, `business`, `enterprise`, `edu`
  - `chatgpt_user_id`  (falls back to `user_id`)
  - **`chatgpt_account_id`** — the ChatGPT workspace/account id. This is the value sent as the
    `ChatGPT-Account-ID` request header on every model call. **Load-bearing.**
  - `chatgpt_account_is_fedramp` (bool) — if true, add header `X-OpenAI-Fedramp: true`
- Namespaced object `https://api.openai.com/profile` -> `email` (fallback for the address)
- Standard `exp` (epoch seconds) — used to decide when to refresh.

TS helper `deriveAccountId` (jwt.ts): reads `decodeJwt(token)["https://api.openai.com/auth"].chatgpt_account_id`.
It tries the id_token first, then the access_token.

---

## 6. How the token is USED to call the model (the part that actually matters)

### 6a. Base-URL routing by auth mode (model-provider-info/src/lib.rs:241-259 `to_api_provider`)

```
if auth_mode ∈ { Chatgpt, ChatgptAuthTokens, Headers, AgentIdentity, PersonalAccessToken }:
    base_url = https://chatgpt.com/backend-api/codex     // const CHATGPT_CODEX_BASE_URL, lib.rs:38
else (ApiKey):
    base_url = https://api.openai.com/v1
```

So a **ChatGPT-plan login talks to `https://chatgpt.com/backend-api/codex`, NOT `api.openai.com`.**
Wire API is the **Responses API** (`WireApi::Responses`). Endpoint path is `/responses`
(client.rs:158 `RESPONSES_ENDPOINT`). Full URL:

```
POST https://chatgpt.com/backend-api/codex/responses
```

Model list endpoint: `GET https://chatgpt.com/backend-api/codex/models`
(opencoredev `listCodexModels`, codex-transport.ts).

Allowed ChatGPT hosts (http-client/src/chatgpt_hosts.rs): exact `chatgpt.com`, `chat.openai.com`,
`chatgpt-staging.com`; plus `*.chatgpt.com`, `*.chatgpt-staging.com`. `api.openai.com` is NOT a
ChatGPT host.

### 6b. Request headers (model-provider/src/bearer_auth_provider.rs + opencoredev codex-transport.ts)

```
Authorization: Bearer <access_token>          # the ChatGPT access_token JWT (NOT the id_token, NOT the API key)
ChatGPT-Account-ID: <chatgpt_account_id>      # header name is case-insensitive; opencoredev uses lowercase "chatgpt-account-id"
OpenAI-Beta: responses=experimental           # opencoredev codex-transport.ts
originator: codex_cli_rs
X-OpenAI-Fedramp: true                         # only if chatgpt_account_is_fedramp
```
Plus a query param `client_version=<codex cli version>` on the URL — the ChatGPT backend **gates
the available model set on this**; a stale/missing value can make models report "not supported"
(opencoredev constants.ts:DEFAULT_CLIENT_VERSION, currently a guess of `0.142.5`). `get_token()`
for ChatGPT auth returns `access_token` (manager.rs:499-503), confirming the bearer is the access
token.

### 6c. Stateless Responses-API body requirements (opencoredev codex-transport.ts `normalizeResponsesBody`)

The Codex backend runs **`store: false`** (stateless). If you send a normal Responses payload you
get an empty stream (`AI_NoOutputGeneratedError`). You MUST:
- set `store: false`
- set `reasoning` (Codex models always reason), e.g. `{ effort: "medium", summary: "auto" }`
- add `"reasoning.encrypted_content"` to `include` (carries reasoning across turns w/o storage)
- strip server-side `id`s from input items; drop any `item_reference` items
- NOT send `max_output_tokens` / `max_completion_tokens` (rejected)
- optional `service_tier` — ChatGPT path supports `fast` for eligible GPT-5.5/5.4 sessions

Default model in opencoredev = `gpt-5.5` (a guess; query `/models` for the real list per account).

---

## 7. `~/.codex/auth.json` on-disk format (auth/storage.rs:38-61 `AuthDotJson`)

Serde struct (serialized keys):

```jsonc
{
  "OPENAI_API_KEY": "sk-...",          // the token-exchange-minted API key, or null
  "tokens": {
    "id_token": "<raw id_token JWT string>",   // stored as the raw compact JWT (serialize_id_token)
    "access_token": "<access_token JWT>",
    "refresh_token": "<opaque refresh token>",
    "account_id": "<chatgpt_account_id>"        // Option<String>
  },
  "last_refresh": "2026-07-13T10:00:00Z",       // RFC3339 UTC, Option
  "auth_mode": "chatgpt"                          // Option; omitted if none
  // agent_identity / personal_access_token / bedrock_api_key: omitted unless used
}
```

Notes:
- `TokenData` (token_data.rs:10-25) fields: `id_token` (serialized as the raw JWT string via
  `serialize_id_token`, deserialized back into parsed claims), `access_token`, `refresh_token`,
  `account_id`.
- `OPENAI_API_KEY` is the exact JSON key (serde rename, storage.rs:44).
- File is written with Unix mode `0600` (owner read/write only). Path is `$CODEX_HOME/auth.json`,
  and `CODEX_HOME` defaults to `~/.codex`. So the concrete path is **`~/.codex/auth.json`**.
- Newer Codex builds can also store credentials in the OS keyring instead of the file
  (`AuthCredentialsStoreMode`, `AuthKeyringBackendKind`) — but the file format above is the
  portable one and is what you'd read/write for interop.

For Jarvis you do NOT have to reuse `~/.codex/auth.json` — but writing to it means the user's
Codex CLI shares the same session (nice for the "dispatch to Codex CLI" feature: log in once in
Jarvis, Codex CLI is already authenticated). If you keep Jarvis creds separate, mirror this shape.

---

## 8. Alternative: device-code flow (no loopback listener) — good fallback for desktop

Source: `codex-rs/login/src/device_code_auth.rs` and opencoredev `packages/core/src/device.ts`.
The live demo (log-in-chatgpt.vercel.app) uses this exclusively. Endpoints derived from issuer:

1. `POST https://auth.openai.com/api/accounts/deviceauth/usercode`  body `{ "client_id": "app_EMoam..." }`
   -> `{ device_auth_id, user_code, interval }`
2. Show the user `user_code` and the verification page `https://auth.openai.com/codex/device`.
3. Poll `POST https://auth.openai.com/api/accounts/deviceauth/token`
   body `{ device_auth_id, user_code }`. `403/404/429` = keep waiting. On success:
   `{ authorization_code, code_verifier, code_challenge }` — **the server generates the PKCE pair**.
4. Exchange that `authorization_code` at `/oauth/token` (same as §2) with
   `redirect_uri = https://auth.openai.com/deviceauth/callback`.

Device codes expire ~15 min (`DEVICE_CODE_TTL_MS`). Default poll interval 5 s. Codex's own device
prompt page is `{issuer}/codex/device`.

For a native macOS app the **loopback PKCE flow (§1) is the better UX** (open system browser ->
auto-redirect to `localhost:1455` -> app captures the code). Use device-code only if you can't
bind a localhost port.

---

## 9. Recommended integration for Jarvis (Electron/desktop)

Two viable stacks:

**(A) Reuse the opencoredev TypeScript SDK** (`@opencoredev/loginwithchatgpt-core` + `-ai`). It is
a clean port of everything above and plugs straight into the Vercel AI SDK
(`createOpenAI({ baseURL: "https://chatgpt.com/backend-api/codex", fetch: codexFetch })`). It
already handles PKCE, refresh (60 s margin), the stateless body normalization, and account-id
headers. Fastest path. Caveat: it's a third-party package tracking an unofficial API.

**(B) Implement natively in the Electron main process** using the exact params in §1-§6. In main
(Node), run a short-lived `http` server on `127.0.0.1:1455`, open the system browser to the
authorize URL, capture `code` on `/auth/callback`, POST the token exchange, store tokens in the OS
keychain (Electron `safeStorage`), and refresh per §4. Send only rendered results to the renderer
(never expose tokens to the web layer) — mirrors the demo's HttpOnly-cookie posture.

Flow for the "talk to Jarvis" (text/agent) path: use the ChatGPT access token against
`https://chatgpt.com/backend-api/codex/responses` with the headers in §6b and the stateless body
rules in §6c.

---

## 10. Risks / gotchas (READ before building)

1. **Unofficial + ToS risk.** This reuses the Codex CLI's OAuth client and a private
   `chatgpt.com/backend-api/codex` endpoint. It is not a sanctioned "Sign in with ChatGPT"
   product. OpenAI can revoke the client, change the endpoint, or rate-limit it at any time.
   Usage bills the END USER's ChatGPT plan (Free/Plus/Pro), which is the intended model here.
2. **Realtime / GPT Live voice will NOT work with the ChatGPT access token.** The Realtime API
   lives on `api.openai.com` and requires a real API key. The ChatGPT OAuth token only authorizes
   `chatgpt.com/backend-api/codex/responses`. Options: (a) use the token-exchange-minted
   `OPENAI_API_KEY` (§3) — but it silently fails for accounts without API-org access, so you can't
   rely on it; (b) require a separate user-supplied `OPENAI_API_KEY` for the voice feature; or
   (c) build the voice loop as STT -> Codex `/responses` (text) -> TTS instead of true Realtime.
   **Recommend deciding this early — it's the biggest architectural fork.**
3. **`redirect_uri` must be exactly `http://localhost:{1455|1457}/auth/callback`.** Other ports/
   hosts are not on the client's allow-list and the authorize call will error. Use `localhost`,
   not `127.0.0.1`.
4. **`client_version` query param gates models.** Omit or stale-value it and models report "not
   supported". Keep it near the current Codex CLI release.
5. **Stateless body is mandatory** (§6c). Miss `store:false` / `reasoning` / encrypted-content
   include and you get empty responses, not an error.
6. **Scope creep:** the current Codex source adds `api.connectors.read api.connectors.invoke`.
   Request only what you need (`openid profile email offline_access`) unless using connectors.
7. **Token storage:** never expose tokens to the renderer/browser. Keychain (`safeStorage`) or
   mirror `~/.codex/auth.json` at mode 0600.
8. **Refresh-token death codes** (`refresh_token_expired|reused|invalidated`, `invalid_grant`)
   mean the user must fully re-login — handle by re-running the OAuth flow, not retrying.

---

## Appendix: exact file:line references

Codex (github.com/openai/codex, `main`):
- `codex-rs/login/src/server.rs` — authorize URL builder (553-589), code exchange (784-858),
  token-exchange API key (1110-1146), redirect URI (167), ports (58,60), state (591-595).
- `codex-rs/login/src/pkce.rs` — S256 PKCE (whole file, 27 lines).
- `codex-rs/login/src/token_data.rs` — JWT claims parsing, `AUTH_CLAIM` fields (71-161).
- `codex-rs/login/src/auth/manager.rs` — `CLIENT_ID` (1446), refresh (1334-1443), REFRESH/REVOKE
  URLs (189-191), `get_token` returns access_token (497-514).
- `codex-rs/login/src/auth/storage.rs` — `AuthDotJson` shape (38-61).
- `codex-rs/model-provider/src/bearer_auth_provider.rs` — Bearer + `ChatGPT-Account-ID` +
  `X-OpenAI-Fedramp` header injection.
- `codex-rs/model-provider/src/auth.rs` — `auth_provider_from_auth` (282-297), agent-identity
  header path (86-110).
- `codex-rs/model-provider-info/src/lib.rs` — `CHATGPT_CODEX_BASE_URL` (38), base-URL-by-auth-mode
  (241-259).
- `codex-rs/http-client/src/chatgpt_hosts.rs` — allowed ChatGPT hosts.
- `codex-rs/login/src/auth/default_client.rs` — `DEFAULT_ORIGINATOR = "codex_cli_rs"` (42).
- `codex-rs/login/src/device_code_auth.rs` — device flow endpoints/paths.

opencoredev/login-with-chatgpt (`main`) — TypeScript reference impl:
- `packages/core/src/constants.ts` — all default constants (client id, issuer, scope, base URL,
  originator, model, client_version, AUTH_CLAIM).
- `packages/core/src/config.ts` — endpoint derivation (`/oauth/token`, `/oauth/authorize`,
  `/api/accounts`, `/codex/device`, `/deviceauth/callback`).
- `packages/core/src/oauth.ts` — authorize URL, code exchange, refresh.
- `packages/core/src/pkce.ts` / `jwt.ts` / `tokens.ts` — PKCE, claim parsing, refresh-margin.
- `packages/core/src/codex-transport.ts` — the request adapter (headers, stateless body,
  `client_version`, model list). **This file is the single best template for Jarvis's model call.**
- `packages/core/src/device.ts` — device-code flow.
- `packages/ai/src/provider.ts` — Vercel AI SDK provider wiring
  (`createOpenAI({ baseURL: codexBaseUrl, fetch: codexFetch })`).
- `examples/demo/src/login-cli.ts` — end-to-end device-code + streamText demo.
