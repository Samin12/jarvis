<div align="center">

# JARVIS

**Sign in with ChatGPT. Talk to it. It gets things done.**

A Jarvis-style voice assistant for your Mac. Download it, sign in with the ChatGPT
account you already have — no API keys to paste — and start talking. It answers in a
live voice, shows the conversation in a heads-up display, connects to your Gmail and
Calendar with one click, and hands real work to Codex.

</div>

---

## Download & run (60 seconds)

1. Grab the latest **`Jarvis-x.y.z-arm64.dmg`** from the [Releases page](https://github.com/Samin12/jarvis/releases) (Apple Silicon).
2. Open the `.dmg` and drag **Jarvis** into Applications.
3. First launch: because the app isn't notarized by Apple yet, macOS shows a warning.
   **Right-click the app → Open → Open** (only needed once). Or run:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Jarvis.app
   ```
4. Click **Sign in with ChatGPT**. Your browser opens, you approve, the window comes
   alive. That's it — you're in.

Then hold **Space** and say _"Good morning, Jarvis."_

## What it does

|                           |                                                                                                                                                                                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Login with ChatGPT**    | Uses your existing ChatGPT plan via the same OAuth flow the Codex CLI uses. If you've already run `codex login`, Jarvis signs you in instantly. No API key required to start.                                                                                           |
| **Live voice**            | Full-duplex conversation over the OpenAI Realtime API, rendered as a reactor-core orb that reacts as it listens and speaks, with an aside transcript panel.                                                                                                             |
| **Connectors — Composio** | A dedicated Composio section with one-click OAuth cards for Gmail, Google Calendar and more. Once connected, Jarvis reads and acts on them mid-conversation ("any new email from Sam?", "what's on my calendar?"). Send-type actions ask you to confirm out loud first. |
| **Codex hands**           | Give it a task — "organize my Downloads", "fix the failing test in that repo" — and Jarvis dispatches OpenAI Codex (same ChatGPT login), streams progress into the HUD, and speaks the result when it's done.                                                           |

## Two tiers of voice

Jarvis works with **zero setup** on the no-key lane: it chats over your ChatGPT token
and speaks replies with a native macOS voice. For full-duplex **live** voice (barge-in,
natural turn-taking) the OpenAI Realtime API needs a Platform API key — a ChatGPT login
alone can't reach it. Jarvis finds one automatically in this order:

1. `OPENAI_API_KEY` already written by `codex login` in `~/.codex/auth.json`
2. A key minted by the token-exchange during sign-in (works for accounts with Platform access)
3. `OPENAI_API_KEY` in your environment
4. A key you paste into **Settings** (stored encrypted in the macOS Keychain)

No key on any rung → Jarvis stays on the no-key lane and tells you so. Nothing breaks.

## Connectors setup (one time)

The Composio section lights up once you add a Composio project key. Gmail works with zero
Google setup; Google Calendar needs your own Google OAuth client (Google's rule, not ours).
Full walkthrough: **[docs/CONNECTORS.md](docs/CONNECTORS.md)**.

## Develop

```bash
npm install
npm run dev          # launches the Electron app with hot reload
npm run typecheck    # tsc, both main and renderer
npm run build:mac    # produces dist/*.dmg and dist/*.zip
```

Architecture, the five decisions that shaped it, and the verified research corpus live in
**[docs/PLAN.md](docs/PLAN.md)** and **[docs/research/](docs/research/)**.

- **Main process** (`src/main/services/`): OAuth (`auth`), voice key + Realtime session
  minting + no-key chat lane (`voice`), Composio (`connectors`), Codex bridge (`codex`),
  settings. Secrets never leave the main process.
- **Renderer** (`src/renderer/src/`): the HUD orb (`components/hud/GraphCore.tsx`, three.js),
  feature panels (`features/*`), and a typed `window.jarvis` bridge (`src/preload`).
- **Contracts** (`src/shared/`): one source of truth for IPC channels and payload types.

## Security notes

Tokens live in the macOS Keychain (Electron `safeStorage`) and, so the bundled Codex CLI
shares your session, a `0600` mirror at `~/.codex/auth.json`. The Composio project key is
fine for personal use but must move behind a relay before public distribution — see
[docs/CONNECTORS.md](docs/CONNECTORS.md). Send-email / create-event tools require a spoken
confirmation. Codex runs sandboxed to the working directory unless you explicitly ask for
full access.

## Credits

HUD design language derived from the local `jarvis-hud` reference. "Sign in with ChatGPT"
follows the OAuth flow used by the OpenAI Codex CLI and the opencoredev/login-with-chatgpt project.
