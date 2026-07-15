<!-- /autoplan restore point: /Users/saminyasar/.gstack/projects/jarvis/main-autoplan-restore-20260713-140028.md -->

# Jarvis 0.2 Release Plan

- Status: active
- Date: 2026-07-13
- Branch: `codex/jarvis-0.2-chatgpt-live` (target: `main`)
- Mode: scope expansion, with external-service boundaries called out explicitly

## Implementation correction: pinned ChatGPT Realtime

The initial review assumed ChatGPT sign-in could not power Realtime without copying OAuth tokens
or adding a Platform key/relay. Inspection and live probing of the exact bundled
`rust-v0.144.3` app-server found a narrower supported-by-the-pin experimental contract:
`thread/realtime/start|stop` with WebRTC SDP and server-owned ChatGPT authentication. That
evidence supersedes the earlier voice-provider assumption throughout this plan.

Jarvis therefore makes **LIVE** the zero-key signed-in default. The renderer owns only microphone,
remote audio, and its peer connection; main correlates bounded SDP requests; app-server owns the
authenticated sideband, instructions, Apps, and background handoffs. Native macOS
speech → app-server → TTS remains the automatic **LOCAL** fallback. Jarvis still never reads,
copies, or exposes ChatGPT tokens, and it fails closed if the exact experimental contract changes.

## Outcome

A new Mac user downloads Jarvis, opens it, signs in once with ChatGPT, presses and
holds the talk control, says “Good morning, Jarvis,” hears a reply, sees the
transcript, can connect or reuse Gmail and Google Calendar, can hand a bounded task
to Codex, approves consequential actions, quits, and returns to a signed-in idle
core on relaunch.

The first supported cohort is a Mac-based technical founder or builder with a paid
individual ChatGPT account and access to Codex apps. The hero repeated job is a daily
operating loop:

```text
“Good morning, Jarvis” → calendar/email brief → choose priorities
→ optionally hand a bounded folder task to Codex → approve → evidence-backed receipt
```

Generic conversation and one-off Codex tasks remain, but this loop is the product
activation path and the first workflow exercised by every release candidate.

The downloadable build must not require the user to copy a token, edit a JSON file,
install a CLI, or add a Composio project secret.

## Product contract

| Requirement      | User evidence                                                             | Automated evidence                                                                                               | Launch gate                                   |
| ---------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Download         | DMG and ZIP on GitHub Releases                                            | archive integrity, ZIP/DMG parity, copied-install launch smoke, and quarantined Gatekeeper smoke in trusted jobs | yes                                           |
| First paint      | `CHECKING SECURE SESSION`, no login flash                                 | renderer state test                                                                                              | yes                                           |
| ChatGPT sign-in  | system browser, cancel/retry, verified account                            | app-server protocol integration test                                                                             | yes                                           |
| Session reuse    | relaunch returns to `CORE READY`, microphone off                          | isolated-profile relaunch test                                                                                   | yes                                           |
| Zero-key talk    | ChatGPT-authenticated WebRTC; native speech/TTS fallback                  | pinned Realtime contracts, speech adapter tests, manual mic/audio test                                           | yes                                           |
| Live voice       | app-server owns authenticated Realtime sideband; renderer owns media only | correlated SDP, lifecycle, timeout, and fallback tests                                                           | yes, experimental pin                         |
| GPT-Live-like UX | LIVE transcript/audio without a Platform key                              | packaged signed-in acceptance                                                                                    | describe behavior, not an invented model name |
| Apps             | Gmail/Calendar show connected or Connect, never developer keys            | app-list fixture and clean-profile UI test                                                                       | yes                                           |
| App actions      | connected-app reads only; external writes are disabled in 0.2             | app mention/read-only policy and denial tests                                                                    | yes                                           |
| Codex            | bounded text task in a chosen folder with progress and receipt            | tool-free task thread, exact assistant-dispatch approval, and descriptor-relative native-write integration tests | yes                                           |
| Computer actions | Calculator/Calendar/Notes only; allow once; verified bundle/path          | dynamic-tool, policy, fixed-argv, and receipt tests                                                              | yes                                           |
| Recovery         | offline, expired auth, denied mic, canceled OAuth, tool failure           | state and error-path tests                                                                                       | yes                                           |
| Security         | no refresh token in renderer or Jarvis-owned auth mirror                  | static checks and IPC tests                                                                                      | yes                                           |
| Quality          | format, lint, typecheck, tests, build, package all pass                   | CI                                                                                                               | yes                                           |
| Distribution     | separate arm64 and x64 artifacts; no universal artifact                   | release workflow                                                                                                 | yes                                           |

### Product-learning gates

- median download-to-first-useful-result under five minutes;
- median local speech end-to-end response under four seconds after release of PTT;
- at least 8/10 design partners finish the hero loop without developer help;
- at least 5/10 design partners use the hero loop on three days in week one;
- at least 90% of bounded tasks end in a human-readable receipt;
- zero unintended writes and zero model-asserted approvals;
- every failed/canceled onboarding or approval has a locally inspectable reason;
- product analytics are opt-in, contain no transcript/app content, and are off by default.

## Root-cause diagnosis

The retired 0.1 baseline copied Codex’s OAuth client and private backend calls instead of
using Codex’s supported app-server boundary. It owns and mirrors refresh tokens,
tries to reinterpret ChatGPT auth as a Platform key, and requires a Composio project
secret on every downloaded machine. The packaged binary then resolves Codex inside
virtual `app.asar` rather than physical `app.asar.unpacked`.

As a result, that baseline's signed-in default path is text-only, has `tools: []`, reports Codex
as signed out even when the bundled CLI is authenticated, and shows developer setup
errors where app Connect controls should be. It had no test suite or CI, and its ad-hoc
signature could not satisfy the trusted release gate.

## Decision record

### Alternatives considered

**A. Patch the current implementation**

- Keep custom OAuth, fix the packaged binary path, add browser speech recognition,
  and hide Composio setup errors.
- Smallest diff, but preserves private endpoints, shared token mutation, unreliable
  connector distribution, and a false security boundary.
- Rejected.

**B. First-party local core**

- Spawn the bundled `codex app-server` from `app.asar.unpacked` with an isolated
  `CODEX_HOME` under Jarvis user data.
- Delegate ChatGPT login, refresh, Codex turns, app discovery, app OAuth, approvals,
  and streaming to app-server.
- Use app-server's pinned experimental thread-scoped Realtime WebRTC path for the
  one-login LIVE experience, with native macOS recognition/TTS as automatic fallback.
- Chosen. This is complete, distributable with no Jarvis backend, and removes the
  highest-risk custom code.

**C. Hosted Jarvis relay**

- Add a backend that authenticates Jarvis users, sponsors GPT-Realtime sessions,
  mints ephemeral secrets, and owns Composio credentials.
- Could sponsor future provider-independent sessions or non-ChatGPT users, but it creates
  billing, abuse, privacy, deployment, and operations work without improving the supported
  one-login path in this pin.
- Keep as a separate future product decision, not a hidden dependency of the download.

### Load-bearing decisions

1. App-server is the only ChatGPT credential owner. Jarvis never reads, writes, or
   deletes `~/.codex/auth.json` and never sends ChatGPT tokens through renderer IPC.
2. Jarvis gets its own `CODEX_HOME`. Existing machine-wide Codex sessions may be
   offered for migration only through an explicit user choice in a later release.
3. Gmail, Calendar, GitHub, Drive, Notion, Slack, and other apps come from
   `app/list`. Jarvis does not hardcode connector IDs or receive provider OAuth
   tokens.
4. The zero-key primary lane is `LIVE`: WebRTC media in the renderer and the exact pinned
   `thread/realtime/*` authentication/session contract in app-server. No account credential or
   generic session-control surface crosses renderer IPC.
5. Native speech-to-text → app-server turn → native speech output is the automatic `LOCAL`
   fallback. Jarvis calls the experience GPT-Live-like, not an invented public model/API name,
   and refuses an incompatible future app-server instead of guessing.
