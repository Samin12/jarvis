# Changelog

## 0.2.0 — 2026-07-13

### Added

- One-click system-browser ChatGPT sign-in backed by an isolated, pinned Codex app-server.
- ChatGPT-authenticated Realtime WebRTC voice with native macOS push-to-talk and TTS fallback.
- ChatGPT Apps discovery and browser-based connection for Gmail, Calendar, GitHub, and other apps available to the signed-in account.
- Folder-scoped Codex tasks with host-owned bounded file tools, exact one-time approvals, durable action receipts, and a three-app verified macOS launcher.
- Fresh-profile Electron journeys, Swift protocol tests, coverage gates, package inspection, credential scanning, and signed/notarized release automation.

### Security

- Removed the custom OAuth/token mirror, renderer connector secrets, generic Codex bridge, and API-key voice path.
- Bound account, app, task, approval, workspace, turn, and receipt state to opaque session capabilities and fail-closed lifecycle checks.
- Added crash-atomic terminal receipts, device/inode workspace revalidation, shell-inert command approval parsing, and cross-account UI/event isolation.
- Realtime and fallback teardown now revoke local authority before provider waits and suppress late microphone, speech, transcript, and provider events.
- Task threads have no shell, process, network, image, or ambient filesystem tools; workspace reads and writes are identity-bound to the selected folder, and protected credential paths are denied.
- Approved text writes execute through a package-owned descriptor-relative native helper; stale
  roots, parents, targets, preimages, symlinks, hardlinks, traversal, and protocol overflow fail
  closed with no pathname-mutation fallback.
- Assistant-originated Codex dispatch shows the exact prompt and folder, is bound to the active
  account/turn/generation/workspace, and permits only one pending handoff at a time.
- Durable receipt identity is separated from rotating session authority, and duplicate desktop launches are collapsed into one ledger-owning process.

### Distribution

- Native Apple-silicon and Intel pull-request previews are ad-hoc-signed development artifacts for
  verification only.
- Packaged builds contain a deterministic, fail-closed third-party notice tree for Codex,
  Electron/Chromium, the renderer runtime, and bundled fonts.
- The GitHub release workflow requires native arm64 and x64 runners, Developer ID signing,
  hardened runtime, Apple notarization, stapling, copied-install launch verification, and immutable
  draft evidence before protected publication. Its exact 11-asset receipt binds the four
  installers, native verification records, CycloneDX SBOM, normalized licenses, third-party
  notices, release manifest, checksums, tag, commit, title, and release notes.
- `main` is protected by strict native verification/package checks, release publication requires
  the protected `release` environment, and GitHub Actions accepts only SHA-pinned GitHub-owned
  actions.

## 0.1.0 — legacy

The original unsigned build is retained only as a marked GitHub prerelease. Do not bypass macOS quarantine to run it.
