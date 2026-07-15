# Gap Check — Research Phase Completeness Review

Date: 2026-07-13. Method: read all six full reports, cross-compared claims, then independently re-verified every post-cutoff or load-bearing external claim (npm registry, raw GitHub source, live docs, live endpoints). Verification results are marked VERIFIED (checked today) or CREDIBLE (source-cited by the report, not independently re-tested, low risk).

> **Superseded for Jarvis 0.2 (2026-07-13):** the voice-key conclusion below applies to direct
> Platform Realtime, not to the exact pinned Codex app-server's experimental
> `thread/realtime/*` WebRTC path now used by Jarvis. No Platform key, token exchange, or renderer
> credential is part of the shipped path.

## Verdict

**PASS with three decisions required before build.** No factual contradictions between reports on the load-bearing question. No hallucinations found — every spot-checked fact (14 checks, listed below) verified exactly, including file:line references into the Codex Rust source. The reports disagree in two places, but both are plan divergences (two valid mechanisms, pick one), not fact conflicts. The remaining gaps are one-time external setup and product decisions, not missing research.

---

## 1. THE load-bearing question: can a ChatGPT OAuth token call the Realtime API?

**Answer: NO. The reports are consistent, and I re-verified the strongest evidence independently.**

- `chatgpt-oauth` (§8 risk 2): the ChatGPT access token only authorizes `chatgpt.com/backend-api/codex/responses`; Realtime lives on `api.openai.com` and needs a real API key.
- `gpt-live-voice` (§3): same conclusion, backed by OpenClaw production docs and two proxy projects.
- `codex-bridge` marks it "unverified in this research" and defers to the voice track. That is deference, not contradiction.

**Independent re-verification (today):** fetched https://docs.openclaw.ai/providers/openai — the exact quote is present verbatim: "OpenAI TTS and Realtime voice are both configured through an OpenAI Platform API key; OAuth-only installs can still use Codex-backed chat models, but not OpenAI live talk-back."

**Resolved implication:** voice requires a Platform API key. Acquisition ladder (per gpt-live-voice, sound): (1) reuse `OPENAI_API_KEY` from `~/.codex/auth.json` if present, (2) run the RFC 8693 token exchange (`requested_token=openai-api-key`) after the app's own ChatGPT OAuth — succeeds only for accounts with Platform org claims, fails silently otherwise, (3) prompt the user to paste a key. Fallback lane if no key: STT → Codex `/responses` → TTS. This is a product decision (see Blocking Decisions).

---

## 2. Contradictions between reports

### 2a. Composio tools in the voice session: MCP vs manual function loop (SOFT — must pick one)

- `gpt-live-voice` plan: attach Composio's per-user hosted MCP server directly in the Realtime session (`tools:[{type:'mcp', server_url, ...}]`), "zero client glue."
- `composio-connectors` plan: for the Realtime voice loop use the manual path — `getRawComposioTools()` → flattened `{type:'function', name, description, parameters}` schemas → `tools.execute()` on function-call events — and reserve MCP for the Codex CLI lane.

Both mechanisms exist and work (Realtime remote-MCP support is a GA feature; Composio MCP URLs are real). **Recommendation: manual function loop for voice.** Reasons: you can curate ~9 tools (full toolkits are 63+49 verbose schemas and would blow session context), you can truncate bulky Gmail results before they re-enter the audio conversation (impossible with the MCP path — the model sees raw tool output), and approval gating stays in-app. Use MCP for the Codex CLI lane as both reports agree.

### 2b. ChatGPT-login ownership: mirror auth.json vs never touch it (SOFT — must pick one)

- `chatgpt-oauth` plan: Jarvis does its own OAuth, stores tokens in Keychain, and "optionally mirrors `~/.codex/auth.json` (mode 0600) so the bundled Codex CLI shares the session."
- `codex-bridge`: detect login via `codex login status` or app-server `account/read`, "never copy/exfiltrate tokens," and warns `auth.json` may not exist at all if `cli_auth_credentials_store=keyring`.