6. After the user selects a folder, Codex starts with `on-request` but no app-server environment,
   shell, process, network, image, or ambient filesystem tool. Jarvis exposes only bounded host
   list/read/literal-search/write operations for that exact scope. Each text write receives an
   immutable one-shot approval, executes through a package-owned descriptor-relative native
   helper, and receives an exact postcondition check. Broad computer access remains denied; only
   the fixed Calculator/Calendar/Notes launcher is present on the assistant thread.
7. Every app-server approval is rendered as a local approval record. Model text can
   never self-approve a pending action.
8. Signing and notarization are enabled in CI when Apple secrets exist. Unsigned
   local builds are labeled development artifacts and cannot satisfy the trusted
   install gate.
9. Jarvis owns a provider-neutral `Mission → Policy → Approval → Receipt` model.
   App-server is an adapter, not the product data model, so a future provider swap does
   not discard routines, policies, or evidence.
10. The exact Codex/app-server version and protocol contract are pinned. Startup
    rejects an incompatible server with a named recovery path instead of guessing.
11. macOS privacy grants are never described as expiring. Jarvis can expire its own
    task authorization and links to System Settings when the OS grant must be revoked.
12. Electron main is the only enforcement boundary. App-server approvals are signals,
    never authority; a default-deny `PolicyEngine` evaluates every capability request.
13. Every mutation follows one crash-safe host protocol:
    `intent → approved → dispatched → observed → verified | unknown_outcome`.
    A dispatched mutation is never retried automatically without a provider idempotency
    key or a successful reconciliation read.
14. Approval identity is immutable and single-use:
    `{processEpoch, rpcId, threadId, turnId, itemId, intentHash, expiresAt}`. Changing
    the account, target, arguments, scope, provider generation, or policy version creates
    a new approval. Logout, restart, or account change invalidates it.
15. Receipts are host-assembled from structured protocol events and verification data.
    Model prose is untrusted presentation text and can never prove success.
16. Production has no generic renderer-to-app-server RPC, shell, filesystem, environment,
    or process bridge. Each renderer capability has one validated, rate-limited IPC method.
17. Version 0.2 uses manual updates and has no remote rollback. Pulling a GitHub Release
    only contains new installs; installed clients require a fix-forward release.

## Architecture

```text
 Renderer (sandboxed)                       Electron main (trust boundary)
 ┌─────────────────────────────┐           ┌─────────────────────────────────┐
 │ Onboarding + HUD            │ narrow IPC│ PolicyEngine + ApprovalBroker   │
 │ Talk + transcript           │◀─────────▶│ WriteCoordinator + ActionLedger │
 │ Apps + receipts             │           │ MissionStore + ReceiptAssembler │
 │ approvalId + decision only  │           └──────────────┬──────────────────┘
 │ no credentials/arguments    │                          │ typed adapter calls
 └─────────────┬───────────────┘           ┌──────────────▼──────────────────┐
               │                           │ JarvisAppServer                 │
               │ WebRTC media/SDP           │ generation-tagged JSON protocol│
               ▼                           │ isolated 0700 CODEX_HOME       │
 ┌─────────────────────────────┐           │ verified bundled Codex binary  │
 │ Voice lanes                 │           └───────────┬─────────┬───────────┘
 │  ChatGPT LIVE (default) ────┼───────────────────────┘         │
 │  LocalMacSpeech (fallback)  │                       ▼         ▼
 └─────────────────────────────┘             ChatGPT auth     Codex app directory
                                             + Realtime/turns + app OAuth
```

Approved task writes leave app-server entirely: main passes one immutable prepared mutation to a
package-owned native helper, which has no network, shell, or microphone entitlement surface.

### Enforced execution protocol

`PolicyEngine` accepts only canonical `ActionIntent` records. Inputs are source account,
operation, canonical arguments, data classification, target, workspace realpath, network
requirement, provider generation, and requested capability. It returns
`allow_read | require_approval | deny` with a policy version and human-readable reason;
the default is deny. Source permissions bind to the exact account and mission. Cached app
metadata can populate UI but cannot authorize access.

For filesystem tasks, main resolves the selected scope with `realpath`, rejects symlink
escape, stores the device/inode when available, and revalidates immediately before the
operation. The only mutation is delegated after approval to a package-owned helper that walks
the root and parent with `openat`/`O_NOFOLLOW`, binds device/inode and exact preimage, rejects
multi-link files, and verifies the same pathname and bytes after writing. Broad computer access,
credential/login pages, secret fields, system settings, and paths outside the approved root
remain denied in 0.2.

The durable action ledger uses a transactional store and this state machine:

```text
INTENT ──policy deny──────────────▶ DENIED
  │
  ├─allow read────────────────────▶ DISPATCHED ─▶ OBSERVED ─▶ VERIFIED
  │
  └─approval required─▶ APPROVED ─▶ DISPATCHED ─▶ OBSERVED ─▶ VERIFIED
                                      │              │
                                      └─crash/exit────┴──────▶ UNKNOWN_OUTCOME
```

`intentHash` covers the rotating account capability, durable principal partition, operation,
target, canonical arguments, scope, data class, and provider generation. The approval record
separately pins the policy version and also carries a random ID, process epoch, protocol IDs,
monotonic expiry, decision timestamp, and a consumed bit. Approvals are single-use. The renderer
can return only `{approvalId, decision: approve | deny}`; main looks up immutable arguments and
atomically consumes the approval.

Before dispatch, main commits the approved attempt. After dispatch, a mutation is never
blindly replayed. When the provider returns a resource/request ID, main records it and
performs a read-after-write verifier. If the child, app, or machine exits between dispatch
and verification, the attempt becomes `unknown_outcome`; Jarvis reconciles by ID where
possible or asks the user to inspect the provider. It never reports failure as proof that
the write did not happen.

`ReceiptAssembler` derives terminal state, target, changes, provider request/resource IDs,
intent hash, approval ID, attempt number, structured observations, verifier result, and
timestamps from the ledger and protocol. Missing completion or verification cannot become
success. The assistant's summary is stored separately as untrusted display text.

### Process and data lifecycle

- Each app-server lifetime has a random process epoch/generation. Late messages and
  approvals from older generations are rejected.
- The live account capability rotates on every verified account transition. Receipt lookup uses a
  separate install-local HMAC partition derived from normalized personal-account email and a
  random secret protected by Electron safe storage. No email is persisted in the ledger. Null or
  ambiguous workspace identities keep read-only conversation/Apps available but disable durable
  mutations; legacy unpartitioned rows remain unclaimed.
- A desktop single-instance lock prevents a second process from sharing the same CODEX_HOME or
  prematurely recovering the first process's live ledger attempts.
- Exit rejects pending reads and fails closed. The user-initiated **Retry with ChatGPT**
  action restarts the local core, revalidates the existing ChatGPT session, and resumes
  without another browser round-trip when that session is still valid. A dispatched or
  observed write becomes `unknown_outcome`; pre-dispatch intents are blocked and never
  replayed.
- The child receives a minimal environment with no ambient API keys or overridden endpoints.
  Its private home is mode 0700; stderr and protocol lines are size-bounded and redacted.
- Graceful quit cancels reads, waits a bounded interval for writes, journals uncertainty,
  terminates the process group, and never silently abandons a dispatched action.
- Sleep/wake, network changes, logout, account changes, app revocation, disk-full, and OS
  clock changes have named transitions. Live expiries use monotonic time.
- Missions and ledger records carry schema version, account binding, IANA timezone,
  local date, source freshness, and migration version. Migrations are transactional with
  backups and downgrade compatibility checks.

### ChatGPT login state machine

```text
 CHECKING_SESSION
   ├─ account present ───────────────────────────────▶ SIGNED_IN
   ├─ account absent ────────────────────────────────▶ SIGNED_OUT
   └─ app-server unavailable ─▶ RECOVERABLE_ERROR ──▶ RETRY

 SIGNED_OUT ─▶ OPENING_BROWSER ─▶ WAITING_FOR_APPROVAL
   ▲                 │                    ├─ completed ─▶ SECURING_SESSION ─▶ SIGNED_IN
   │                 └─ browser error ───▶ RECOVERABLE_ERROR
   └──────────────────────── cancel / denied / timeout
```

### Conversation flow and shadow paths

