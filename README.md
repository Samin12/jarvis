# Jarvis

A Jarvis-style voice assistant for your desktop. Download it, sign in with your ChatGPT account, and talk.

- **Login with ChatGPT** — your existing ChatGPT plan powers everything; no API keys to paste.
- **Live voice** — say "Good morning, Jarvis" and hold a real conversation (OpenAI Realtime / GPT Live), rendered as a HUD orb with an aside transcript panel.
- **Connectors** — one-click OAuth for your apps. The Composio section connects Gmail, Google Calendar, and more; Jarvis uses them mid-conversation.
- **Codex hands** — hand Jarvis a task ("refactor that repo", "organize my downloads") and it dispatches OpenAI Codex, authenticated by the same ChatGPT login, streaming progress back into the HUD.

## Status

Under active construction. See [docs/GOAL.md](docs/GOAL.md) for the build plan and progress.

## Development

```bash
npm install
npm run dev
```

Design language derives from jarvis-hud (orb cores, boot-stagger panels, terminal typography).