These pull in opposite directions. **Recommended reconciliation:** Jarvis owns the OAuth (it needs the raw access token for its own `/responses` calls anyway) and hands tokens to Codex via app-server `account/login/start {type:"chatgptAuthTokens"}` (documented in codex-bridge §4) — no auth.json writing, no keyring conflict. If staying on the exec/SDK bridge in Phase 1 (no app-server), then write `~/.codex/auth.json` in the documented shape at mode 0600 and accept the coupling; the shape is verified (storage.rs). Decide before Phase 1.

### 2c. Minor: loopback bind address and port collision

`chatgpt-oauth`'s plan says "start a short-lived http server on 127.0.0.1:1455" while the redirect_uri uses `localhost`. Codex itself binds 127.0.0.1 (server.rs:616 confirms the same pattern), so this works, but bind explicitly so `localhost`→`::1` resolution can fall back. Also: Jarvis's own OAuth flow and a spawned `codex login` both want port 1455 — never run them concurrently.

---

## 3. Independent verification results (all VERIFIED today)

| Claim | Result |
|---|---|
| `client_id app_EMoamEEZ73f0CkXaXp7hrann` at manager.rs:1446 | VERIFIED — fetched raw source, exact line matches |
| Ports 1455/1457, `http://localhost:{port}/auth/callback`, issuer auth.openai.com | VERIFIED — server.rs:57,58,60,167 exact |
| `codex proto` removed; `app-server` + `mcp-server` present | VERIFIED — no Proto subcommand in cli/src/main.rs |
| `@openai/codex-sdk` and `@openai/codex` latest = 0.144.3 | VERIFIED — npm registry |
| `@composio/core` latest = 0.13.1 | VERIFIED — npm registry |
| `@opencoredev/loginwithchatgpt-core` exists (0.2.0); description literally says "OAuth device-code + PKCE flows, token refresh, and the Codex responses transport" | VERIFIED — npm registry |
| Composio `link()` replaces `initiate()` for managed OAuth; retirement 2026-05-08 (new orgs) / 2026-07-03 (all orgs) | VERIFIED — docs.composio.dev/docs/authenticating-tools |
| GMAIL has managed auth; GOOGLECALENDAR listed under "Requires Your Own Credentials" | VERIFIED — docs.composio.dev/toolkits/managed-auth |
| `gpt-realtime-2.1` ($32/$64 audio, $4/$24 text) and `gpt-realtime-2.1-mini` ($10/$20, $0.60/$2.40) | VERIFIED — developers.openai.com/api/docs/pricing, exact prices match |
| GPT-Live-1 / GPT-Live-1 mini launched 2026-07-08, ChatGPT-only, full-duplex, delegates to GPT-5.5, API "soon" with signup form | VERIFIED — openai.com announcement + press coverage |
| OpenClaw "OAuth-only installs … not OpenAI live talk-back" quote | VERIFIED — verbatim on docs.openclaw.ai |
| Codex ChatGPT-auth model slugs gpt-5.6-sol/terra/luna, gpt-5.5, gpt-5.4, gpt-5.4-mini, gpt-5.3-codex-spark (Pro, text-only preview); gpt-5.2*/gpt-5.3-codex deprecated; docs 308-redirect to learn.chatgpt.com | VERIFIED — learn.chatgpt.com/docs/models |
| Forward-Future/loopy: 2,669 stars, MIT; catalog.json live with schemaVersion 2, loopCount 85, updated 2026-07-07 | VERIFIED — GitHub API + live endpoint |
| dnavarrom/openwakeword_wasm exists; repo description matches the report's quote | VERIFIED — GitHub API |
| jarvis-hud-1.0.1 reference app exists locally | VERIFIED — /Users/saminyasar/Jarvis gpt/jarvis-hud-1.0.1 |