```text
 TALK PRESS
   ├─ mic unknown ─▶ permission prompt
   ├─ mic denied ──▶ text mode + Open System Settings
   └─ mic ready ───▶ listen ─▶ transcript
                                  ├─ empty ─▶ return to ready, no turn
                                  ├─ error ─▶ recoverable local-voice error
                                  └─ text ──▶ turn/start
                                               ├─ approval request ─▶ overlay
                                               ├─ app/tool result ───▶ progress
                                               ├─ auth expired ──────▶ reauthenticate
                                               ├─ upstream error ────▶ retry/error
                                               └─ final text ────────▶ TTS + receipt
```

### App flow

```text
 app/list
   ├─ accessible + enabled ─▶ CONNECTED ─▶ mention in turn
   ├─ installUrl allowed ───▶ CONNECT ─▶ system browser ─▶ forceRefetch
   ├─ unavailable by policy ▶ UNAVAILABLE with reason
   └─ network/auth failure ─▶ RETRY, keep last known non-sensitive metadata
```

## UX specification

The GraphCore orb, open edge rails, hairline branches, Big Shoulders display type,
Martian Mono labels, cobalt listening state, ember idle state, and report-overlay
language remain. Developer vocabulary and setup plumbing leave the primary UI.

### Information hierarchy

1. Center: today’s mission and the single talk action, visually anchored to the core.
2. Left rail: conversation plus source provenance, not debug telemetry.
3. Right rail: pending decisions, Apps, and recent receipts.
4. Top edge: identity, local/live voice label, microphone state, and privacy inventory.
5. Advanced settings: current voice status and diagnostics. Data retention, export, and delete
   controls are not shipped in 0.2.

At widths below 1180px, Apps and Activity collapse into named drawers while the talk
control, transcript, approvals, and stop action remain visible.

The orb remains the visual protagonist, but it never reports state for its own sake.
Hairline callouts attach mission title, next decision, current action, and completion
evidence to the core. Talk is the input; the mission is the user’s object of work.

### Canonical daily-mission sequence

```text
CHECK SESSION → SIGN IN → OPEN LIVE CHANNEL → CORE READY
                              └─ unavailable ─▶ ENABLE LOCAL VOICE
      ↓
“Good morning” or START DAILY BRIEF
      ↓
SOURCE CHECK ── missing source ─▶ contextual CONNECT / CONTINUE WITH AVAILABLE
      ↓
BRIEF BUILDING → TODAY: calendar / inbox, each with source + freshness
      ↓
PRIORITIES: ranked 1–3 → KEEP / EDIT / LATER / ADD
      ↓
ACTION PREVIEW: target + data + scope + before/after + policy
      ↓
APPROVE ONCE / CHANGE SCOPE / CANCEL
      ↓
EXECUTING: one bounded Codex workspace-mutation lane, progress callout, STOP / STEER
      ↓
RECEIPT: success / partial / blocked / no-op + evidence + next action
      ↓
MISSION COMPLETE → TOMORROW reuses sources and user choices, never auto-executes
```

The brief starts only after the user’s first greeting or `Start daily brief`. On a
first run with no usable sources, the center callout offers the ChatGPT Apps already available
to the account and keeps typed conversation usable. Repository work is introduced separately
through the host-owned folder chooser; no brief silently grants folder authority. First-run
success is a useful answer or an explicit source decision, not merely `CORE READY`.

### Mission and receipt anatomy

`Mission` is persisted separately from conversation history:

- local date, title, status, selected sources, and freshness timestamps;
- ordered priorities with `keep | edit | later | done` decisions;
- bounded proposed actions and their approval IDs;
- linked task/app results and receipt IDs;
- no provider refresh token, raw email body, or hidden chain-of-thought.

The center shows one mission callout at a time: `BRIEF`, `DECISION`, `ACTION`, or
`RESULT`. The full mission opens in the existing report overlay. A receipt shows
terminal state, requested action, approved target/scope, changes made, provenance,
verification, duration, and available result/details actions. Export and delete are deferred.
Partial success lists completed and incomplete actions separately.

`New conversation` starts a new assistant thread and clears visible transcript state;
it never deletes the current mission, running task, or receipts. Data deletion is a
future named settings action with explicit scope; no in-app retention, export, or delete control
ships in 0.2.

### First run

1. `CHECKING SECURE SESSION` appears on first paint.
2. Signed-out copy: `YOUR CHATGPT ACCOUNT POWERS THE CORE` and
   `Continue with ChatGPT`.
3. Browser progress: `OPENING BROWSER`, `WAITING FOR APPROVAL`,
   `SECURING SESSION`, `IDENTITY VERIFIED`, with Reopen and Cancel.
4. Ask for microphone permission when Engage starts LIVE. Ask for Speech Recognition only if
   LOCAL fallback is needed. Always offer `Use text instead`.
5. Boot the full HUD once and land on `CORE READY · Hold to talk`.
6. Do not auto-play a greeting. The first user utterance starts the session.

### Interaction state matrix

| Feature     | Loading                      | Empty                    | Error                              | Success                           | Partial/recovery                 |
| ----------- | ---------------------------- | ------------------------ | ---------------------------------- | --------------------------------- | -------------------------------- |
| Session     | checking secure session      | sign-in invitation       | retry with named cause             | masked account, signed in         | expired session, sign in again   |
| LIVE voice  | opening ChatGPT channel      | signed out/not entitled  | pin/network/SDP/mic error          | live/listening/speaking           | reconnect or automatic LOCAL     |
| LOCAL voice | requesting speech permission | no input yet             | denied/no device/recognizer failed | ready/listening/thinking/speaking | text mode                        |
| Apps        | checking apps                | add an app               | service unavailable/retry          | connected account/app             | waiting in browser/reconnect     |
| Codex       | selecting scope/starting     | explain first safe task  | blocked/approval/exhausted         | result plus receipt               | running/stop/restore             |
| Receipts    | restoring                    | explain what will appear | corrupted entry skipped and logged | detail overlay                    | partial success named explicitly |

### Approvals

Use the existing report-overlay composition as a focus-trapped action sheet:

- exact action and target: fixed system-app command/path, assistant handoff prompt/folder, or each
  text-file path, change type, and untruncated diff/full replacement content;
- data to be read or, for a bounded Codex workspace mutation, written;
- sandbox/network/access level and expiry;
- `Run once` and `Cancel`; scope changes happen through the host folder chooser;
- a stable approval ID tied to the app-server request;
- stronger copy for destructive writes or the bounded system-app launcher; full-computer access
  remains unavailable.

Related read-only lookups may be grouped in one preview. Connected-app writes are policy-denied
in 0.2. Every eligible Codex text-file write gets its own approval; Jarvis never batches unrelated
file changes. Approval expiry is visible. A changed target, arguments, or scope invalidates the
approval and creates a new one.

The overlay never owns action arguments. It receives an immutable, complete, display-safe preview
plus `approvalId`, and returns only approve or deny. Main rejects a stale process epoch,
expired monotonic deadline, consumed record, changed canonical digest, changed account,
changed workspace identity, or changed provider generation. There is no spoken
`confirmed: true` field, model-generated confirmation, or renderer-controlled replay path.

Only one workspace-mutation task executes at a time. While Jarvis speaks, pressing talk interrupts
TTS and listens. While it thinks or executes, talk accepts `status`, `stop`, or a steer
instruction; unrelated work is offered as `Queue after this` rather than started in
parallel. Stop is immediate before dispatch and best-effort once a host-side mutation has
begun, with the receipt naming any partial result.

### Accessibility

- 11px minimum micro-labels, 13px body/actions, and 16px mission summaries, all in rem.
- 3:1 controls and 4.5:1 body contrast, state text in addition to color.
- visible `:focus-visible`, 44px targets, focus trapping and restoration.
- `role=status` for coarse state changes and `role=log` for final transcript rows.
- Space push-to-talk only when the document surface owns focus; focused controls keep
  normal keyboard behavior.
- GraphCore renders a static low-motion mode for reduced motion/transparency.
- The orb is decorative to assistive technology; its adjacent status has an accessible
  name such as `Jarvis ready, microphone off`.
