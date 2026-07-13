# GPT-Live and the OpenAI Realtime API for the Jarvis Desktop Voice Assistant

Research date: 2026-07-13. All endpoints and parameter names below were verified against live OpenAI docs (developers.openai.com), the openai/codex source tree, and third-party implementations. Wrong-name traps are called out explicitly.

---

## 1. What GPT-Live actually is

Source: https://openai.com/index/introducing-gpt-live/ (announced **2026-07-08**; openai.com blocks scrapers, details cross-verified via MacRumors, SiliconANGLE, apidog, OpenAIDevs on X).

- **GPT-Live is a ChatGPT product feature, not an API.** It is the new voice model family powering ChatGPT Voice (replacing Advanced Voice Mode).
- Two models: **GPT-Live-1** (default for paid plans: Go, Plus, Pro) and **GPT-Live-1 mini** (free tier).
- **Full-duplex architecture**: it listens and speaks at the same time, and "make[s] decisions on whether to speak, continue listening, pause, interrupt, or use a tool multiple times per second." It emits backchannel acknowledgments ("mhmm", "yeah") and can stay silent.
- **Delegation**: for web search / deep reasoning / complex work it delegates to the current frontier model (**GPT-5.5** at launch) in the background and folds the result back into the conversation.
- Rollout: iOS, Android, web ChatGPT, worldwide, multiple languages, starting 2026-07-08. Does **not** yet support voice+video or screen sharing.
- **API status: NOT available.** OpenAI Devs (X, @OpenAIDevs status 2074915334377844896): "We're bringing GPT-Live-1 and GPT-Live-1 mini to the API soon." Notification signup form: **https://openai.com/form/gpt-live-1-in-the-api/**. No model IDs, endpoints, pricing, or timeline published.

**Implication for Jarvis:** build on the **Realtime API** (`gpt-realtime-2.1`) today; architect the session layer so the model ID and transport are swappable when GPT-Live-1 lands in the API. Sign up on the form for early access.

---

## 2. OpenAI Realtime API — current (2026-07) surface

Docs root: https://platform.openai.com/docs/guides/realtime → **301 redirects to https://developers.openai.com/api/docs/guides/realtime** (use the new host).

### 2.1 Model IDs (verified on https://developers.openai.com/api/docs/models)

Realtime family, exact IDs:

| Model ID | Notes |
|---|---|
| `gpt-realtime-2.1` | Current flagship speech-to-speech. 128k context, 32k max output. Knowledge cutoff 2024-09-30. Configurable `reasoning.effort` (use `low` for voice agents). |
| `gpt-realtime-2.1-mini` | Current cost-efficient tier (this is the ID on the pricing page). |
| `gpt-realtime-mini` | Older mini alias; snapshots `gpt-realtime-mini-2025-12-15`, `gpt-realtime-mini-2025-10-06`. 32k context, 4,096 max output. |
| `gpt-realtime-2`, `gpt-realtime-1.5` | Previous generations, still listed. |
| `gpt-realtime-translate` | Dedicated live speech translation (own endpoint `/v1/realtime/translations`; no `response.create` — translation starts as audio arrives). |
| `gpt-realtime-whisper` | Streaming transcription. |

Trap: `gpt-4o-realtime-preview` is obsolete naming; do not use it. `gpt-4o-mini-tts` is marked Deprecated. There is a naming inconsistency between `gpt-realtime-2.1-mini` (pricing/models index) and `gpt-realtime-mini` (older model page) — enumerate `GET /v1/models` at runtime and prefer `gpt-realtime-2.1-mini`, falling back to `gpt-realtime-mini`.

### 2.2 Pricing (per 1M tokens, from https://developers.openai.com/api/docs/pricing)

