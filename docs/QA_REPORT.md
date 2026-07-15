# Jarvis 0.2 QA evidence

Local QA is green for every non-interactive release gate. A clean profile, a simulated signed-in HUD, typed LOCAL-lane conversation, an unpacked arm64 app, a ZIP-extracted app, and a read-only DMG-mounted app all passed without renderer errors or credential-file creation.

## Final local evidence

- `npm run verify:ci` passed release policy, format, lint, typechecks, 172 TypeScript tests across 15 files, 5 Swift protocol tests, 6 native workspace-helper security groups, a production build, and both Electron journeys.
- Coverage passed at 77.59% statements, 74.82% branches, 82.50% functions, and 81.46% lines.
- `npm run verify:package:dev` verified the unpacked arm64 app, pinned Codex 0.144.3, both native helpers, the ASAR credential boundary, architecture, signatures, and per-process entitlements.
- `npm run verify:package:artifacts:dev -- --arch arm64 --dist-dir dist` independently extracted the ZIP and mounted the DMG read-only, verified identical bundle contents, checked all 21 nested Mach-O signatures, scanned for credentials, and launched both copied installs into signed-out onboarding.
- `npm audit`, `npm audit --omit=dev`, and registry signature verification passed with zero known vulnerabilities; all 707 package signatures and 184 available attestations verified.
- A source and changed-patch credential scan found no secrets. All 18 third-party action references in the three workflows are pinned to full commit SHAs.

## Artifact receipts

- `Jarvis-0.2.0-arm64-mac.zip`: 233,457,919 bytes; SHA-256 `fe00ae71eeb28f61bc94c2b7ec8e9b680898fa140d64f7b929dd507d0f99eeb2`.
- `jarvis-0.2.0-arm64.dmg`: 233,506,517 bytes; SHA-256 `e1d5ed963c28e4e7f431e1aa72451a9b3df7f77ef02ee94482634c6691d5e535`.
- ZIP/DMG bundle parity SHA-256: `57e173fc71c28e2dc69751ba520107de642932a0b5da033d44211853b5494d2d`.
- Speech helper SHA-256: `8556242dc6f638326f1184721664302c1e6cf1b5e941f1fb0e3ae2e5a2b1398e`.
- Workspace helper SHA-256: `07e90cf0ba172f17b825f0978541661ee735527e811c23dd75c691996fc2643f`.

These local artifacts are ad-hoc signed development builds. They are useful for local acceptance, but they are not presented as trusted public downloads.

The signed-in test drives the real preload/renderer event contract with synthetic provider data; it does not manufacture or expose a ChatGPT token. It checks that the end-user HUD, Apps, Codex, voice engagement, typed prompt, streamed answer, accessibility roles, and viewport containment work together.

## Pre-landing review

Independent security, correctness, design, engineering, and supply-chain reviews found no remaining P0, P1, or P2 implementation finding. Regressions cover the blockers fixed during review:

1. attacker-controlled executable paths and option operands in the narrow command lane;
2. workspace path/device/inode replacement, symlink retargeting, preimage changes, and hard links;
3. concurrent or replayed assistant-to-Codex dispatch before task reservation;
4. approval sheets that omitted the exact command, prompt, selected folder, or complete file diff;
5. crash recovery that left intent or approved mutations nonterminal;
6. push-to-talk key release after focus moved into the composer;
7. credential-file creation in both the parent and isolated Codex homes.

The repository still lacks a branch-protection ruleset and a dedicated committed secret-scanner policy. The pinned CI workflows, direct credential scan, protected release environment, and immutable releases are in place, but repository governance remains a maintainer decision.

## Honest external acceptance boundary

Developer ID signing, Apple notarization, x64 packaging, quarantined Gatekeeper first launch, real ChatGPT sign-in and completion, live remote audio, real ChatGPT Apps, microphone consent, and one real approved workspace mutation remain external acceptance gates. They require Apple credentials, GitHub-hosted macOS runners, or interactive user/account consent and are not silently reported as passed.