- Only completed transcript rows and coarse state changes enter live regions. Token
  deltas, timers, and decorative motion are never announced.
- Keyboard order is top identity/privacy → center mission/talk → left transcript →
  right decisions/apps/receipts → bottom/advanced actions. Escape closes drawers or
  overlays and restores focus to their trigger.
- The hero flow must complete at 200% zoom, keyboard-only, voice-only with spoken
  approval fallback disabled for writes, high-contrast mode, and reduced motion.

### Component and layout rules

- Spacious layout at 1360px and above: 304px left rail, fluid center stage, 304px
  right rail, 28px outer inset, 24px gutters.
- Compact layout from 1120–1359px: 260px transcript rail, fluid stage, Apps/Activity
  become mutually exclusive non-modal drawers; pending approvals remain centered.
- Minimum supported window is 1120×720. Below it, the app shows a named size warning
  instead of silently clipping controls.
- Report/approval overlay: `min(760px, calc(100vw - 64px))`, max 80vh, native dialog
  semantics, fixed header/actions, scrollable body.
- Type roles: Big Shoulders 34/28/22 for wordmark, clock, and mission titles;
  Martian Mono 16/13/11 for mission summary, body/action, and labels. No 7–9px text.
- Spacing uses 4, 8, 12, 16, 24, 32, and 48px tokens. Rails use dividers and scrims,
  not nested cards. Cards exist only for an interactive app or approval target.
- Enter/focus feedback is 100–150ms, overlay/state transitions 200–300ms, boot/core
  ignition 500–800ms, using transform/opacity. Reduced motion uses crossfades only.
- Every control has default, hover, focus, active, disabled, loading, error, and success
  treatment where applicable. Primary action color appears once per composition.
- Long account names, paths, and subjects truncate visually with an accessible full
  name and a disclosure/tooltip; action details wrap rather than horizontal-scroll.

## Implementation workstreams

### Lane A: protocol and identity

1. Pin `@openai/codex` and `@openai/codex-sdk` exactly, check in generated protocol
   types/schema and its hash, and add one physical executable resolver used everywhere.
   Release builds prohibit `PATH` fallback and verify version, architecture, capabilities,
   binary SHA-256, and the expected initialize response.
2. Add typed app-server lifecycle with process epochs, request correlation, bounded
   framing, notification subscriptions, allowlisted server-request replies, minimal child
   environment, redacted logging, crash circuit breaker, and graceful process-group shutdown.
3. Replace custom OAuth/token-store IPC with `account/read`, managed login,
   cancellation, completion, logout, and explicit bootstrap states.
4. Remove private ChatGPT backend calls and auth-file mirroring from production paths.
5. Configure the isolated app-server home with human-review approval policy and restrictive
   sandbox/network defaults. Treat this as defense in depth behind Jarvis policy.

### Lane B: conversation, apps, and approvals

1. Add an app-server conversation gateway for ephemeral assistant threads and bounded
   Codex task threads.
2. Implement the default-deny `PolicyEngine`, single-use `ApprovalBroker`, one-lane
   `WriteCoordinator`, transactional `ActionLedger`, and host-owned `ReceiptAssembler`
   before enabling any mutation.
3. Stream final messages, progress, and named terminal states. Never default malformed,
   incomplete, unverified, or generation-stale output to success.
4. Replace hardcoded Composio cards with paginated `app/list`; validate HTTPS
   `installUrl` before opening it.
5. Convert app-server approval requests into host policy intents. The renderer returns
   only a user decision for an immutable approval ID.
6. Add folder selection, realpath/device revalidation, symlink/hardlink escape denial, and a
   host-owned bounded list/read/literal-search/write namespace. Start task threads with
   `environments: []`; shell, process, network, image, delete, and move remain unavailable.
   Route the one approved write operation through the packaged descriptor-relative helper; keep
   no JavaScript pathname-mutation fallback.
7. Remove the current model-visible `confirmed` tool parameter and all direct renderer
   tool execution. No generic renderer-to-app-server RPC is introduced.
8. Install one non-deferred namespaced dynamic tool on the assistant thread for the fixed macOS
   app catalog. Main binds every call to the exact account/generation/thread/turn/RPC, obtains
   one-shot approval, executes fixed argv, and returns only a host-verified result.
9. Bind task-thread workspace calls to their exact account, durable principal, provider generation,
   thread, turn, RPC, workspace device/inode, path identity, and call fingerprint. Deduplicate
   identical call IDs and reject conflicting replays.
10. Give assistant-originated task dispatch its own exact prompt/folder approval and a single
    pending slot. Retain only the replay tombstone needed for the active assistant turn, then
    retire it on turn/account/generation transition.

### Lane C: voice and onboarding

1. Add the exact pinned `thread/realtime/*` protocol surface, correlate one WebRTC offer/answer
   at a time in main, and keep session policy/account credentials inside app-server.
2. Keep the renderer limited to microphone, remote audio, transcript events, and bounded SDP;
   never send `session.update` because app-server owns instructions, Apps, and handoffs.
3. Add a native macOS push-to-talk recognizer helper, permission checks, partial/final
   transcript events, cancellation, device/error recovery, and packaged resource build.
4. Route fallback recognized text through the app-server conversation gateway, then speak the
   final reply with a selected native system voice.
5. Implement checking-session, browser-login, microphone, ready, reconnect, and text
   fallback screens while preserving GraphCore design.
6. Fix Codex panel styles, compact window layout, keyboard focus, reset/new-conversation
   semantics, privacy masking, and reduced motion.

### Lane D: verification and distribution

1. Add Vitest unit/integration tests and Playwright/Electron smoke tests.
2. Add fixtures for app-server protocol, login, app pagination, approvals, disconnects,
   malformed messages, process crashes, and native voice output.
3. Add GitHub Actions for lint, typecheck, test, build, package, archive verification,
   and native-architecture matrix builds.
4. Current scripts provide `format:check`, `test:coverage`, `test:e2e`, `verify:ci`, and package
   contract smoke. A generic `verify` alias and broader parser/property suites are not shipped.
5. `build:mac` creates development artifacts after type/build and native staging; the full CI and
   artifact-verification gates remain separate commands. The trusted workflow currently uploads
   only DMG and ZIP assets. Checksums, an SBOM/license inventory, protocol/binary hash assets, and
   a signed release manifest are not yet published and must not be described as release evidence.
6. Configure hardened runtime, minimal entitlements, nested-binary signing, notarization,
   and stapling from secrets.
   Fail trusted release jobs when signing inputs are absent; keep a separate clearly
   labeled development artifact path.
7. Build native helpers separately on arm64 and x64, then package and smoke each matching
   Codex/helper architecture. Cross-building a native helper is not accepted as evidence.
8. Replace stale goal/README claims with evidence and limitations, including manual
   updates and no remote rollback in 0.2.

### Legacy kill list

The following production paths must be deleted, not retained as fallback:

- custom PKCE OAuth server, token exchange, refresh-token store, and Codex auth mirror;
- private `chatgpt.com/backend-api/codex/responses` fallback;
- Composio developer-key connector cards and renderer-visible tool schemas;
- model-controlled `confirmed: true` execution;
- SDK task bridge with `approvalPolicy: never`, home-directory default, and prompt-parsed
  success receipts;
- generic `window.electron`/`electronAPI` invoke, send, receive, and environment exposure;
- arbitrary `shell.openExternal` and renderer navigation/window creation;
- silent `PATH` resolution or virtual `app.asar` execution in a release build.

## Error and rescue registry

