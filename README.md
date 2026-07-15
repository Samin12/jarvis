<div align="center">

# JARVIS

**Sign in with ChatGPT. Hold Space. Say “Good morning, Jarvis.”**

A private, voice-first macOS assistant powered by the ChatGPT account you already use.

</div>

## The one-time setup

1. Download the DMG for your Mac from [GitHub Releases](https://github.com/Samin12/jarvis/releases).
2. Drag Jarvis to Applications and open it.
3. Click **Continue with ChatGPT**. Jarvis opens the official sign-in page in your browser.
4. Return to Jarvis and click **Engage**. The first time, macOS asks for microphone access.
5. Hold **Space**, speak, then release. Jarvis answers over its live audio channel. If that
   experimental channel is unavailable, Jarvis switches to native macOS speech automatically.

There is no API key, connector key, terminal command, or config file in the default journey.

> Only install an artifact whose release notes say it passed Developer ID signing and Apple
> notarization. Development builds are ad-hoc signed and are not end-user releases.

## What is in the 0.2 beta

- **ChatGPT sign-in:** the bundled, pinned Codex app-server owns OAuth and its isolated local
  session. Jarvis uses the session but never copies access or refresh tokens into the renderer.
- **ChatGPT LIVE by default:** the renderer creates only a WebRTC microphone/remote-audio peer.
  The pinned app-server uses the same isolated ChatGPT session to establish the Realtime sideband,
  own instructions, and keep account credentials out of the renderer. No Platform API key is
  requested or copied.
- **Automatic LOCAL fallback:** if the pinned experimental Realtime contract, network, entitlement,
  or microphone path is unavailable, native macOS push-to-talk recognition and TTS wrap the same
  app-server conversation thread. Speech Recognition permission is requested only when needed.
- **ChatGPT Apps:** Gmail, Calendar, GitHub, and other apps available to the signed-in account
  appear in the HUD. Connection pages open in the system browser. The assistant lane is
  read-only in this beta.
- **Bounded Codex work:** choose one project folder, then describe a task in the Codex panel or ask
  Jarvis by voice or typed conversation to send it to Codex. The assistant tool accepts only the
  task prompt; the host injects the current folder and reports dispatch without claiming
  completion. Because connected-app text is untrusted, every assistant-originated handoff first
  shows a one-time local approval with the complete prompt and selected folder. Review each proposed
  text-file mutation. Workspace authority is an opaque, account-bound capability minted by the
  native folder picker—not a renderer-supplied path. Codex receives no shell, process, network,
  or ambient filesystem tool; Jarvis supplies only bounded list/read/literal-search/write
  operations for that folder.
- **Tiny verified computer lane:** voice or typed requests may ask to open Calculator, Calendar,
  or Notes. Jarvis shows a one-time local approval, launches only a compile-time fixed system-app
  path, and verifies the exact bundle before reporting success. Arbitrary apps and arguments are
  rejected.
- **Receipts and uncertainty:** actions progress through intent, approval, dispatch,
  observation, and verification. Jarvis reports `OUTCOME UNKNOWN` instead of inventing success
  when a host-side postcondition cannot be proven. Personal ChatGPT accounts recover their own
  receipts across relaunches through an install-local HMAC partition whose random key is protected
  by macOS safe storage. The receipt database itself is plaintext mode-0600 SQLite. Accounts for
  which the pinned Codex build exposes no unambiguous identity can still talk and use read-only
  Apps, but the folder chooser and durable task controls explain that verified actions are
  unavailable and fail closed.

Jarvis 0.2 does **not** provide always-listening wake words, broad computer control, background
email/calendar writes, or a bundled Composio developer credential. Those require a larger
permission and hosted-service contract; see [TODOS.md](TODOS.md).

## Voice modes

| Mode      | Setup                                        | Transport                                                   | Interaction        |
| --------- | -------------------------------------------- | ----------------------------------------------------------- | ------------------ |
| **LIVE**  | ChatGPT sign-in + microphone permission      | renderer WebRTC ↔ pinned Codex app-server Realtime sideband | Hold Space or type |
| **LOCAL** | Automatic fallback + macOS Speech permission | macOS Speech → pinned Codex app-server → macOS TTS          | Hold Space or type |

The renderer is never given a ChatGPT token, generic app-server RPC, shell, filesystem,
credential, or connector executor. The app-server owns Realtime session policy and ChatGPT Apps;
external writes are disabled, and approved workspace mutations go through the host-owned Codex
task lane. Jarvis also enforces one running desktop instance, so two launches cannot share or
mis-recover one live action ledger.

## Develop and verify

Requirements: macOS 13+, Node 22, Swift 5.10+, Xcode command-line tools.

```bash
npm ci
npm run build:native:mac
npm run dev
```

Run the same gates as CI:

```bash
npm run verify:ci
npm run build:unpack:mac
npm run verify:package:dev
```

Create local ad-hoc artifacts with `npm run build:mac`. A trusted public build uses
`electron-builder.release.yml` and intentionally refuses to run without Apple signing and
notarization secrets.

Pull requests build native ad-hoc previews on both Apple silicon and Intel GitHub runners. A
trusted release is a separate, maintainer-approved path: its 11 immutable assets include the four
installers, per-architecture verification records, a CycloneDX SBOM, normalized license inventory,
third-party notices, a release manifest, and `SHA256SUMS`.

## Architecture

- `src/main/services/appServer/` resolves and verifies physical Codex `0.144.3`, starts it with
  an allowlisted environment and isolated `CODEX_HOME`, and exposes a small typed protocol.
- `src/main/services/core/` owns ChatGPT identity, read-only conversations, ChatGPT Apps, and the
  pinned experimental Realtime lifecycle/SDP exchange.
- `src/main/services/actions/` owns policy, one-shot approvals, durable action state, and
  receipts.
- `src/main/services/tasks/` owns selected-folder Codex tasks plus the only task-visible
  filesystem namespace: bounded host list/read/search/write operations with identity checks,
  sensitive-path denials, one-shot write approval, descriptor-relative native mutation, and exact
  postcondition verification.
- `src/main/services/computer/` owns the three-entry macOS app catalog, fixed-argv launch,
  one-shot approval binding, and bundle/path post-verification.
- `native/macos-speech/` builds two narrow helpers: bounded NDJSON Swift speech for permissions,
  PTT transcription, and TTS; and a no-entitlement C workspace writer that binds the selected
  root, parent, and target by file descriptor before applying one approved text mutation.
- `scripts/legal-notices.mjs` assembles and verifies the packaged third-party license tree;
  `scripts/release-receipts.mjs` binds every trusted-release asset and its public metadata.
- `src/preload/` is the only renderer bridge. Electron runs with sandboxing, context isolation,
  no Node integration, denied navigation/popups, and audio-only media permission handling.

The reviewed product and engineering contract is in [docs/RELEASE_PLAN.md](docs/RELEASE_PLAN.md),
with the compact [goal](docs/GOAL.md), [implementation plan](docs/PLAN.md),
[connected-app guide](docs/CONNECTORS.md), [interface system](docs/DESIGN.md), and current
[QA evidence](docs/QA_REPORT.md) alongside it. Deferred work is in [TODOS.md](TODOS.md), and the
active conformance loop is recorded in [LOOPS.md](LOOPS.md). Historical protocol and product
research is indexed by the [gap check](docs/research/gap-check.md).

## Security reporting

Do not attach auth files, API keys, action databases, or logs containing private app content to
a public issue. Open a minimal issue describing the affected version and contact the maintainer
privately for a secure handoff path.

## Credits

The visual language adapts the bundled Jarvis HUD reference. ChatGPT authentication and Codex
execution use OpenAI's pinned Codex app-server rather than a copied community OAuth server.
