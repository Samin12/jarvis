# Composio as the OAuth connector layer for Jarvis (Gmail + Google Calendar)

Research date: 2026-07-13. Verified against `@composio/core@0.13.1` source (npm tarball, published 2026-06-26) and docs.composio.dev. Where SDK source and docs disagreed, SDK source wins — it is quoted below.

---

## 1. Bottom line

- Use Composio for Gmail + Calendar rather than direct Google OAuth. It gives hosted OAuth (redirect URL generation, token storage, auto refresh), normalized tool JSON schemas, and one execute endpoint. Direct Google OAuth for Gmail means a CASA security assessment every 12 months once you distribute the app (details in section 12).
- Critical API-shape fact: for **Composio-managed OAuth** auth configs, `connectedAccounts.initiate()` / `POST /api/v3/connected_accounts` was **retired on 2026-07-03** (all orgs). You must use `connectedAccounts.link()` / `POST /api/v3/connected_accounts/link`. `initiate()` still works for custom auth configs (your own Google OAuth app) and non-OAuth schemes, but `link()` works for both — so use `link()` everywhere.
- Gmail has Composio-managed auth (works with zero Google Cloud setup, consent screen says "Composio"). **Google Calendar does NOT have managed auth** — you must create your own Google Cloud OAuth client for the `GOOGLECALENDAR` toolkit no matter what. Plan for one Google Cloud project with both Gmail and Calendar APIs enabled and one custom auth config per toolkit.
- The Composio API key is a developer-owned project secret. Anything shipped inside the Electron bundle can be extracted, and a project key can read every user's connected accounts. Fine while Jarvis is a personal/single-machine app; a thin relay server is required before public distribution (section 10).
- The `@composio/openai` provider does **not** support the OpenAI Realtime API (docs state Chat Completions and Responses only). For Realtime you fetch raw tool schemas and do the function-call loop manually — mapping code in section 7. This is straightforward.

---

## 2. Packages and versions (checked on npm 2026-07-13)

| Package | Version | Notes |
|---|---|---|
| `@composio/core` | 0.13.1 | The v3 TypeScript SDK. Default provider is a built-in `OpenAIProvider` (Chat Completions format). |
| `@composio/openai` | 0.10.0 | Optional; only needed for `handleToolCalls` sugar with the OpenAI SDK. Not needed for Realtime. |
| `@composio/mcp` | 1.0.9 | MCP client helper, optional. |
| `composio-core` | 0.5.39 | **Legacy v2 SDK. Do not use.** Different API surface (`ComposioToolSet` etc.). |

REST base URL: `https://backend.composio.dev/api/v3` (newer reference pages also show `/api/v3.1`; both are live — SDK 0.13.1 targets v3 paths). Auth header: `x-api-key: <COMPOSIO_API_KEY>` (project key). Org-wide operations use `x-org-api-key`. Scoped project keys exist (same `x-api-key` header, restricted routes) — created in dashboard Project Settings → API Keys.

Client init:

```ts
import { Composio } from '@composio/core';

const composio = new Composio({
  apiKey: process.env.COMPOSIO_API_KEY,  // developer-owned project key
  // provider defaults to built-in OpenAIProvider; fine for us
});
```

---

## 3. Object model in one paragraph