| Codepath            | Named failure                          | Rescue                                                                 | User sees                       | Test                  |
| ------------------- | -------------------------------------- | ---------------------------------------------------------------------- | ------------------------------- | --------------------- |
| Codex resolve/spawn | executable missing/not executable      | try physical dev/package paths, then stop                              | repair/reinstall message        | unit + packaged smoke |
| JSON line parser    | malformed/oversized line               | reject correlated request, redact/log, restart if framing lost         | core reconnecting               | unit                  |
| Protocol request    | timeout/process exit                   | reject by method, bounded restart                                      | retry action                    | integration           |
| Process generation  | late reply/old approval                | reject epoch, invalidate pending state                                 | core restarted; review again    | unit + integration    |
| Write coordinator   | crash before dispatch                  | recover committed approved intent; do not dispatch without user action | action not started              | crash injection       |
| Write coordinator   | crash after dispatch                   | mark `unknown_outcome`, reconcile by resource ID, never auto-retry     | outcome needs review            | crash injection + E2E |
| Policy              | unclassified capability/account change | default deny and create no attempt                                     | action blocked by safety policy | property + E2E        |
| Workspace           | symlink/path replacement               | realpath/device revalidation and deny                                  | folder scope changed            | unit + integration    |
| Login start         | app-server/auth URL invalid            | cancel login, never open URL                                           | sign-in unavailable             | unit                  |
| Login completion    | canceled/denied/expired                | return to sign-in with cause                                           | try again                       | integration           |
| Account refresh     | offline/expired                        | preserve signed-out boundary                                           | reconnect/sign in               | integration           |
| App list            | page loop/network/policy               | cap pages, keep last metadata, retry                                   | apps unavailable                | unit                  |
| App install         | unsafe/missing URL                     | refuse external open                                                   | app cannot be connected here    | unit                  |
| Turn start          | empty input                            | no request                                                             | ready                           | unit                  |
| Turn stream         | refusal/rate limit/network             | named terminal state, retry when safe                                  | exact cause and retry           | integration           |
| Approval            | stale/duplicate/changed args           | deny and require new approval                                          | approval expired                | unit + E2E            |
| Native speech       | denied/no device/service error         | text mode and settings link                                            | exact recovery                  | integration/manual    |
| TTS                 | unavailable/canceled                   | keep text result                                                       | audio unavailable               | unit                  |
| Realtime            | pin/entitlement/SDP/network/disconnect | stop exact session, switch to LOCAL                                    | switched to local voice         | unit + integration    |
| Receipt store       | corrupt/partial write                  | atomic writes, skip corrupt entry                                      | history partially restored      | unit                  |
| Ledger              | disk full/migration failure            | rollback transaction, restore backup, disable writes                   | storage must be repaired        | integration           |
| Lifecycle           | sleep/wake/logout/revocation           | invalidate approvals, refresh reads, journal writes                    | session/app changed             | integration + E2E     |
| Release signing     | cert/notary missing/fails              | fail trusted job                                                       | no trusted release published    | CI                    |

## Test coverage map

```text
 UNIT
 ├─ executable path: dev, app.asar, app.asar.unpacked, missing, wrong arch
 ├─ protocol: ids, timeout, malformed JSON, notification, server request, restart
 ├─ auth: checking, present, absent, cancel, deny, expiry, logout
 ├─ apps: pagination, allowlisted URL, connect refresh, inaccessible, policy disabled
 ├─ approvals: accept, decline, stale id, double click, argument mutation
 ├─ policy: default deny, account binding, capability matrix, canonical intent hash
 ├─ workspace: symlink escape, path replacement, device/inode change
 ├─ action ledger: every legal transition, illegal transition, monotonic expiry
 ├─ voice: permission, empty transcript, cancel, recognizer error, TTS cancel
 ├─ task result: success, no-op, blocked, approval, exhausted, no progress, malformed
 └─ UI state reducers and accessibility labels

 INTEGRATION
 ├─ fake app-server child: initialize → login → account → app list → turn
 ├─ child crash and bounded restart
 ├─ app mention plus read-only tool result
 ├─ approval request round trip
 ├─ crash before dispatch, after dispatch, after provider success, before receipt commit
 ├─ account switch/logout/revocation during approval and execution
 ├─ parser fuzzing, oversized/chunked lines, stale generations, stdout backpressure
 ├─ sleep/wake, DST/timezone rollover, disk-full, migration and downgrade
 ├─ native recognizer JSON stream
 └─ receipt persistence and relaunch

 E2E
 ├─ fresh isolated profile opens on checking/session screen
 ├─ browser-login states through a fake app-server
 ├─ signed-in ready HUD has no developer-key errors
 ├─ text ask → streamed reply → spoken-state transition
 ├─ app Connect waiting/success/retry
 ├─ scoped Codex task approval/deny/stop/receipt
 ├─ duplicate approval click/race and compromised-renderer forged IPC
 ├─ unknown-outcome recovery without duplicate dispatch
 └─ compact window, keyboard-only, reduced-motion smoke

 MANUAL RELEASE
 ├─ clean Mac install and first login against real ChatGPT
 ├─ real microphone: “Good morning, Jarvis” round trip
 ├─ real Gmail/Calendar read and a denied write
 ├─ chosen-folder Codex clean no-op and approved disposable file change
 ├─ quit/relaunch returns ready with microphone off
 └─ codesign, Gatekeeper, DMG, and ZIP on both architectures; ancillary release assets remain absent
```

## Security threat model

| Threat                                     | Likelihood | Impact   | Mitigation                                                                                                          |
| ------------------------------------------ | ---------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| refresh-token theft from renderer          | medium     | high     | app-server owns auth; no token IPC                                                                                  |
| OAuth URL substitution                     | medium     | high     | parse and allowlist HTTPS host/path before open                                                                     |
| arbitrary IPC caller                       | medium     | high     | validate sender frame/origin and payload schema                                                                     |
| prompt injection requests app write        | high       | high     | connected-app writes are disabled; host policy denies the request                                                   |
| model self-confirms                        | medium     | high     | decisions are keyed to pending host request IDs                                                                     |
| broad filesystem task                      | high       | high     | folder chooser; tool-free task environment; host-only bounded file namespace; no shell/network/delete/move          |
| credential-page computer use               | medium     | high     | prohibit login/credential pages and secret fields                                                                   |
| packaged Composio/OpenAI secret extraction | high       | high     | no publisher secret in desktop package                                                                              |
| unsafe external link                       | medium     | high     | allowlist schemes/hosts; block window creation/navigation                                                           |
| malicious protocol output/log leakage      | low        | high     | size limits, structured redaction, no raw auth data                                                                 |
| cross-tool prompt injection/exfiltration   | high       | high     | retrieved app data is untrusted, tool boundaries, preview, deny secret/credential targets                           |
| sensitive receipt persistence              | medium     | high     | bounded metadata/summary fields and mode-0600 local SQLite; encrypted retention/export/delete controls are deferred |
| duplicate write after crash/retry          | medium     | critical | transactional ledger, no mutation replay, reconciliation and unknown outcome                                        |
| upstream omits/mislabels approval          | medium     | critical | host default-deny policy evaluates every capability independently                                                   |
| symlink/workspace pathname escape          | medium     | high     | scope identity plus descriptor-relative `O_NOFOLLOW` mutation, exact preimage, single-link and post-path checks     |
| cross-account receipt disclosure           | medium     | high     | rotating session capability plus safe-storage-backed durable principal partition                                    |
| concurrent desktop ledger ownership        | low        | high     | OS single-instance lock focuses the existing window                                                                 |
| ambient secret inheritance                 | medium     | high     | minimal child environment; no API keys or endpoint overrides                                                        |

Release security gates are concrete: `sandbox: true`, `contextIsolation: true`,
`nodeIntegration: false`, and `webSecurity: true`; navigation and window creation are
denied; a single main-process URL policy accepts only named HTTPS login/install hosts;
session permission handlers default-deny; every IPC call is main-frame checked,
schema-validated, size-limited, and rate-limited. The generic preload bridge is absent.
The transactional ledger is a plaintext SQLite WAL restricted to mode 0600 inside the app's
private user-data directory. It stores bounded action metadata and short receipt summaries, not
provider credentials. Encryption, retention policy UI, export, and delete controls are not shipped
in 0.2 and remain a privacy-hardening gate before wider distribution.

## Performance and capacity gates

| Measure                               | Warm p50 | Warm p95 | Cold p95 / cap |
| ------------------------------------- | -------: | -------: | -------------: |
| first safe HUD paint                  |   350 ms |   700 ms |          1.5 s |
| session status resolved               |   500 ms |    1.5 s |            3 s |
| STT final after PTT release           |   350 ms |   900 ms |            2 s |
| app-server first text delta           |   900 ms |    2.5 s |            5 s |
| first audible TTS after final text    |   200 ms |   600 ms |          1.2 s |
| renderer control feedback             |    50 ms |   100 ms |         150 ms |
| GraphCore frame time on supported Mac |    12 ms |    20 ms |          33 ms |