## 4. Resolved gaps (answered during this review)

1. **Realtime mini model ID ambiguity → RESOLVED.** The pricing page shows `gpt-realtime-2.1-mini` (no bare `gpt-realtime-mini` there). Use `gpt-realtime-2.1-mini`, keep the runtime `GET /v1/models` enumeration as belt-and-suspenders.
2. **`client_version` query param value → RESOLVED.** opencoredev's 0.142.5 is a guess; current Codex CLI is 0.144.3 (npm, today). Derive `client_version` from the bundled `@openai/codex` package version at build time so it tracks releases automatically.
3. **openWakeWord `hey_jarvis` pretrained model → CONFIRMED REAL** (dscripka/openWakeWord ships it, Apache-2.0), and the wasm wrapper repo exists. v1 push-to-talk plan removes any launch dependency on it.

## 5. Unverified-but-flagged (acceptable residual risk — reports self-flag these)

- **Stateless Responses body rules** (store:false, reasoning, include reasoning.encrypted_content, strip ids) — from reading opencoredev source; fails loudly in first integration test if wrong. CREDIBLE.
- **Token-exchange-minted key actually reaching Realtime** — asserted from Codex source behavior, not live-tested against a real account. Treat step (2) of the key ladder as best-effort with a UX fallback, exactly as planned. CREDIBLE.
- **60-minute Realtime session cap** — community-thread sourced; reconnection-with-summary design is required regardless. CREDIBLE.
- **Composio free tier 20K calls/month** — pricing page, dated 2026-07-13 in the report. CREDIBLE.
- **app-server method names** (thread/start, account/rateLimits/read, requestApproval, chatgptAuthTokens) — repo README sourced; the plan already regenerates typed bindings per binary version, which absorbs drift. CREDIBLE.

## 6. Blocking decisions / prerequisites (not missing research — must be settled before build)

1. **Voice-key UX decision.** "Sign in with ChatGPT and talk" cannot work on OAuth alone. Decide now: ship voice gated on the Platform-key ladder (reuse auth.json key → token exchange → paste key), with or without the STT→Codex→TTS no-key fallback lane. This shapes onboarding and the settings UI.
2. **Voice tool path decision (2a).** Manual Composio function loop (recommended) vs Realtime MCP attachment. Affects the ConnectorService interface and approval UX.
3. **Login ownership decision (2b).** Jarvis-owned OAuth + `chatgptAuthTokens` handoff (recommended for Phase 2) vs writing `~/.codex/auth.json` (workable for Phase 1) vs spawning `codex login` (simplest, but Jarvis then must read auth.json anyway for its own `/responses` calls).
4. **One-time external setup** that no code can substitute for: (a) Google Cloud project + OAuth web client for GOOGLECALENDAR with Composio's callback URI (copy the exact URI from the Composio dashboard — the docs show two candidates), consent screen pushed to Production to avoid 7-day refresh-token expiry; (b) Composio auth configs created and `ac_` ids recorded; (c) Composio project API key provisioned; (d) GPT-Live API signup form submitted.

## 7. Non-blocking notes

- Both the ChatGPT OAuth path and the `chatgpt.com/backend-api/codex` endpoint are unofficial; all reports flag the ToS/revocation risk consistently. Accepted-risk item, not a gap.
- Electron packaging of the bundled codex binary (asar.unpacked + notarization) is a one-line risk note, not researched in depth. Fine for research phase; assign it to the build phase.
- design-spec is grounded in the locally present jarvis-hud-1.0.1 source — no external claims to verify; its stated fragilities (boot-stagger second-animation cancel, --accent-h dependency, O(n²) edge build) read as genuine source-derived findings.
- loopy correctly concludes there is nothing to integrate as a dependency; the borrowed patterns (finite boundaries, terminal-state enum, receipts, untrusted goal file) are methodology text under MIT.
