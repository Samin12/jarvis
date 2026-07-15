# Jarvis 0.2 release contract

## Outcome

A new user downloads a trusted macOS artifact, signs in once with ChatGPT in the system browser,
returns to a working HUD, clicks Engage, and can hold Space to talk. The same isolated ChatGPT
session powers read-only connected-app answers and bounded Codex tasks in a folder the user
chooses.

## Required evidence

- [x] Pinned physical Codex app-server resolves in development and packaged layouts.
- [x] Fresh isolated profile reaches the ChatGPT onboarding gate.
- [x] The real bundled app-server passes signed-out `account/read`; typed login start/cancel
      behavior passes isolated contract tests.
- [x] Default conversation uses the app-server; no private backend or token-mirroring path remains.
- [x] ChatGPT-authenticated Realtime WebRTC uses the pinned app-server and exposes no account token
      or generic session-control bridge to the renderer.
- [x] Native macOS permission/status/PTT/TTS protocol builds and passes Swift tests.
- [x] ChatGPT Apps list/connect surface uses the signed-in account.
- [x] Codex tasks require a main-process folder capability and bounded runtime; their app-server
      environment has no ambient tools, and all workspace I/O uses host-owned bounded file tools.
- [x] Spoken and typed assistant turns can dispatch a prompt-only Codex task into the current
      host-selected folder without exposing its path/capability or granting assistant authority.
- [x] Assistant/Realtime handoffs can request only three allowlisted system-app launches; each is
      locally approved and host-verified before success.
- [x] Renderer sandbox, narrow IPC, URL allowlists, action policy, approvals, and durable ledger exist.
- [x] Rotating ChatGPT session authority is separate from the install-local durable receipt
      partition; relaunch and cross-account isolation regressions pass for supported personal plans.
- [x] A single-instance lock prevents concurrent desktop processes from sharing one live ledger.
- [x] The local CI workflow definition covers format, lint, types, tests, native protocol, build,
      package layout, and isolated Electron smoke.
- [x] Packaging stages the per-architecture speech and workspace helpers plus pinned Codex binary
      outside ASAR, with microphone entitlement only on the two processes that capture audio.
- [x] Local arm64 DMG/ZIP verification copies both apps to an install location and passes isolated
      signed-out onboarding smoke with byte-identical bundle manifests.
- [x] Repository immutable releases and the protected `release` environment are enabled.
- [ ] The workflow is committed to GitHub and a pull-request run is green.
- [ ] A Developer ID-signed, hardened, notarized arm64 artifact passes strict package verification.
- [ ] A Developer ID-signed, hardened, notarized x64 artifact passes strict package verification.
- [ ] The verified artifacts replace the stale GitHub release and the public download is tested.
- [ ] A real downloaded, Developer ID-signed app is copied out of the DMG/ZIP and passes
      quarantined Gatekeeper first-launch acceptance on both architectures. Development copied
      installs are automated; trusted-release evidence still requires Apple credentials.
- [ ] Packaged UI acceptance covers real ChatGPT completion, Realtime remote audio, automatic
      native fallback, macOS permission prompts, transcription/TTS, ChatGPT Apps, and one approved
      workspace mutation.

Some unchecked items are locally controllable GitHub/install gates. The trusted artifact and real
product-acceptance items also require Apple signing/notarization credentials or interactive account/
microphone consent. None may be silently reported as passed.

The current trusted workflow creates a draft with four application assets only: arm64 DMG/ZIP and
x64 DMG/ZIP. Its GitHub `release` environment requires maintainer approval and allows only `main`
or `v*`; repository immutable releases are enabled, but Apple secrets are not populated yet. It
does not publish checksums, an
SBOM/license inventory, protocol/binary hash assets, or a signed manifest. The local action ledger
is plaintext mode-0600 SQLite; retention, export, delete, and at-rest encryption controls are not
shipped in 0.2.

## Explicit non-goals for 0.2

- Always-listening wake word.
- Broad or unattended computer control.
- Model-authorized writes, confirmation phrases, or session-wide approval grants.
- Shipping publisher OAuth, Composio, OpenAI, or Apple secrets in Electron.
- Copying, exposing, or sending ChatGPT OAuth tokens directly from Jarvis to a Realtime endpoint.
- Silently claiming the pinned experimental Realtime contract is a stable public API.
- Claiming an action succeeded from model prose or provider completion alone.

## Loop

Run the finite conformance loop in [../LOOPS.md](../LOOPS.md) until every locally controllable
item passes. Stop only at a real user/credential boundary, and preserve the failed evidence.