Renderer stream updates are coalesced to at most 20 Hz. Protocol lines cap at 1 MiB,
stderr at 2 MiB per process generation, one tool result at 256 KiB before host shaping,
one transcript at 500 visible rows, one task at 1,000 events, apps at 1,000 paginated
records, receipts at 10,000 indexed records, and one pending assistant-originated Codex handoff.
GraphCore edge data is precomputed or spatially indexed,
rendering pauses while hidden, device pixel ratio is bounded, and reduced motion uses a
static/low-FPS composition. Exceeding a bound yields a named partial/error state.

## Deployment and rollback

```text
 PR gates ─▶ package matrix ─▶ archive smoke ─▶ signed/notarized artifacts
     │              │                 │                    │
     └─ fail        └─ fail           └─ fail              └─ publish draft/release

 containment: mark release pre-release/yank latest pointer ─▶ block new installs
              ─▶ publish issue with affected version ─▶ fix forward under same gates
```

Version 0.2 has manual updates and no remote rollback for installed clients. A yanked
release only prevents more downloads. Incidents therefore use containment plus a new,
higher-version fix-forward release. Mission/ledger migrations create a versioned backup
before mutation and declare the oldest readable schema; downgrade and restore are tested.

Release packaging has distinct development and trusted configurations. Trusted jobs build
and smoke arm64 and x64 separately, sign nested Codex, speech-helper, and workspace-helper Mach-O
binaries first, sign the app with hardened runtime and minimal entitlements, notarize, staple,
mount the DMG and expand the ZIP, then run strict `codesign` and `spctl` checks on copied,
quarantined installs. The workflow must be dispatched from `main`; it requires the requested tag,
checkout, and freshly fetched `origin/main` to identify the same commit before running repository
scripts or loading release secrets. It creates an immutable draft contract. A separate protected
promotion re-downloads every asset, rechecks its digest/size, native package evidence, tag/main
identity, quarantine acceptance, and unchanged draft before publication. The current draft
workflow publishes only four application assets: one DMG and one ZIP for each architecture.
It does not yet publish checksums, an SBOM/license inventory, protocol/binary hashes, or a signed
manifest. Missing Apple credentials fail the trusted job; they never silently create a release
labeled trusted.

The app-server migration is the only production path on this branch. The old custom auth path is
removed rather than retained behind a silent fallback or feature flag.

Before a public release, five acceptance spikes must pass on the real bundled binary:

1. isolated-profile ChatGPT login, restart, refresh, and logout using the bundled resolved
   binary, not `PATH`;
2. `app/list` availability and one read-only Gmail/Calendar turn on the supported account;
3. packaged local speech permission and measured speech-to-text latency;
4. exact-license, redistribution, platform-policy, and protocol-compatibility review,
   including generated schema and binary hashes on both architectures;
5. host-policy write spike in a disposable target: approval, provider observation,
   read-after-write verification, cleanup, and crash-induced unknown outcome.

If any spike fails, stop the affected lane and keep the result as a documented blocker.
Fixtures do not substitute for these real-contract checks.

## Not in scope for 0.2

- Calling the pinned experimental app-server path a stable public GPT-Live model/API, or bypassing
  app-server by copying ChatGPT credentials into a renderer/client-secret flow.
- Shipping a shared publisher API key inside Electron.
- Deploying and funding a Jarvis cloud relay without an owner, billing limits, privacy
  policy, abuse controls, and production credentials.
- Always-listening wake word. Push-to-talk is the privacy-preserving launch behavior.
- Silent unrestricted computer control or automation of credential/login pages.
- Mobile clients. This release is the Mac desktop journey already present in the repo.
- Removing Gmail/Calendar or Codex to turn Jarvis into a single-purpose product. Both
  independent CEO reviewers recommended that reduction, but it conflicts with the
  explicit product direction; the daily operating loop supplies focus without deleting
  the requested capabilities.
- Public rollout beyond a small design-partner beta before the activation and safety
  gates above have evidence.

## Autoplan Phase 1: CEO review

### Premise challenge

| Premise                                                    | Assessment                                                    | Plan response                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| One ChatGPT login can power Codex and connected apps       | proven locally on Plus, not universal                         | define supported cohort, run entitlement matrix, never promise all accounts                      |
| One ChatGPT login can power LIVE voice in the pinned build | proven at protocol level, entitlement still account-dependent | make pinned Realtime default and fail to LOCAL cleanly                                           |
| Local PTT is good enough as fallback                       | unproven                                                      | retain real latency/accuracy gate and label it `LOCAL`                                           |
| App-server is a stable third-party distribution contract   | unproven                                                      | pin version, contract tests, policy/license gate, compatibility failure state                    |
| Gmail/Calendar/Codex breadth creates retention             | unproven                                                      | make the daily operating loop the activation and retention hypothesis                            |
| Approvals create trust                                     | partly true                                                   | add provenance, preview, deletion/retention, cross-tool isolation, zero unintended writes metric |
| GitHub Releases can be consumer-friendly                   | only with trusted artifacts and updates                       | signing/notarization gate plus update/incident path                                              |

The user explicitly requested a broad Jarvis and no clarification questions. The
premise gate therefore accepts the requested product direction while correcting the
false credential, distribution, and entitlement premises with evidence gates.

### What already exists

| Sub-problem     | Existing asset                                          | Disposition                                                               |
| --------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| Visual identity | GraphCore, HUD rails, transcript, report overlay        | reuse and harden                                                          |
| ChatGPT auth    | custom PKCE/token mirror                                | replace with app-server managed auth                                      |
| Text fallback   | private Codex Responses endpoint plus native TTS        | replace backend call; retain TTS adapter                                  |
| Realtime        | renderer WebRTC client plus unsafe Platform-key minting | retain media client; replace minting with app-server SDP/session contract |
| Apps            | Composio cards and function loop                        | replace default path with app-server `app/list`; optional relay later     |
| Codex tasks     | SDK bridge, boundaries, receipts                        | reuse UX concepts; replace process/auth boundary and fail-closed parsing  |
| Packaging       | Electron builder, icons, DMG/ZIP                        | repair signing, architectures, CI, install smoke                          |
| Loop discipline | Loopy-derived task prompt and receipts                  | add host-enforced finite acceptance loop                                  |

### Dream-state delta

```text
CURRENT
broken private-auth shell, typed fallback, developer connector secrets, weak proof
   │
   ▼
0.2 PLAN
one-login local core, daily mission, native PTT, apps/Codex approvals, receipts, CI
   │
   ▼
12-MONTH IDEAL
provider-neutral saved routines, measurable trust/retention, optional sponsored live
voice, safe update channel, policies/evidence that survive any single AI provider
```

### Selective expansion decisions

- Accepted: daily operating-loop activation, product metrics, compatibility pinning,
  local data inventory/export/delete, and pre-implementation real-contract spikes.
- Deferred: hosted sponsored Realtime, public analytics backend, and broad distribution;
  each requires new infrastructure or external accounts.
- Rejected: deleting either personal apps or Codex from the requested product.

### Temporal interrogation

| Stage                  | Decision locked now                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| Hour 1, foundations    | app-server owns auth; isolated home; exact protocol/version; physical executable resolver           |
| Hours 2–3, core        | assistant thread versus bounded task thread; app mentions; approval IDs; local voice event contract |
| Hours 4–5, integration | login/mic/app permission order; folder scope; cross-tool data policy; crash/restart behavior        |
| Hour 6+, polish        | latency budgets, compact layout, signing/update gates, clean-profile and real-account evidence      |

### Review sections

1. **Architecture:** The provider-neutral Mission/Policy/Approval/Receipt layer prevents
   app-server from becoming the product model. No new cloud service is introduced.
2. **Errors:** The named error/rescue registry covers process, protocol, account, app,
   turn, approval, voice, persistence, and release failures. Catch-all swallowing is
   removed from production boundaries.