| Model | Audio in | Audio cached | Audio out | Text in | Text cached | Text out | Image in |
|---|---|---|---|---|---|---|---|
| `gpt-realtime-2.1` | $32.00 | $0.40 | $64.00 | $4.00 | $0.40 | $24.00 | $5.00 |
| `gpt-realtime-2.1-mini` | $10.00 | $0.30 | $20.00 | $0.60 | $0.06 | $2.40 | $0.80 |

Rule of thumb: audio ≈ 800 tokens/minute input, so full-model conversation costs roughly $0.026/min of user speech input + ~$0.10–0.15/min of assistant speech output; mini is ~3x cheaper. Cached input pricing matters a lot for long sessions (conversation history is re-fed each turn).

Rate limits (Tier 1 example for `gpt-realtime-2.1`): 200 RPM, 40,000 TPM.

**Session cap: 60 minutes maximum** (raised from 30). No server-side parameter to set a shorter lifetime; you must track and re-connect yourself (community: https://community.openai.com/t/realtime-api-session-timeout-post-ga/1357331).

### 2.3 Endpoints (GA interface — exact paths)

Base: `https://api.openai.com`

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/realtime/client_secrets` | POST | Mint an **ephemeral client secret** (`ek_...`) for browser/client use. This replaced the older `POST /v1/realtime/sessions` beta flow. |
| `/v1/realtime/calls` | POST | WebRTC **SDP exchange** (body = SDP offer, response = SDP answer). |
| `/v1/realtime?model=gpt-realtime-2.1` | WSS | WebSocket transport. |
| `/v1/realtime/translations` | — | Translation sessions (`gpt-realtime-translate`). |

GA changes to be aware of:
- **Remove the legacy `OpenAI-Beta: realtime=v1` header** — not used on the GA interface.
- Session objects now carry `"type": "realtime"` (or `"transcription"`).
- Server event names renamed: `response.output_text.delta`, `response.output_audio.delta`, `response.output_audio_transcript.delta` (old `response.audio.delta`-style names are the beta interface).
- Recommended header when your backend mints secrets: `OpenAI-Safety-Identifier: <hashed-user-id>`.

### 2.4 Minting an ephemeral key — `POST /v1/realtime/client_secrets`

Request body fields (verified on https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create):

- `expires_after` (optional): `{ "anchor": "created_at", "seconds": 10–7200 }` — default **600 s**; `"created_at"` is the only supported anchor.
- `session` (optional): a full `RealtimeSessionCreateRequest` that will be attached to any session created with this secret (client can still override via `session.update`).

```bash
curl -s -X POST https://api.openai.com/v1/realtime/client_secrets \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "expires_after": { "anchor": "created_at", "seconds": 600 },
    "session": {
      "type": "realtime",
      "model": "gpt-realtime-2.1",
      "instructions": "You are Jarvis, a concise voice assistant...",
      "audio": {
        "input": {
          "format": { "type": "audio/pcm", "rate": 24000 },
          "turn_detection": { "type": "semantic_vad", "eagerness": "auto" }
        },
        "output": { "voice": "marin", "speed": 1.0 }
      }
    }
  }'
```

Response:

```json
{ "value": "ek_1234...", "expires_at": 1752403600, "session": { ...echoed config... } }
```

The `value` (`ek_...`) is what the renderer uses as its Bearer token. TTL 10 min default, max 2 h.

**Jarvis note:** in a desktop app where the user supplies their *own* API key, you can mint client secrets from the Electron **main process** (key kept in Keychain, never in the renderer) — no separate server needed. The ephemeral-key pattern still isolates the key from renderer/web content.

### 2.5 WebRTC connection flow (recommended transport for the app)

From https://developers.openai.com/api/docs/guides/realtime-webrtc — two patterns:

**Pattern A — ephemeral key, client does SDP exchange directly** (what Jarvis should use; "server" = Electron main process):

```js
// renderer process
const pc = new RTCPeerConnection();
const audioEl = document.createElement("audio");
audioEl.autoplay = true;
pc.ontrack = (e) => (audioEl.srcObject = e.streams[0]);

