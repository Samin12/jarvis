# Connected apps

Jarvis 0.2 uses the ChatGPT Apps available to the signed-in account. There is no Composio API key,
Google client secret, or publisher OAuth credential in the desktop binary.

## Connect an app

1. Sign in to Jarvis with ChatGPT.
2. Open **ChatGPT Apps** in the upper-right HUD.
3. Click **Connect** beside an available app.
4. Finish the provider flow in the system browser and return to Jarvis.

Jarvis refreshes the app list after the browser opens. Existing ChatGPT app connections appear as
**connected**. Disconnect or change scopes from ChatGPT's own app settings.

## 0.2 behavior

- The assistant thread may read an enabled app when it is relevant to the request.
- Daily brief copy promises Calendar and inbox only. GitHub may be included when it is connected,
  while repository mutation remains a separate selected-folder Codex task.
- Connected-app content is treated as untrusted data, not instructions.
- LIVE voice can hand a request to the same read-only assistant thread; app credentials and tool
  policy remain in the app-server rather than the WebRTC renderer.
- The assistant lane is read-only. Sending mail, creating events, editing documents, and other
  external mutations are not advertised as shipped.

An optional hosted Composio relay is deferred until it has an owner, authentication boundary,
billing/abuse controls, privacy terms, and production operations. See [../TODOS.md](../TODOS.md).