An **auth config** (`ac_...`) is the per-toolkit OAuth app definition (client id/secret or Composio-managed, plus scopes). A **connected account** (`ca_...`) is one user's authorized connection under an auth config, keyed by your **user_id** (any string you choose — use Jarvis's internal user id, e.g. the ChatGPT account id hash). **Tools** are named actions like `GMAIL_SEND_EMAIL`, executed with `user_id` (Composio resolves the user's active connected account for that toolkit) or an explicit `connected_account_id`.

---

## 4. Step 0 — Auth configs (one-time, developer setup)

### Gmail (managed auth available)
Dashboard → Auth Configs → Create Auth Config → Gmail → "Use Composio managed auth" → gives `ac_...` id. Works instantly. Caveats of managed auth:
- Consent screen shows "Composio", not "Jarvis".
- Quota shared across all Composio customers on the default app; rate limits hit sooner.
- Adding non-default scopes to the managed app triggers Google "app is blocked / unverified scopes" errors. Stick to defaults or go custom.

### Google Calendar (managed auth NOT available)
`GOOGLECALENDAR` is listed on docs.composio.dev/toolkits/managed-auth under "Requires Your Own Credentials". Setup:
1. Google Cloud Console → enable **Google Calendar API** (and Gmail API if also doing custom Gmail).
2. OAuth consent screen: External, app name "Jarvis", support email, privacy policy URL. Keep in **Testing** mode during dev (up to 100 test users, refresh tokens expire after 7 days in testing mode — annoying; push to Production once scopes verify).
3. Create OAuth client, type **Web application** (yes, web — the redirect target is Composio's server, not your app).
4. Authorized redirect URI: **`https://backend.composio.dev/api/v3.1/toolkits/auth/callback`** (current, from the white-labeling doc). The older guide at composio.dev/auth/googleapps still shows `https://backend.composio.dev/api/v1/auth-apps/add`. The Composio dashboard displays the exact redirect URI to whitelist when you create the auth config — copy it from there; if in doubt whitelist both.
5. Composio dashboard → Create Auth Config → Google Calendar → "Use your own developer credentials" → paste Client ID + Client Secret, set scopes (default is sufficient: `https://www.googleapis.com/auth/calendar` or narrower `calendar.events` + `calendar.readonly`).

Programmatic alternative (SDK `AuthConfigs.create`, verified in source):

```ts
const authConfig = await composio.authConfigs.create('GOOGLECALENDAR', {
  type: 'use_custom_auth',
  name: 'jarvis-gcal',
  authScheme: 'OAUTH2',
  credentials: {
    client_id: process.env.GOOGLE_CLIENT_ID!,
    client_secret: process.env.GOOGLE_CLIENT_SECRET!,
    // optional: scopes: 'https://www.googleapis.com/auth/calendar.events,https://www.googleapis.com/auth/calendar.readonly'
  },
});
// authConfig.id -> 'ac_...'
// For Gmail managed: composio.authConfigs.create('GMAIL', { type: 'use_composio_managed_auth' })
```

Store the two auth config ids (`ac_gmail`, `ac_gcal`) in app config. They are not secrets.

---

## 5. Step 1 — Start the OAuth connect (redirect URL generation)

Use `link()` (the current method; `initiate()` throws `ComposioLegacyConnectedAccountsEndpointRetiredError` for Composio-managed OAuth since 2026-07-03):

```ts
// main process (Electron)
import { shell } from 'electron';

const connectionRequest = await composio.connectedAccounts.link(
  userId,            // your stable per-user string, e.g. 'user_9f2c'
  'ac_gmail_xxx',    // auth config id
  {
    // optional; where the browser lands AFTER Composio finishes.
    callbackUrl: 'https://jarvis.aianswer.us/connected',  // or a custom-scheme deep link, see below
    // allowMultiple: true  // only if you want >1 Gmail account per user
  }
);

shell.openExternal(connectionRequest.redirectUrl!); // open in system browser
// persist connectionRequest.id (this IS the connected_account_id, 'ca_...')
```

Facts verified in SDK source (`src/models/ConnectedAccounts.ts`):
- `link(userId, authConfigId, options?)` → `POST /api/v3/connected_accounts/link` with body `{ auth_config_id, user_id, callback_url?, alias? }`.
- Response: `{ connected_account_id, redirect_url }`. The SDK wraps it in a `ConnectionRequest` with `.id`, `.status` (`INITIATED`), `.redirectUrl`, `.waitForConnection()`.
- If the user already has an ACTIVE connection on that auth config and you didn't pass `allowMultiple: true`, `link()` **throws `ComposioMultipleConnectedAccountsError`** (it pre-checks with a list call). Check for an existing ACTIVE connection first and skip the flow.
- `callbackUrl` is validated as plain `z.string()` in the SDK — a custom scheme like `jarvis://composio/callback?...` passes SDK validation. Composio appends `status=success|failed` and `connected_account_id=ca_...` as query params to the callback. For a desktop app the simplest robust pattern is: **don't rely on the callback at all** — open the browser, then poll (step 2), and have `callbackUrl` point to a static "You're connected — return to Jarvis" page. Deep-link (`app.setAsDefaultProtocolClient('jarvis')`) is a nice-to-have, not required.
- The OAuth link expires: connection stays `INITIATED` for ~10 minutes, then `EXPIRED`.

Raw REST equivalent:

```http
POST https://backend.composio.dev/api/v3/connected_accounts/link
x-api-key: <COMPOSIO_API_KEY>
content-type: application/json

{ "auth_config_id": "ac_gmail_xxx", "user_id": "user_9f2c", "callback_url": "https://..." }
```

Existing-connection check:

```ts
const existing = await composio.connectedAccounts.list({
  userIds: [userId],
  authConfigIds: ['ac_gmail_xxx'],
  statuses: ['ACTIVE'],
});
const alreadyConnected = existing.items.length > 0;
```

---

## 6. Step 2 — Wait for the connection to become ACTIVE

```ts
// Option A: on the request object (polls the API internally)
const account = await connectionRequest.waitForConnection(180_000); // ms, default 60_000

// Option B: from a stored id (survives app restart)
const account = await composio.connectedAccounts.waitForConnection('ca_...', 180_000);
```

- Resolves with the connected account when status hits `ACTIVE`.
- Throws `ConnectionRequestFailedError` on `FAILED` / `EXPIRED` / deleted, `ConnectionRequestTimeoutError` on timeout, `ComposioConnectedAccountNotFoundError` if the id is bad.
- Manual polling (REST): `GET /api/v3/connected_accounts/{ca_id}` and read `status`.

Status table:

| Status | Meaning | App behavior |
|---|---|---|
| `INITIATED` | Waiting for user in browser (≈10 min TTL) | Show spinner "waiting for Google sign-in" |
| `ACTIVE` | Tokens stored, tools executable | Mark connector green |
| `FAILED` | OAuth failed (check `status_reason`) | Show retry |
| `EXPIRED` | Link expired or refresh permanently failed | Re-run step 1 |
| `INACTIVE` | Manually disabled | `composio.connectedAccounts.enable(id)` |

Token refresh is automatic on Composio's side. If refresh becomes impossible (revoked from Google account settings), the account flips to `EXPIRED` → trigger re-connect UI. There is also `POST /api/v3/connected_accounts/{id}/refresh` (`composio.connectedAccounts.refresh(id)`) to force a re-auth flow.

---

## 7. Step 3 — Tool schemas for the OpenAI Realtime session

`composio.tools.get(userId, filters)` returns tools wrapped by the active provider. With the default built-in `OpenAIProvider`, each tool is **Chat Completions** shape (verified in `src/provider/OpenAIProvider.ts`):

```ts
// wrapTool output:
{ type: 'function', function: { name: tool.slug, description: tool.description, parameters: tool.inputParameters } }
```

The **Realtime API wants the flattened shape** `{ type: 'function', name, description, parameters }` in `session.tools`. Two clean options:

**Option A — fetch raw and map yourself (recommended, no provider coupling):**

```ts
// Raw Composio tool: { slug, name, description, inputParameters, outputParameters, scopes, ... }
const rawTools = await composio.tools.getRawComposioTools({
  tools: [
    'GMAIL_SEND_EMAIL', 'GMAIL_FETCH_EMAILS', 'GMAIL_CREATE_EMAIL_DRAFT', 'GMAIL_REPLY_TO_THREAD',
    'GOOGLECALENDAR_CREATE_EVENT', 'GOOGLECALENDAR_EVENTS_LIST',
    'GOOGLECALENDAR_FIND_FREE_SLOTS', 'GOOGLECALENDAR_PATCH_EVENT', 'GOOGLECALENDAR_DELETE_EVENT',
  ],
});

const realtimeTools = rawTools.map(t => ({
  type: 'function' as const,
  name: t.slug,                        // e.g. 'GMAIL_SEND_EMAIL'
  description: t.description ?? t.name,
  parameters: t.inputParameters,       // already JSON Schema {type:'object', properties, required}
}));

// then: session.update({ session: { tools: realtimeTools, tool_choice: 'auto' } })
```

**Option B — user-scoped fetch with filters** (`composio.tools.get(userId, { toolkits: ['GMAIL'], limit: 20 })`, also supports `search` and `scopes` filters), then unwrap `.function` from each item.

Important practical notes:
- Default `limit` is 20 when filtering by toolkit; GMAIL has 63 tools, GOOGLECALENDAR has 49. Do NOT dump entire toolkits into a Realtime session — Composio input schemas are verbose and will eat the session's context. Curate the explicit list above (9 tools) and grow as needed.
- Single tool schema fetch: `await composio.tools.getRawComposioToolBySlug('GMAIL_SEND_EMAIL')`.
- `inputParameters` can contain `$defs`/`definitions` and `$ref` (SDK 0.13.x preserves them). The Realtime API accepts standard JSON Schema, but if you hit issues, dereference `$ref`s before sending (small util or `@apidevtools/json-schema-ref-parser`).
- Toolkit slugs: `GMAIL`, `GOOGLECALENDAR` (one word). Tool versions are pinned per date, e.g. `20260703_00`; pass nothing to use your project's default.

## 8. Step 4 — Execute the tool when the Realtime model calls a function

Realtime loop (in the Electron main process or your relay):

```ts
// On 'response.function_call_arguments.done' (or item of type 'function_call' completed):
const { name, call_id, arguments: argsJson } = event;

const result = await composio.tools.execute(name, {
  userId,                                  // Composio resolves the ACTIVE connected account
  arguments: JSON.parse(argsJson),
  // connectedAccountId: 'ca_...',         // optional: pin to a specific account (multi-account users)
});

// result: { successful: boolean, data: Record<string, unknown>, error: string | null }
realtimeSocket.send(JSON.stringify({
  type: 'conversation.item.create',
  item: {
    type: 'function_call_output',
    call_id,
    output: JSON.stringify(result.successful ? result.data : { error: result.error }),
  },
}));
realtimeSocket.send(JSON.stringify({ type: 'response.create' }));
```

Verified `ToolExecuteParams` (SDK zod schema): `{ userId?, connectedAccountId?, arguments?, text?, version?, customAuthParams?, customConnectionData?, allowTracing?, dangerouslySkipVersionCheck? }`. Response schema: `{ data, error, successful }` (+ `log_id`, `session_info` on the wire).

Raw REST equivalent:

```http
POST https://backend.composio.dev/api/v3/tools/execute/{tool_slug}
x-api-key: <COMPOSIO_API_KEY>
content-type: application/json

{ "user_id": "user_9f2c", "arguments": { "recipient_email": "a@b.com", "subject": "...", "body": "..." } }
```

Truncate/summarize large results (e.g. `GMAIL_FETCH_EMAILS` returns full payloads) before feeding back into the Realtime conversation — voice models don't need raw MIME parts. Strip fields down to sender/subject/date/snippet.

---

## 9. Alternative surfaces: Sessions (Tool Router) and MCP

The docs now push **sessions** as the default. Verified surface in SDK (`composio.sessions.create`, class `ToolRouter`):

```ts
const session = await composio.sessions.create(userId, {
  toolkits: ['gmail', 'googlecalendar'],
  authConfigs: { gmail: 'ac_gmail_xxx', googlecalendar: 'ac_gcal_xxx' }, // pin your configs
  manageConnections: false,     // we drive connect UI ourselves
  mcp: true,                    // surfaces session.mcp in the type
});

session.sessionId;              // persist to reuse across turns
await session.tools();          // provider-wrapped tools (meta-tools by default; see below)
await session.authorize('gmail', { callbackUrl: '...' });  // per-session connect link (returns ConnectionRequest)
session.mcp.url; session.mcp.headers;  // hosted MCP endpoint for this user+session
```

- Default session mode exposes **meta-tools** (search/execute composites) rather than each tool — great for text agents, wrong for a Realtime voice session where you want a fixed function list. There is a `sessionPreset: SessionPreset.DIRECT_TOOLS` option that "exposes every tool allowed by the session filters directly in session.tools() and the MCP tool list" and disables search/multi-execute/manage-connections.
- **MCP option:** static server via `composio.mcp.create(name, { toolkits: [{ toolkit: 'gmail', authConfigId: 'ac_...' }], allowedTools: [...] })`, then per-user URL via `composio.mcp.generate(userId, serverId)` → `https://backend.composio.dev/v3/mcp/{server_id}?user_id={user_id}` (send `x-api-key` header when `require_mcp_api_key` is on). Session-based MCP (`session.mcp.url`) is the newer path.
- **Verdict for Jarvis:** MCP is attractive for the Codex CLI side (Codex speaks MCP natively — point it at the per-user Composio MCP URL and it gets Gmail/Calendar tools with auth handled). For the Realtime voice loop, use direct `tools.get` + `tools.execute` (section 7-8); OpenAI Realtime has added MCP-server support at the session level, but keeping the voice tool list small and curated argues for the manual loop regardless.

---

## 10. Which parts need the Composio API key vs user OAuth

| Operation | Credential |
|---|---|
| Create auth configs | Developer: Composio API key (or dashboard) |
| `connected_accounts/link` (generate redirect URL) | Developer: Composio API key |
| User consents to Google | User's own Google account, in system browser — app never sees tokens |
| Poll connection status | Developer: Composio API key |
| Fetch tool schemas | Developer: Composio API key |
| `tools/execute` | Developer: Composio API key + `user_id` (Composio injects the user's stored Google token server-side) |
| MCP endpoint | Composio API key header (when required) + per-user URL |

Consequences for a distributed desktop app: the project API key in the bundle = any user can extract it and call `connectedAccounts.list()` / execute tools as **other** users. Mitigations, in order of effort:
1. **Personal build (now):** key lives in `.env` / macOS Keychain on your own machine. Fine.
2. **Scoped project key:** create a key scoped to tool execution only (no connected-account management). Reduces blast radius but still shared across users — not sufficient alone for public distribution.
3. **Thin relay (before distribution):** 50-line server (Cloudflare Worker/Fly) that holds the Composio key, authenticates the Jarvis user (their app session), and enforces `user_id` == authenticated user on `link`, `waitForConnection`, `tools.execute`. The Realtime function-call loop then posts tool calls to the relay instead of Composio directly. This is the standard Composio deployment shape (their docs assume a backend).

## 11. Free tier / pricing (composio.dev/pricing, checked 2026-07-13)

- **Free:** $0, **20,000 tool calls/month**, community support. (Older 2025 plans had caps like 50-100 connected user accounts; the current page meters on tool calls only — re-verify account caps in the dashboard if you get near launch.)
- **$29/mo "Ridiculously Cheap":** 200K tool calls/mo, overage $0.299/1K, email support.
- **$229/mo:** 2M tool calls/mo, overage $0.249/1K.
- Enterprise: SOC-2, VPC, custom.

A single-user Jarvis doing even 500 tool calls/day sits comfortably in free tier (~15K/mo).

## 12. Alternative considered: direct Google OAuth in the app

What it takes:
- OAuth client type "Desktop app" with loopback redirect (`http://127.0.0.1:{port}/callback`) + PKCE; the client secret for installed apps is not treated as confidential by Google. Electron flow: spin a localhost HTTP listener, `shell.openExternal(authUrl)`, catch the code, exchange for tokens, store refresh token in macOS Keychain (`keytar`/`safeStorage`), refresh yourself, handle revocation.
- Scope classification is the real cost:
  - Gmail scopes needed by Jarvis (`gmail.readonly` or `gmail.modify`, `gmail.send`, `gmail.compose`) are **restricted** scopes → app verification PLUS an annual **CASA (Cloud Application Security Assessment)** by an approved third-party lab (TAC Security, DEKRA, Leviathan; $500-$4,500/yr typical, Tier 2/3 depending on scopes; server-side storage of Gmail data forces the higher tier). Only `gmail.labels` and a couple of settings scopes escape this.
  - Calendar scopes (`calendar`, `calendar.events`) are **sensitive** (not restricted) → standard brand verification (privacy policy, homepage, demo video), no CASA.
  - Unverified: capped at 100 test users, "unverified app" warning, refresh tokens expiring every 7 days while consent screen is in Testing.
- Upside: no per-call vendor, no third party touching mail content, no Composio dependency, unlimited free Google API quota within your own project.

**Recommendation: Composio.** The CASA requirement on Gmail restricted scopes is the decider — it applies to your own OAuth app the moment you distribute Jarvis beyond personal use, while with Composio-managed Gmail auth the OAuth app (and its verification burden) is Composio's. You still create a Google OAuth client for Calendar (sensitive scopes only — no CASA), which is a one-hour task. Revisit direct OAuth only if (a) Jarvis stays strictly personal forever (then direct OAuth avoids the middleman entirely and CASA never triggers since you're your only user), or (b) mail-content privacy becomes a product requirement.

## 13. Key tool slugs for Jarvis v1

**GMAIL** (63 tools, managed auth, 2 triggers incl. new-message): `GMAIL_SEND_EMAIL`, `GMAIL_FETCH_EMAILS`, `GMAIL_CREATE_EMAIL_DRAFT`, `GMAIL_REPLY_TO_THREAD`, `GMAIL_LIST_THREADS`, `GMAIL_LIST_LABELS`, `GMAIL_ADD_LABEL_TO_EMAIL`, `GMAIL_GET_ATTACHMENT`, `GMAIL_BATCH_MODIFY_MESSAGES`.

**GOOGLECALENDAR** (49 tools, custom auth required): `GOOGLECALENDAR_CREATE_EVENT`, `GOOGLECALENDAR_EVENTS_LIST`, `GOOGLECALENDAR_FIND_EVENT`, `GOOGLECALENDAR_PATCH_EVENT`, `GOOGLECALENDAR_DELETE_EVENT`, `GOOGLECALENDAR_FIND_FREE_SLOTS` (`GOOGLECALENDAR_FREE_BUSY_QUERY` is deprecated). Event ids are opaque API strings; always resolve via `EVENTS_LIST`/`FIND_EVENT` first. Timezones must be IANA identifiers.

## 14. Risks and gotchas

1. API surface churn: the `initiate()` → `link()` retirement landed **this month** (cutover 2026-07-03); base path is migrating v3 → v3.1. Pin `@composio/core` and re-check the changelog before each release.
2. `link()` throws `ComposioMultipleConnectedAccountsError` if an ACTIVE connection exists — always pre-check `connectedAccounts.list()` in the connect UI.
3. Composio-managed Gmail: "Composio" branding on consent screen, shared Google quota, no custom scopes. Swap to a custom Gmail auth config later without changing any code except the `ac_` id (existing users must reconnect).
4. Realtime provider gap: `@composio/openai` has no Realtime support; the manual loop in sections 7-8 is required (and is fine).
5. Redirect URI ambiguity for custom Google apps: docs show both `https://backend.composio.dev/api/v3.1/toolkits/auth/callback` (current) and `https://backend.composio.dev/api/v1/auth-apps/add` (older guide). Copy the exact value from the auth-config creation screen; whitelisting both is harmless.
6. Distributing the Composio project key in the app binary is the main security risk — relay server before public release.
7. Free tier metering: 20K tool calls/mo; a chatty agent loop that polls email can burn this — debounce `GMAIL_FETCH_EMAILS`, or use the Gmail trigger (webhook) instead of polling once there's a relay.
8. Testing-mode Google consent screen (Calendar custom app): refresh tokens die after 7 days until you publish the consent screen to Production.

## 15. Source list

- https://docs.composio.dev/docs/quickstart
- https://docs.composio.dev/docs/authenticating-tools
- https://docs.composio.dev/docs/executing-tools
- https://docs.composio.dev/docs/fetching-tools
- https://docs.composio.dev/docs/mcp-overview
- https://docs.composio.dev/docs/white-labeling-authentication
- https://docs.composio.dev/docs/custom-app-vs-managed-app
- https://docs.composio.dev/toolkits/gmail · https://docs.composio.dev/toolkits/googlecalendar · https://docs.composio.dev/toolkits/managed-auth
- https://docs.composio.dev/providers/openai
- https://docs.composio.dev/reference/authenticating-to-composio
- https://docs.composio.dev/reference/api-reference/connected-accounts (incl. `POST /connected_accounts/link`)
- https://composio.dev/pricing · https://composio.dev/auth/googleapps
- `@composio/core@0.13.1` source: `src/models/ConnectedAccounts.ts`, `src/models/Tools.ts`, `src/models/AuthConfigs.ts`, `src/models/ToolRouter.ts`, `src/models/ToolRouterSession.ts`, `src/models/MCP.ts`, `src/provider/OpenAIProvider.ts`, `src/types/tool.types.ts`, `src/types/connectedAccounts.types.ts`
- Google: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification · https://developers.google.com/workspace/gmail/api/auth/scopes · CASA cost datapoints: deepstrike.io/blog/google-casa-security-assessment-2025, truto.one/blog/our-google-oauth-app-is-live-and-casa-tier-2-certified
