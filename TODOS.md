# Deferred work

These are explicitly outside the Jarvis 0.2 downloadable beta contract. They must not
become hidden dependencies or be described as already shipped.

## Hosted provider-independent voice relay

- **Why deferred:** requires a service owner, billing/abuse limits, authentication,
  operational monitoring, privacy terms, production credentials, and a deployment target.
- **Context:** ChatGPT-authenticated LIVE voice is the zero-key default through the exact pinned
  app-server experiment, with native push-to-talk as automatic fallback. No Platform-key adapter
  ships in the default app.
- **Revisit when:** design partners validate the daily mission and full-duplex voice has a
  measured retention advantage worth operating a service for.

## Optional Composio backend

- **Why deferred:** publisher-managed OAuth requires hosted credentials and a user identity
  boundary. Shipping those secrets in Electron is prohibited.
- **Context:** Codex app-server `app/list` supplies the default Gmail, Calendar, GitHub,
  Drive, Notion, Slack, and other app connection experience.
- **Revisit when:** a required toolkit is unavailable in the first-party directory and a
  hosted relay has an owner.

## Signed automatic updater and remote rollback

- **Why deferred:** 0.2 uses manual GitHub Release updates; no update service or signing
  manifest pipeline exists yet.
- **Context:** yanking a release only prevents new installs. Installed clients require an
  incident notice and higher-version fix-forward release.
- **Revisit when:** trusted signing/notarization is operational and the design-partner beta
  is ready for wider distribution.

## Public analytics service

- **Why deferred:** telemetry is opt-in and off by default; no consent, retention, or data
  processing owner is established.
- **Context:** local redacted diagnostics and manual design-partner measurement are enough
  for 0.2.
- **Revisit when:** a published privacy policy and accountable service owner exist.

## Always-listening wake word and broad computer control

- **Why deferred:** substantially expands privacy, accessibility, sandbox, and credential
  risks beyond the bounded push-to-talk/folder-scoped contract.
- **Context:** 0.2 supports explicit talk, approved Codex work in a selected folder, and only the
  tiny compile-time allowlist of one-shot approved system-app launches. Arbitrary apps, URLs,
  scripting, input control, and credential surfaces remain denied.
- **Revisit when:** the policy/approval/receipt foundation has real safety evidence and the
  OS permission UX can be tested with design partners.