3. **Security:** Threat coverage now includes cross-tool prompt injection, retrieved
   data provenance, credential-page prohibition, the unshipped retention/deletion controls,
   unsafe links, and strict IPC validation.
4. **Data/interaction:** Auth, talk, app, task, approval, reset, double-submit,
   navigation/quit, timeout, stale approval, empty transcript, and offline paths are
   explicit and testable.
5. **Code quality:** One executable resolver, one protocol client, one permission
   decision type, and one voice-provider contract replace duplicated/private paths.
6. **Tests:** The plan maps unit, fake-child integration, Electron E2E, and real manual
   release checks. Real external-contract spikes now occur before the rewrite.
7. **Performance:** Budgets are four seconds local voice end-to-end, sub-100ms control
   feedback, bounded protocol lines/event history, lazy app pagination, and no duplicate
   app-server process.
8. **Observability:** Structured local redacted events carry correlation IDs. No exportable
   diagnostic bundle ships in 0.2; a future bundle must omit tokens, transcript content, and app
   results. Analytics remain explicit opt-in.
9. **Deployment:** Exact dependency pin, package matrix, signed/notarized trusted lane,
   update/compatibility state, draft-first publishing, and yank/fix-forward procedure are
   required.
10. **Long-term:** Reversibility is 4/5 because providers sit behind adapters and routines
    use Jarvis-owned models. Native macOS speech and Electron remain platform debt.
11. **Design:** The core remains the visual anchor; user state/action precedes developer
    status; approvals and receipts reuse the reference overlay rather than generic cards.

### CEO dual voices

| Dimension            | Independent subagent         | Codex outside voice               | Consensus           |
| -------------------- | ---------------------------- | --------------------------------- | ------------------- |
| Premises valid       | concern                      | concern                           | confirmed           |
| Right problem        | needs recurring wedge        | needs one customer/job            | confirmed           |
| Scope calibration    | too broad pre-validation     | several products in one release   | confirmed challenge |
| Alternatives         | too architecture-focused     | missing single-wedge alternatives | confirmed           |
| Competitive risk     | first parties own primitives | wrapper in platform line of fire  | confirmed           |
| Six-month trajectory | no retention/update moat     | no owned layer or metrics         | confirmed           |

User challenge: both voices recommended removing either apps or Codex. The explicit user
direction is to build both and not pause for questions, so the original scope stands.
The plan absorbs the valid concern through one hero daily mission, a provider-neutral
trust model, design-partner metrics, and preflight kill gates.

### CEO completion summary

```text
Mode: selective expansion
System audit: current release claims are ahead of evidence
Strategy issues: 9, all addressed in plan or explicitly deferred
Critical gaps before edits: recurring job, credential truth, contract proof, metrics
Security: cross-tool exfiltration and retention added
Tests: real-contract spikes moved before implementation
Reversibility: 4/5
Unresolved user decisions: 0, explicit “go/no questions” preserves original scope
```

**Phase 1 status:** complete. Six of six dual-voice dimensions confirmed the strategic
risks; one scope-reduction challenge was declined by the existing user directive.

## Autoplan Phase 2: design review

The gstack mockup binary was unavailable, so the review used the running packaged app,
the `jarvis-hud-1.0.1` reference, the prior independent UX audit, and a fresh Codex
design review. No new generic visual direction replaces the supplied GraphCore design.

### Design scores

| Dimension                | Before | After plan fixes | Evidence added                                                     |
| ------------------------ | -----: | ---------------: | ------------------------------------------------------------------ |
| Information architecture |   4/10 |             9/10 | mission is content anchor; fixed reading order                     |
| Interaction states       |   6/10 |             9/10 | concurrency, stop, fallback, persistence, partial result behavior  |
| User journey             |   4/10 |             9/10 | canonical first-run-to-tomorrow sequence                           |
| AI-slop avoidance        |   6/10 |             9/10 | reference-specific rails/core/callouts; no dashboard-card mosaic   |
| Design-system alignment  |   6/10 |             9/10 | type, spacing, layout, overlay, motion, component rules            |
| Responsive/accessibility |   5/10 |             9/10 | two compositions, minimum size, focus/live-region/zoom behavior    |
| Decision completeness    |   3/10 |             9/10 | mission, priorities, approvals, receipts, history, privacy defined |

### Design dual voices

| Dimension                | Independent UX audit                   | Codex design voice                         | Consensus                                    |
| ------------------------ | -------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| GraphCore identity       | keep orb/rails/callouts                | orb risks eclipsing work                   | taste: visual anchor, mission content anchor |
| Information hierarchy    | developer plumbing blocks product      | system capabilities precede founder’s day  | confirmed                                    |
| Interaction states       | auth/voice/app/task states missing     | states named but transitions underdesigned | confirmed                                    |
| User journey             | onboarding should end at ready talk    | should end at useful brief                 | confirmed, useful brief adopted              |
| Specificity              | approval/receipt overlays need anatomy | generic progress/drawer/receipt terms      | confirmed                                    |
| Responsive/accessibility | hard 1440×900, tiny type, focus gaps   | one-breakpoint drawers are incomplete      | confirmed                                    |
| Trust/privacy            | approvals and masked identity needed   | privacy model not visible in interface     | confirmed                                    |

### Seven-pass result

1. **Information architecture:** Fixed by promoting Today’s Mission, pending decisions,
   provenance, and result above capability status while preserving the core visually.
2. **State coverage:** Fixed presentation, interruption, persistence, fallback, stop,
   stale approval, and partial-success behavior beyond the original label matrix.
3. **Journey:** Fixed with a canonical source-check-to-tomorrow storyboard and a useful
   first-run outcome.
4. **AI-slop:** The interface remains a calm, asymmetric HUD with scrims and hairline
   callouts, not a card grid, glowing SaaS dashboard, or decorative icon system.
5. **Design system:** Fixed concrete type roles, spatial tokens, rail widths, overlay
   sizing, motion curves, and interactive-state expectations. A project `DESIGN.md`
   will be extracted from these rules during implementation.
6. **Responsive/accessibility:** Fixed desktop/compact compositions, minimum window,
   200% zoom, keyboard order, live-region restraint, reduced motion, and long content.
7. **Decisions:** Fixed mission/receipt schemas, priority controls, approval grouping,
   concurrent talk/work, and conversation-versus-mission history.

Design taste decision: keep the supplied orb as the memorable visual protagonist while
making Today’s Mission the semantic and reading-order protagonist. This preserves the
user’s design reference without shipping a developer console.

### Design completion summary

```text
Initial design score: 5/10
Final plan score: 9/10
Decisions added: 18
Unresolved implementation decisions: 0
Mockups: unavailable; running app and local HUD reference used
Post-implementation requirement: live design review at 1440×900 and 1120×720
```

**Phase 2 status:** complete. Six of seven dimensions were shared concerns; the sole
taste split, orb versus mission prominence, is resolved as visual versus semantic roles.

## Autoplan Phase 3: engineering review

Two adversarial engineering voices independently reached the same P0 conclusion: the
original plan described approvals and receipts as reassuring UI but did not yet define a
crash-safe authority boundary. The plan now treats the host execution protocol as the
foundation and blocks broad UI work until its invariants and bundled-binary contract pass.

### Engineering scorecard

| Area         | Before  | After plan fixes | Release evidence required                                           |
| ------------ | ------- | ---------------- | ------------------------------------------------------------------- |
| Architecture | concern | pass in plan     | policy/approval/ledger state-machine tests                          |
| Tests        | concern | pass in plan     | unit, property, fuzz, fake-child, packaged conformance, E2E         |
| Performance  | concern | pass in plan     | cold/warm p50/p95 plus frame/CPU/memory measurements                |
| Security     | concern | pass in plan     | sandboxed renderer, narrow IPC, URL/permission gates, static checks |
| Error paths  | concern | pass in plan     | crash checkpoints, unknown outcome, account/lifecycle matrix        |
| Deployment   | concern | pass in plan     | two-architecture trusted package and install verification           |

### Engineering dual voices

