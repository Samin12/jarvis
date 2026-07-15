# Jarvis 0.2 QA evidence

Local QA is green for every non-interactive release gate. A clean profile, a simulated signed-in
HUD, typed LOCAL-lane conversation, an unpacked arm64 app, a ZIP-extracted app, and a read-only
DMG-mounted app all passed without renderer errors or credential-file creation.

## Final local evidence

- `npm run verify:ci` passed release policy, format, lint, typechecks, 184 TypeScript tests across
  17 files, 5 Swift protocol tests, 6 native workspace-helper security groups, a production build,
  and both Electron journeys.
- Coverage passed at 77.59% statements, 74.82% branches, 82.50% functions, and 81.46% lines.
- `npm run verify:package:dev` verified the unpacked arm64 app, pinned Codex 0.144.3, both native helpers, the ASAR credential boundary, architecture, signatures, and per-process entitlements.
- `npm run verify:package:artifacts:dev -- --arch arm64 --dist-dir dist` independently extracted the ZIP and mounted the DMG read-only, verified identical bundle contents, checked all 21 nested Mach-O signatures, scanned for credentials, and launched both copied installs into signed-out onboarding.
- `npm audit`, `npm audit --omit=dev`, and registry signature verification passed with zero known vulnerabilities; all 707 package signatures and 184 available attestations verified.
- A source and changed-patch credential scan found no secrets. All 20 action references in the
  three workflows are pinned to full commit SHAs.
- Package verification includes a deterministic 11-component, 12-file legal tree and fails closed
  on missing, extra, linked, or modified notices.
- A lockfile-only CycloneDX 1.5 SBOM contains 646 components with no missing license fields or
  duplicate component keys.
- GitHub run `29396102874` passed full macOS verification plus native ad-hoc development package
  jobs on `macos-15` (arm64) and `macos-15-intel` (x64).

## Artifact receipts

- `Jarvis-0.2.0-arm64-mac.zip`: 235,381,979 bytes; SHA-256
  `0d167eca59367be798b15c30671a919192a6e43fb3c0407a392e3763108279be`.
- `jarvis-0.2.0-arm64.dmg`: 235,460,013 bytes; SHA-256
  `34fe742390604e77c7e24cc4221765036531f295be36d1bbfcb8905dc79baee7`.
- ZIP/DMG bundle parity SHA-256:
  `4234d6d0296c015adf50160356e511eb9e625eb93fee5ffcd06a9a92e73582b3`.
- Packaged legal receipt SHA-256:
  `4c64d5f72a3949b4970f6f88e6e19ec2ee52effc5b564ec624c1630e973838a6`.
- Speech helper SHA-256: `8556242dc6f638326f1184721664302c1e6cf1b5e941f1fb0e3ae2e5a2b1398e`.
- Workspace helper SHA-256: `07e90cf0ba172f17b825f0978541661ee735527e811c23dd75c691996fc2643f`.

These local artifacts are ad-hoc signed development builds. They are useful for local acceptance,
but they are not presented as trusted public downloads. The hosted x64 preview independently
verified a native Intel build with 21 signed Mach-O files and bundle parity; its installer hashes
remain recorded in the corresponding GitHub job log and verification artifact.

The signed-in test drives the real preload/renderer event contract with synthetic provider data; it does not manufacture or expose a ChatGPT token. It checks that the end-user HUD, Apps, Codex, voice engagement, typed prompt, streamed answer, accessibility roles, and viewport containment work together.

## Pre-landing review

Independent security, correctness, design, engineering, and supply-chain reviews found no remaining P0, P1, or P2 implementation finding. Regressions cover the blockers fixed during review:

1. attacker-controlled executable paths and option operands in the narrow command lane;
2. workspace path/device/inode replacement, symlink retargeting, preimage changes, and hard links;
3. concurrent or replayed assistant-to-Codex dispatch before task reservation;
4. approval sheets that omitted the exact command, prompt, selected folder, or complete file diff;
5. crash recovery that left intent or approved mutations nonterminal;
6. push-to-talk key release after focus moved into the composer;
7. credential-file creation in both the parent and isolated Codex homes;
8. pull-request packaging that skipped the explicit ad-hoc signing identity on GitHub-hosted runners;
9. a third-party-notices archive that was not bound to the legal manifest verified in both apps;
10. a legal-notice rebuild that could replace an unrelated existing directory; and
11. nondeterministic receipt metadata or a failed post-upload check stranding an unreusable draft.

Repository ruleset `18986769` protects `main` from deletion and force-pushes, requires resolved
review threads, and requires strict `macOS verification`, `Development package (arm64)`, and
`Development package (x64)` checks. The protected `release` environment requires maintainer
approval, immutable releases are enabled, and Actions is restricted to SHA-pinned GitHub-owned
actions. A dedicated committed secret-scanner policy remains a maintainer decision; direct source,
patch, and packaged-boundary scans are release gates today.

## Honest external acceptance boundary

Developer ID signing, Apple notarization, trusted arm64/x64 packaging, quarantined Gatekeeper first
launch, real ChatGPT sign-in and completion, live remote audio, real ChatGPT Apps, microphone
consent, and one real approved workspace mutation remain external acceptance gates. Native
development packaging is proven on both GitHub architectures; the trusted gates still require
Apple credentials or interactive user/account consent and are not silently reported as passed.
