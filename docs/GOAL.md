# Jarvis — Build Goal & Loop State

## Mission
Ship a downloadable desktop app ("Jarvis") with a one-time, zero-config user experience:

1. **Download** — GitHub repo (Samin12) with a release zip/DMG; user downloads and opens it.
2. **Login with ChatGPT** — OAuth PKCE flow (same flow Codex CLI / opencoredev/login-with-chatgpt use against auth.openai.com). Token stored locally; that identity powers everything.
3. **Talk** — "Good morning Jarvis" starts a live voice session (GPT Live / OpenAI Realtime, WebRTC) rendered in a jarvis-hud-style orb HUD with an aside conversation panel.
4. **Connect apps** — one-click OAuth connectors (Gmail, Google Calendar via Composio); Jarvis uses them mid-conversation as tools.
5. **Do work** — Codex integration: Jarvis can hand tasks to Codex CLI (already authed via the same ChatGPT login) to run agentic/computer tasks; results spoken back.

## Design reference
`/Users/saminyasar/Jarvis gpt/jarvis-hud-1.0.1` — orb cores, boot-stagger panels, HUD typography. Reuse the aesthetic, not the local-whisper/claude-runner architecture.

## Phases
- [x] P1 Research (OAuth flow, GPT Live/Realtime, Composio, Codex programmatic use, loopy, design spec)
- [x] P2 Architecture + UX plan written (PLAN.md)
- [x] P3 Scaffold app (Electron + Vite/React; repo at /Users/saminyasar/Jarvis gpt/jarvis)
- [x] P4 Login with ChatGPT working end-to-end (PKCE, token store, refresh)
- [x] P5 Voice: Realtime/GPT Live session + HUD orb + aside transcript panel
- [x] P6 Connectors: Composio Gmail/Calendar one-click OAuth + tool calls from voice
- [x] P7 Codex bridge: dispatch tasks to codex CLI, stream results into HUD + speech
- [ ] P8 Package: buildable zip/DMG, GitHub repo pushed, release published
- [ ] P9 Verify end-to-end UX; README + onboarding polish

## Loop protocol
Self-paced /loop (dynamic). Each wake: read this file, check running workflows/tasks, advance the lowest unchecked phase, update checkboxes, re-arm wakeup. Stop when all phases checked.

## User directives (added mid-loop, 2026-07-13)
- **Git discipline**: app repo at `/Users/saminyasar/Jarvis gpt/jarvis` (init done, branch main). Commit after every meaningful unit of work — each phase, each agent-produced feature. Use multiple agents for implementation (workflow fan-out), each landing committed work.
- **Connectors UI**: the connectors panel must have a dedicated **Composio section** — one-click OAuth cards (Gmail, Google Calendar, and other Composio apps) showing connect state, powered by Composio connected-accounts API.

## Notes
- gh authed as Samin12. Node v24.7.0. Codex CLI binary broken (ENOENT) — reinstall kicked off in background.
- Composio MCP is connected in this session (mcp__240b92e1...) — can be used to configure/test connectors.
- Research output lands in jarvis-build/research/.
