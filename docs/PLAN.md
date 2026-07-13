# Jarvis — Architecture & UX Plan

Decisions below resolve the research gap-check (docs/research/gap-check.md). Research reports live in `docs/research/`.

## End-user experience (the whole point)

1. **Download** `Jarvis-<version>-mac.zip` (or DMG) from GitHub Releases → open the app.
2. Boot screen (orb ignition) → single button: **“Sign in with ChatGPT”**. System browser opens auth.openai.com; user approves; app catches the callback on localhost:1455 and the HUD boots. No API keys, no config files.
3. User says **“Good morning, Jarvis”** (push-to-talk v1: hold Space / global shortcut; wake-word v2). Jarvis answers in a live voice conversation. An **aside transcript panel** shows the conversation; the orb reacts to listening/speaking states.
4. **Connectors panel → Composio section**: cards for Gmail, Google Calendar (and more). Click Connect → browser OAuth → card flips to CONNECTED. From then on, “what’s on my calendar”, “any new emails from X” work mid-voice-conversation.
5. **Codex tasks**: “Jarvis, clean up my downloads folder” → Jarvis dispatches Codex CLI (same ChatGPT login), streams progress rows into the HUD, speaks the result summary.

## Load-bearing decisions

| # | Question | Decision |
|---|----------|----------|
| D1 | Voice auth (ChatGPT token can't call Realtime) | **Key ladder**: (1) reuse `OPENAI_API_KEY` from `~/.codex/auth.json` → (2) RFC 8693 token-exchange right after login (`requested_token=openai-api-key`; silently fails on consumer accounts — fine) → (3) `OPENAI_API_KEY` env / pasted key in Settings. **No-key fallback lane**: text chat via ChatGPT token against `chatgpt.com/backend-api/codex/responses` + spoken replies via `speechSynthesis` (native macOS voices). App is fully usable without a Platform key; live full-duplex voice lights up when a key exists. |
| D2 | Composio in voice: hosted MCP vs manual loop | **Manual function-call loop** for the Realtime session: curated ~9 Gmail/Calendar tools via `tools.getRawComposioTools()` → flattened `{type:'function'}` schemas → on function_call run `tools.execute(slug, {userId, arguments})`, truncate bulky results. Hosted MCP is reserved for the Codex lane (inject per-user Composio MCP URL into Codex config). |
| D3 | Token sharing with Codex CLI | **Jarvis owns the OAuth.** It writes `~/.codex/auth.json` (documented shape, mode 0600) so Codex CLI inherits the session. Never run Jarvis sign-in concurrently with `codex login` (both bind port 1455). Tokens also stored app-side via Electron `safeStorage`. |
| D4 | Voice model | `gpt-realtime-2.1` (quality) / `gpt-realtime-2.1-mini` (cost mode), WebRTC from renderer, `semantic_vad`, voice `marin`, input transcription on. GPT-Live-1 has no API yet (ChatGPT-only as of 2026-07-13); voice layer stays model-agnostic behind an interface so we can swap when the GPT-Live API ships. |
| D5 | Google Calendar needs own Google OAuth client (Composio-managed auth is Gmail-only) | Ship Gmail first-class. Calendar card shows **“needs one-time setup”** until a `GOOGLECALENDAR` auth config exists (docs walk through the 5-min Google Cloud step). All auth-config ids live in app config, not code. |

## Stack

Electron + electron-vite + React + TypeScript. Packaging: electron-builder → DMG + zip (mac arm64+x64). Repo: this folder; GitHub: Samin12/jarvis; releases via `gh release`.

- **Main process** (`src/main/`): window mgmt, `AuthService` (PKCE loopback flow), `TokenStore` (safeStorage + auth.json mirror), `VoiceKeyService` (D1 ladder + `/v1/realtime/client_secrets` minting), `ConnectorService` (@composio/core), `CodexBridge` (@openai/codex-sdk streamed threads), `ChatService` (backend-api/codex/responses SSE for no-key lane).
- **Preload** (`src/preload/`): typed contextBridge API.
- **Renderer** (`src/renderer/`): GraphCore orb port (three.js), boot-stagger HUD shell, LoginScreen, TranscriptPanel (aside), ConnectorsPanel (Composio section), CodexPanel (task rows), VoiceClient (WebRTC + data channel), SettingsPanel.
- **Shared** (`src/shared/`): IPC channel names + payload types — single source of truth.

## HUD design language (from docs/research/design-spec.md)

Near-black stage `oklch(0.13 0.004 270)`, fullscreen GraphCore particle orb (2200 nodes, GLSL twinkle/bleach/ripple, UnrealBloom), `--accent-h` hue voyage written to `:root` every frame, Big Shoulders numerals + Martian Mono micro-labels, edge scrims instead of panel boxes, boot-stagger blur-slide 0.05–0.58s then orb ignition at 0.65s. States: idle/working/listening/speaking/error (cobalt=listening, warn=speaking, err=red-locked hue).

## Codex task protocol (loopy-inspired)

Every dispatched task carries a finite boundary (max turns/wall-clock) and ends in a terminal state: `Success | Clean no-op | Blocked | Approval required | Exhausted | No progress`, persisted as a run receipt (prompt hash, scope, result, evidence) rendered in the HUD task history and summarized to voice. Default sandbox `workspace-write`, `approvalPolicy: never`, network off; “use full computer” tasks require explicit user phrase and flip to `danger-full-access`.

## Security posture

- Tokens: safeStorage (Keychain-backed) + 0600 auth.json. Never in renderer localStorage; renderer gets capabilities via IPC only.
- Composio project key: dev-supplied via `.env`/config for personal builds; **public distribution requires the thin relay** (Cloudflare Worker pinning user_id) before the key ships anywhere — documented, not in v1 binary.
- Realtime function tools that send email / create events require in-HUD confirmation before execute (voice: “say confirm”).
- localhost servers bind 127.0.0.1 only.

## Implementation waves (multi-agent)

- **W0 (done by orchestrator)**: repo, scaffold, deps, IPC contracts, this plan. Commit each.
- **W1 parallel agents** (disjoint file ownership, each commits + must pass `npm run build` + `npx tsc --noEmit`):
  - A `auth`: AuthService PKCE + TokenStore + auth.json mirror + LoginScreen wiring.
  - B `hud`: design system port — globals.css, GraphCore, HUD shell, boot choreography, TranscriptPanel skeleton.
  - C `voice`: VoiceKeyService ladder, Realtime WebRTC client, no-key fallback lane (ChatService SSE + speechSynthesis), push-to-talk.
  - D `connectors`: ConnectorService + ConnectorsPanel with Composio section (Gmail/Calendar cards, link()/waitForConnection flow, tool curation for voice).
  - E `codex`: CodexBridge (SDK streamed threads, receipts) + CodexPanel.
- **W2**: integration agent (App composition, cross-module wiring, state machine), then adversarial review agents, fixes.
- **W3**: packaging (electron-builder), GitHub repo push, release with zip; README/onboarding polish; end-to-end verify with real login on this machine (computer-use allowed).