const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
pc.addTrack(ms.getTracks()[0]);

const dc = pc.createDataChannel("oai-events");   // exact channel name: "oai-events"
dc.addEventListener("message", (e) => handleServerEvent(JSON.parse(e.data)));

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

// ek_... minted in main process via /v1/realtime/client_secrets, passed over IPC
const sdpResponse = await fetch("https://api.openai.com/v1/realtime/calls", {
  method: "POST",
  body: offer.sdp,
  headers: {
    Authorization: `Bearer ${ephemeralKey}`,
    "Content-Type": "application/sdp",
  },
});
await pc.setRemoteDescription({ type: "answer", sdp: await sdpResponse.text() });
```

**Pattern B — "unified interface", backend proxies the SDP** with the standard key and a multipart body:

```js
const fd = new FormData();
fd.set("sdp", browserOfferSdp);
fd.set("session", JSON.stringify({
  type: "realtime",
  model: "gpt-realtime-2.1",
  audio: { output: { voice: "marin" } },
}));
const r = await fetch("https://api.openai.com/v1/realtime/calls", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    "OpenAI-Safety-Identifier": "hashed-user-id",
  },
  body: fd,
});
```

Events flow over the `oai-events` data channel as JSON; audio flows as WebRTC media tracks (opus over RTP — no manual PCM handling, built-in echo cancellation/jitter buffering via Chromium's WebRTC stack, which Electron ships).

### 2.6 WebSocket alternative

- URL: `wss://api.openai.com/v1/realtime?model=gpt-realtime-2.1`
- Server-side auth: header `Authorization: Bearer OPENAI_API_KEY`.
- Browser-context auth (no headers available on `new WebSocket()`): **subprotocol array** `["realtime", "openai-insecure-api-key.{KEY}"]` (+ optional `"openai-organization.{ORG_ID}"`, `"openai-project.{PROJECT_ID}"`). Use the ephemeral `ek_` key here, never the real key.
- Audio must be hand-pumped: base64 PCM16 chunks via `input_audio_buffer.append` client events; output arrives as `response.output_audio.delta`. You own mic capture, resampling to 24 kHz PCM16, playback scheduling, and echo cancellation.
- Docs recommendation: **WebRTC for client apps**, WebSocket for server/telephony pipelines. For Electron, WebRTC is strictly less work and lower latency.

### 2.7 Session configuration essentials

- Audio formats: `audio/pcm` (PCM16, 24 kHz), `audio/pcmu` + `audio/pcma` (G.711) — set via `session.audio.input.format` / `session.audio.output.format`.
- Output `speed`: 0.25–1.5.
- `include`: e.g. `"item.input_audio_transcription.logprobs"`.
- Input transcription (so you can show what the user said): configure `session.audio.input.transcription` (e.g. model `gpt-realtime-whisper` / `gpt-4o-transcribe`).

**Voices** (exact list): `alloy`, `ash`, `ballad`, `coral`, `echo`, `sage`, `shimmer`, `verse`, `marin`, `cedar`. OpenAI recommends `marin`/`cedar` (newest, most natural). **Once the model has emitted audio in a session, `voice` cannot be changed.**

**Turn detection** (`session.audio.input.turn_detection`):

```json
{ "type": "server_vad", "threshold": 0.5, "prefix_padding_ms": 300,
  "silence_duration_ms": 500, "create_response": true, "interrupt_response": true }
```

- `server_vad`: amplitude-based; params above (docs example values 0.5 / 300 / 500).
- `semantic_vad`: model decides when the user is done; param `eagerness`: `"auto"` (= `medium`, default), `"low"` (lets user pause longer), `"high"` (responds fast). Best conversational feel for an assistant.
- `null`: no VAD — **push-to-talk mode**; you send `input_audio_buffer.commit` + `response.create` yourself.

### 2.8 Function calling in realtime sessions

Declare tools in `session.update` (`session.tools`) or per-response (`response.tools`):