| Dimension              | Independent subagent                               | Codex outside voice                    | Consensus and fix                                     |
| ---------------------- | -------------------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| Approval authority     | app-server request insufficient                    | policy has no enforceable architecture | main-process default-deny PolicyEngine                |
| Crash consistency      | restart can duplicate writes                       | exactly-once/unknown outcome absent    | transactional ledger; no blind mutation retry         |
| Receipt trust          | model output can claim success                     | evidence source undefined              | host assembly from structured events + verifier       |
| Renderer boundary      | generic IPC/preload unsafe                         | sandbox promise contradicts code       | narrow typed IPC; sandbox; deny navigation            |
| Protocol compatibility | exact pin and generated schema needed              | pin asserted, not operational          | exact packages, hashes, release resolver, conformance |
| Lifecycle              | process epoch and old approval invalidation absent | quit/sleep/account changes absent      | epochs, circuit breaker, explicit transitions         |
| Tests                  | Friday-2am crash path absent                       | crash/fuzz/property/real writes absent | expanded test matrix and durable test plan            |
| Deployment             | native helper/signing underplanned                 | rollback ineffective; x64 missing      | per-arch builds; manual-update truth; fix-forward     |

### Execution sequencing

1. Establish exact pinned executable/protocol conformance and generated types.
2. Establish sandboxed renderer, narrow IPC, URL policy, and permission defaults.
3. Establish transactional ledger, policy, immutable approvals, coordinator, and receipt
   invariants with crash/property tests.
4. Migrate account, read-only conversation, and app discovery to app-server.
5. Keep connected-app writes disabled; validate the bounded approved Codex workspace-mutation and
   reconciliation path.
6. Add native local voice and the canonical onboarding/daily-mission UI.
7. Delete the legacy kill list, then run packaging, live UX, and release loops.

### Engineering completion summary

```text
Initial engineering score: HOLD (6/6 concerns)
P0 gaps found: policy authority, crash-safe writes, evidence-backed receipts
Plan fixes added: 31
Test classes added: crash, property, fuzz, lifecycle, migration, packaged conformance
Deployment truth: manual updates in 0.2; no remote rollback
Implementation gate: foundation invariants before broad UI
Unresolved implementation decisions: 0
```

**Phase 3 status:** complete. Both voices confirmed all six concern areas and converged
on the same foundation. No engineering challenge was declined.

## Cross-phase synthesis

- CEO and engineering reviews both objected to provider lock-in. The answer is one owned
  daily mission plus provider-neutral policy/action/receipt records, not another wrapper.
- Design and security both require approval context to be legible. The overlay is therefore
  both the visual trust moment and a projection of immutable host state, never the owner.
- CEO retention depends on useful daily results; engineering trust depends on verifiable
  results. The receipt is the shared product artifact and primary success metric.
- The visual GraphCore may remain expressive only inside explicit performance and reduced-
  motion gates. It cannot delay first useful state or monopolize the reading order.
- The one-login promise is limited honestly: ChatGPT powers Codex and available apps;
  pinned ChatGPT Realtime supplies zero-key LIVE voice; local PTT is the automatic fallback.

## Decision audit trail

|   # | Phase  | Decision                                         | Why                                             | Alternative rejected                         |
| --: | ------ | ------------------------------------------------ | ----------------------------------------------- | -------------------------------------------- |
|   1 | CEO    | support technical founders/builders first        | concrete repeatable job                         | generic assistant for everyone               |
|   2 | CEO    | daily operating mission is activation loop       | creates retention hypothesis                    | capability dashboard                         |
|   3 | CEO    | keep both apps and Codex                         | explicit product direction                      | scope reduction                              |
|   4 | CEO    | app-server owns ChatGPT credentials              | supported boundary, fewer secrets               | copied OAuth/private APIs                    |
|   5 | CEO    | ChatGPT LIVE is default voice for this exact pin | works after one login without token copying     | Platform-key setup                           |
|   6 | CEO    | native PTT is automatic fallback                 | resilient and permission-bounded                | fail onboarding when Realtime is unavailable |
|   7 | CEO    | first-party app directory before Composio        | one-login distribution                          | per-install developer secret                 |
|   8 | CEO    | provider-neutral mission/policy/receipt          | durable owned layer                             | provider objects as product DB               |
|   9 | Design | orb visual anchor, mission semantic anchor       | preserves reference and utility                 | remove orb or center only telemetry          |
|  10 | Design | fixed daily-mission storyboard                   | complete first useful journey                   | land only at ready state                     |
|  11 | Design | approvals/receipts reuse report overlay          | coherent trust moment                           | generic modal/card grid                      |
|  12 | Design | 1120×720 minimum plus compact composition        | explicit desktop support                        | clipped 1440-only UI                         |
|  13 | Design | no autoplay greeting                             | privacy and user agency                         | surprise microphone/audio                    |
|  14 | Eng    | Electron main is enforcement boundary            | renderer/upstream are untrusted                 | display upstream approvals only              |
|  15 | Eng    | default-deny host policy                         | stable capability authority                     | rely on upstream classification              |
|  16 | Eng    | immutable single-use approval digest             | prevents mutation/replay                        | model/renderer confirmation flag             |
|  17 | Eng    | transactional action ledger                      | crash consistency                               | JSONL-only receipts                          |
|  18 | Eng    | `unknown_outcome` terminal                       | honest post-dispatch uncertainty                | retry or report failure                      |
|  19 | Eng    | host-assembled verified receipts                 | evidence cannot be model prose                  | prompt-parsed success JSON                   |
|  20 | Eng    | one executing workspace-mutation lane            | avoids cross-tool races                         | parallel mutations                           |
|  21 | Eng    | exact Codex pin/schema/binary hash               | release contract is reproducible                | caret range and PATH fallback                |
|  22 | Eng    | isolated minimal CODEX_HOME/env                  | account and secret isolation                    | inherit global profile/env                   |
|  23 | Eng    | sandbox + narrow IPC + URL policy                | compromised-renderer containment                | generic electron bridge                      |
|  24 | Eng    | separate arm64/x64 native builds                 | architecture-correct artifacts                  | unsafe cross-build assumption                |
|  25 | Eng    | manual-update truth for 0.2                      | no updater exists                               | claim GitHub yank is rollback                |
|  26 | Eng    | delete legacy paths before release               | no silent unsafe fallback                       | indefinitely retain feature flag             |
|  27 | Eng    | host-owned bounded workspace tools               | removes ambient Codex filesystem/process access | provider-local shell and patch tools         |
|  28 | Eng    | split session authority from receipt identity    | relaunch recovery without stale live grants     | random session ID as durable partition       |
|  29 | Eng    | one desktop ledger owner                         | prevents cross-process false recovery           | concurrent Jarvis processes                  |

## Acceptance loop

For each pass, select one confirmed ledger gap, make one reversible change, add or
update its regression test, and rerun the smallest relevant check. A release candidate
must then pass, from a clean checkout:

```text
format check → lint → typecheck → unit/integration tests → renderer build
→ Electron E2E → arm64/x64 package → archive validation → copied-install smoke
→ clean-profile UX checklist → real-account manual checklist → four-app-asset inventory
```

Checksum, SBOM/license, protocol/binary-hash, and signed-manifest release gates are not implemented
yet; they cannot be counted as evidence for the current four-asset draft workflow.

Stop only at a fully evidenced pass, an approval boundary, a repeated external blocker,
or no measurable progress. Never weaken a gate to make the loop green.

## GSTACK REVIEW REPORT

| Review        | Trigger                    | Why                           | Runs | Status   | Findings                                                             |
| ------------- | -------------------------- | ----------------------------- | ---- | -------- | -------------------------------------------------------------------- |
| CEO Review    | `/plan-ceo-review`         | Scope and product contract    | 2    | complete | recurring wedge, false credential premise, provider risk             |
| Codex Review  | independent outside voices | Strategy, design, engineering | 3    | complete | confirmed all material concerns; exact fixes incorporated            |
| Eng Review    | `/plan-eng-review`         | Architecture and tests        | 2    | complete | host policy, action ledger, crash consistency, package conformance   |
| Design Review | `/plan-design-review`      | UX and interaction states     | 2    | complete | mission hierarchy, interaction anatomy, compact/accessibility states |
