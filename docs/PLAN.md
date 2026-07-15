# Jarvis architecture and UX plan

The detailed reviewed plan and decision audit live in [RELEASE_PLAN.md](RELEASE_PLAN.md). This is
the compact implementation map.

## Journey

```text
Download trusted DMG
  → Continue with ChatGPT
  → system-browser OAuth owned by bundled Codex app-server
  → HUD checks account and ChatGPT Apps
  → Engage requests microphone permission and starts ChatGPT-authenticated WebRTC
  → hold Space → live transcript + remote audio
  → if LIVE cannot start, automatic native speech → app-server → native TTS fallback
  → optionally choose a project folder and dispatch bounded Codex work from the panel or by asking Jarvis
  → one-shot approval for each eligible mutation → host receipt
```

## Trust boundaries

1. **Renderer:** presentation only. Sandboxed, no Node, no navigation or popup authority, narrow
   typed preload calls.
2. **Electron main:** owns URL policy, folder capabilities, action policy, approval binding,
   durable state, helper lifecycles, stable receipt partitioning, and receipts. The provider
   account/session capability remains short-lived and rotates independently.
3. **Codex app-server:** pinned local dependency, isolated home, minimal inherited environment,
   allowlisted protocol. It owns ChatGPT login and model/app interaction.
4. **Native speech helper:** bounded newline JSON; permission, PTT transcription, and TTS only.
   No URL, path, shell, token, or generic execution command exists.
5. **Native workspace helper:** no network, shell, or entitlement surface. It accepts one bounded
   approved text mutation and binds root, parent, target, preimage, and postcondition through
   descriptor-relative filesystem operations.
6. **External services:** OpenAI and user-selected ChatGPT Apps. Their content is untrusted data.

## Product lanes

- **Assistant lane:** authority-free app-server thread; short voice answers and source-aware briefs.
  It may call one host-owned `jarvis_codex.dispatch_task` tool with prompt text only. Main supplies
  the current account-bound folder capability to the separate task lane; no path, scope ID,
  filesystem, shell, or network authority enters the assistant thread. A one-shot host approval
  shows the exact prompt and folder before an assistant-originated dispatch; direct panel Run is
  already explicit user intent.
- **Apps lane:** app-server `app/list` plus browser connection URLs; no publisher secret.
- **Task lane:** one selected folder, no app-server environments or ambient local tools, finite
  wall clock, and a host-owned list/read/literal-search/write namespace. Text writes are bounded,
  sensitive paths and link escapes are denied, and each exact write needs local approval,
  descriptor-relative native execution, and postcondition verification. There is no shell,
  process, network, delete, or move capability.
- **Computer lane:** one structured dynamic tool, three fixed macOS system apps, one-time local
  approval, fixed executable/argv, and exact bundle/path post-verification. No renderer computer
  IPC or arbitrary model-supplied name/path/URL exists.
- **LIVE lane:** default ChatGPT-authenticated WebRTC through the exact pinned experimental
  app-server contract. Main owns session policy and SDP correlation; renderer owns media only.
- **LOCAL lane:** automatic native macOS speech/app-server/TTS fallback with the same identity and
  read-only app policy.

## Action invariant

```text
intent → policy → approved → dispatched → observed → verified
                                      ↘ unknown_outcome
```

Only `verified` may produce a success receipt. Logout, cancellation, process exit, generation
change, workspace identity change, approval expiry, and failed read-back invalidate authority.
The rotating session capability protects live authority; a separate install-local HMAC partition,
whose key is protected by macOS safe storage, recovers receipts for supported personal accounts
without persisting an email address. Ambiguous workspace accounts fail closed for mutations.

## Release path

CI produces evidence and an ad-hoc package for layout testing. The manually dispatched trusted
workflow builds arm64 and x64 separately, signs nested binaries before the app, enables hardened
runtime, notarizes, verifies every artifact, then creates an exact 11-asset **draft** GitHub
release. The draft binds four installers, two native verification records, an SBOM, normalized
licenses, third-party notices, a release manifest, checksums, and the public release metadata. A
separate protected promotion re-downloads the immutable draft contract and publishes only if every
byte and release precondition still matches. Publication remains a human release decision.