```json
{ "type": "session.update", "session": { "type": "realtime", "tools": [{
  "type": "function",
  "name": "dispatch_codex_task",
  "description": "Run an agentic computer task via Codex CLI",
  "parameters": { "type": "object",
    "properties": { "task": { "type": "string" } }, "required": ["task"] }
}]}}
```

Flow (exact event names):
1. Stream args via `response.function_call_arguments.delta` … `response.function_call_arguments.done`, or wait for `response.done` where `response.output[0].type === "function_call"` with `.name`, `.arguments` (JSON string), `.call_id`.
2. Return result:

```json
{ "type": "conversation.item.create", "item": {
  "type": "function_call_output", "call_id": "<call_id>", "output": "{\"result\":\"...\"}" } }
```

3. Send `{ "type": "response.create" }` to make the model speak the result.

For long-running tools (Codex tasks), return an immediate ack output ("started, I'll tell you when it's done") and inject a later `conversation.item.create` + `response.create` when the task finishes.

### 2.9 Remote MCP servers inside Realtime sessions (big deal for Composio)

From https://developers.openai.com/api/docs/guides/realtime-mcp — the Realtime API can call **remote MCP servers directly**, no client-side tool loop needed:

```json
{ "type": "session.update", "session": {
  "type": "realtime", "model": "gpt-realtime-2.1",
  "tools": [{
    "type": "mcp",
    "server_label": "gmail",
    "server_url": "https://mcp.composio.dev/...per-user-server-url...",
    "authorization": "<oauth-or-bearer-token-if-needed>",
    "allowed_tools": ["GMAIL_SEND_EMAIL", "GMAIL_FETCH_EMAILS"],
    "require_approval": "never"
  }]
}}
```

Fields: `type:"mcp"`, `server_label`, `server_url`, optional `authorization`, `headers`, `allowed_tools`, `require_approval`. Event flow: `mcp_list_tools.in_progress/.completed` → `response.mcp_call_arguments.delta/done` → `response.mcp_call.in_progress` → `mcp_call` item → `response.done`. Note: "Remote MCP servers don't automatically receive the full conversation context, but they can see any data the model sends in a tool call."

**Jarvis integration:** point this at Composio's per-user hosted MCP server URL for Gmail/Calendar — the voice model then reads/sends email and manages calendar with zero glue code in the app. Keep `require_approval` on for send-type actions.

### 2.10 SDK option

`@openai/agents` / `@openai/agents-realtime` (openai-agents-js) provides `RealtimeAgent` + `RealtimeSession` with automatic WebRTC in browser-like environments, tool registration, handoffs, and interruption handling: https://openai.github.io/openai-agents-js/guides/voice-agents/. Works in Electron renderers. Recommended over hand-rolled event plumbing unless you need exotic control.

---

## 3. Auth: can a ChatGPT OAuth (Codex-style) token drive Realtime? **No.**

### 3.1 What the Codex ChatGPT login gives you

Codex CLI login flow (verified from `openai/codex` source, `codex-rs/login/src/server.rs`, and https://developers.openai.com/codex/auth → redirects to https://learn.chatgpt.com/docs/auth):

- Authorize: `https://auth.openai.com/oauth/authorize` with `response_type=code`, **`client_id=app_EMoamEEZ73f0CkXaXp7hrann`**, `redirect_uri=http://localhost:1455/auth/callback` (fallback port 1457), `scope=openid profile email offline_access api.connectors.read api.connectors.invoke`, PKCE `S256`, plus `id_token_add_organizations=true`, `codex_cli_simplified_flow=true`.
- Token: `POST https://auth.openai.com/oauth/token`, `grant_type=authorization_code` (+ `refresh_token` grant for refresh). Credentials persist to `~/.codex/auth.json` (contains `OPENAI_API_KEY` field, `tokens.{id_token,access_token,refresh_token,account_id}`).
- The **access token only works against the ChatGPT backend**: `https://chatgpt.com/backend-api/codex/responses` (Responses-API-shaped, text only, Codex-entitled models like gpt-5.2/gpt-5.x-codex). Confirmed by proxy projects: EvanZhouDev/openai-oauth exposes only `/v1/responses`, `/v1/chat/completions`, `/v1/models` shims over that backend and notes realtime is **not** supported; numman-ali/opencode-openai-codex-auth same.
- Official docs: ChatGPT sign-in "restricts access to Codex products"; API-key auth is the separate usage-billed path.
- Strongest third-party confirmation — OpenClaw (docs.openclaw.ai/providers/openai), which faced exactly Jarvis's problem: "OpenAI TTS and Realtime voice are both configured through an OpenAI Platform API key" and "**OAuth-only installs can still use Codex-backed chat models, but not OpenAI live talk-back.**" Their credential order for voice: configured keys / `OPENAI_API_KEY` first; Codex OAuth is fallback for chat only.

### 3.2 The token-exchange escape hatch (mint a real API key from the ChatGPT login)

`codex-rs/login/src/server.rs` (`obtain_api_key()`, lines ~1111–1146 on main) performs an RFC 8693 token exchange after login and persists the result as `OPENAI_API_KEY` in `auth.json`:

```text
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=urn:ietf:params:oauth:grant-type:token-exchange
&client_id=app_EMoamEEZ73f0CkXaXp7hrann
&requested_token=openai-api-key
&subject_token=<id_token>
&subject_token_type=urn:ietf:params:oauth:token-type:id_token
```

Response: `{ "access_token": "<sk-...>" }` — a **standard Platform API key**, usable with `api.openai.com` including Realtime. Caveats:
- It only succeeds when the id_token carries organization/project claims, i.e. the user has (or auto-creates) an **OpenAI Platform org** — result is `.ok()`-swallowed in Codex because it often fails for consumer-only accounts.
- Usage on this key bills the user's Platform account at standard API rates (not their ChatGPT subscription).
- This is the same mechanism Codex uses officially, but minting keys from your own app's login flow sits in gray territory; the `client_id` belongs to OpenAI's Codex app.

### 3.3 What login-with-ChatGPT products actually do for voice (fallback ranking for Jarvis)

1. **BYO Platform API key for voice** (what OpenClaw does): ChatGPT OAuth powers Codex/agent text; a separate `OPENAI_API_KEY` powers Realtime. Store in macOS Keychain; mint `ek_` client secrets in the main process.
2. **Reuse `~/.codex/auth.json`**: if the user has run `codex login`, read `OPENAI_API_KEY` from it (with consent). Zero extra setup for Codex users — which Jarvis users are by definition.
3. **Run the token exchange yourself** after the ChatGPT OAuth you already implement for Codex — best UX, works only for accounts with Platform orgs; fall back to (1) on failure.
4. **Unofficial ChatGPT voice backend**: ChatGPT's voice runs over WebRTC/LiveKit against chatgpt.com backend endpoints; no stable public reverse-engineering exists post-GPT-Live, it violates ToS, and breaks arbitrarily. **Do not build on this.**
5. **Wait for GPT-Live-1 API** — sign up at https://openai.com/form/gpt-live-1-in-the-api/ and design the voice layer model-agnostic.

---

## 4. Wake word in Electron

### Option A — Push-to-talk (ship first)
Global shortcut (`globalShortcut.register('Alt+Space', ...)`) or menu-bar click → open/attach Realtime WebRTC session. With `turn_detection: null` you control turns precisely; or keep `semantic_vad` and just unmute the track. Zero idle cost, zero false accepts, no always-listening privacy prompt.

### Option B — Local wake word → open Realtime session (the "Jarvis" experience)
Always-on **cloud** listening is a non-starter: 60-min session cap plus audio-input billing makes an always-open realtime session expensive and fragile. Detect the wake word locally, then connect.

- **openWakeWord** (https://github.com/dscripka/openWakeWord, Apache-2.0) ships a pretrained **`hey_jarvis`** model (`hey_jarvis_v0.1.onnx`/`.tflite`) — literally the wake word this product wants, license-free.
  - Browser/Electron-renderer port: **dnavarrom/openwakeword_wasm** (https://github.com/dnavarrom/openwakeword_wasm) — "browser-first wrapper around the OpenWakeWord models using onnxruntime-web. It exposes a `WakeWordEngine` class … to listen for wake words like `hey_jarvis` directly in Chrome, no native layer required." Uses AudioWorklet mic streaming, configurable thresholds, WASM/WebGPU backends. Working demo: https://deepcorelabs.com/projects/openwakeword/ (writeup: https://deepcorelabs.com/open-wake-word-on-the-web/).
  - Alternative: run the ONNX pipeline (melspectrogram → embedding → wake model) in the Electron **main** process with `onnxruntime-node` for lower renderer overhead.
- **Picovoice Porcupine** (https://github.com/picovoice/porcupine): built-in **"Jarvis"** keyword among free built-ins; `@picovoice/porcupine-web` (renderer, WASM) or `@picovoice/porcupine-node` (main process). Most accurate/battle-tested, but requires a Picovoice AccessKey (free tier = personal/eval; commercial distribution needs a paid license). Prefer openWakeWord for a shippable free path.
- **VAD gate**: `@ricky0123/vad-web` (Silero VAD over onnxruntime-web) as a cheap pre-filter so the wake-word model only runs when there's speech energy. Optional; openwakeword_wasm is already light (~real-time on CPU WASM).

### Recommended pipeline
`getUserMedia (16 kHz mono) → AudioWorklet → openWakeWord hey_jarvis (local, threshold ~0.5–0.7) → on trigger: chime + mint ek_ via main process → WebRTC connect to /v1/realtime/calls with semantic_vad → session ends on idle/timeout/"go to sleep" tool call → return to local listening.`
Handle the 60-min cap by proactively reconnecting (mint new secret, replay a conversation summary into `instructions` or as a `conversation.item.create` history seed).

macOS packaging: `NSMicrophoneUsageDescription` in Info.plist + `com.apple.security.device.audio-input` entitlement (hardened runtime); mic permission prompts once. `systemPreferences.askForMediaAccess('microphone')` from main.

---

## 5. Sources (primary)

- https://openai.com/index/introducing-gpt-live/ (via search/press: macrumors.com/2026/07/08/openai-gpt-live-voice/, siliconangle.com 2026-07-08)
- https://openai.com/form/gpt-live-1-in-the-api/ ; https://x.com/OpenAIDevs/status/2074915334377844896
- https://developers.openai.com/api/docs/guides/realtime (+ /realtime-webrtc, /realtime-websocket, /realtime-conversations, /realtime-vad, /realtime-mcp)
- https://developers.openai.com/api/reference/resources/realtime/subresources/client_secrets/methods/create
- https://developers.openai.com/api/docs/models ; /models/gpt-realtime-2.1 ; /models/gpt-realtime-mini ; /api/docs/pricing
- https://github.com/openai/codex — codex-rs/login/src/server.rs (OAuth params; `obtain_api_key` token exchange)
- https://learn.chatgpt.com/docs/auth (Codex auth docs)
- https://docs.openclaw.ai/providers/openai (ChatGPT-OAuth-vs-API-key for voice, confirmed in production)
- https://github.com/EvanZhouDev/openai-oauth ; https://github.com/numman-ali/opencode-openai-codex-auth
- https://github.com/dscripka/openWakeWord ; https://github.com/dnavarrom/openwakeword_wasm ; https://github.com/picovoice/porcupine ; https://www.npmjs.com/package/@picovoice/porcupine-web
- https://community.openai.com/t/realtime-api-session-timeout-post-ga/1357331 (60-min cap)
