# Connectors setup (Composio)

Jarvis uses [Composio](https://composio.dev) as its OAuth connector layer: Composio hosts the Google OAuth flows, stores and refreshes tokens, and exposes Gmail/Calendar as tools the voice session can call. You do this setup once as the app owner; after that, connecting an account is a single click in the Connectors panel.

Time required: about 10 minutes for Gmail, plus about an hour the first time for Google Calendar (it needs your own Google Cloud OAuth client — see section 4).

## 1. Create a Composio account and project key

1. Sign up at https://app.composio.dev (free tier: 20,000 tool calls/month — plenty).
2. Open **Project Settings → API Keys** and create a key.
3. Give the key to Jarvis, either way works:
   - **Env var** (takes precedence): launch Jarvis with `COMPOSIO_API_KEY=...` in the environment.
   - **Config file**: create `connectors.json` in the app's user-data directory:
     - dev: `~/Library/Application Support/jarvis/connectors.json`
     - packaged app: `~/Library/Application Support/Jarvis/connectors.json`

```json
{
  "composioApiKey": "YOUR_COMPOSIO_PROJECT_KEY",
  "authConfigs": {
    "GMAIL": "ac_...",
    "GOOGLECALENDAR": "ac_..."
  }
}
```

You will fill in the `ac_...` ids in the next two sections. Auth config ids are not secrets; the API key is — never commit it.

> Distribution note: the Composio project key must NOT ship inside a public build. It can read every user's connected accounts. Personal builds are fine; public distribution requires a thin relay server first (see docs/PLAN.md, security posture).

## 2. How the pieces fit

- **Auth config** (`ac_...`): the per-app OAuth definition for one toolkit (Gmail, Calendar...). Created once by you.
- **Connected account** (`ca_...`): one user's authorized login under an auth config. Created every time someone clicks CONNECT.
- Jarvis identifies you to Composio with your ChatGPT account id, so your Gmail connection stays yours even on a shared Composio project.

## 3. Gmail — managed auth (zero Google Cloud work)

1. Composio dashboard → **Auth Configs → Create Auth Config**.
2. Pick **Gmail**.
3. Choose **"Use Composio managed auth"**.
4. Copy the resulting `ac_...` id into `connectors.json` under `"GMAIL"`.

That's it. Caveats of managed auth (all acceptable for v1):

- The Google consent screen says "Composio", not "Jarvis".
- Quota is shared with other Composio customers; heavy use hits limits sooner.
- Stick to the default scopes — adding non-default scopes to the managed app makes Google block it as unverified.

Restart Jarvis (or just reopen the Connectors panel), then click **CONNECT** on the Gmail card. Your browser opens the Google consent screen; approve it; the card flips to CONNECTED within a few seconds.

## 4. Google Calendar — needs your own Google OAuth client

Composio does not offer managed auth for Google Calendar, so you create a (free) OAuth client in Google Cloud once. Calendar scopes are "sensitive", not "restricted", so there is no expensive CASA assessment — just the standard consent-screen setup.

### 4a. Google Cloud project

1. Go to https://console.cloud.google.com and create a project (e.g. `jarvis-connectors`).
2. **APIs & Services → Library** → search **Google Calendar API** → **Enable**.

### 4b. OAuth consent screen

1. **APIs & Services → OAuth consent screen**.
2. User type: **External**.
3. App name: `Jarvis`, add your support email and developer contact email.
4. Add a privacy-policy URL if you have one (required to publish to Production).
5. Scopes: add `https://www.googleapis.com/auth/calendar.events` and `https://www.googleapis.com/auth/calendar.readonly` (or the broader `.../auth/calendar`).
6. While in **Testing** mode, add your own Google account under **Test users**.

> Important: in Testing mode, Google expires refresh tokens after 7 days — you would have to reconnect Calendar weekly. Once everything works, click **Publish app** to move the consent screen to **Production**; sensitive scopes go through a lightweight brand verification (privacy policy + homepage), after which tokens stop expiring.

### 4c. OAuth client

1. **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application** (yes, web — the redirect target is Composio's server, not the app).
3. Name: `jarvis-composio`.
4. Authorized redirect URI: copy the exact value the Composio dashboard shows when creating the auth config (next step). As of 2026-07 it is:
   `https://backend.composio.dev/api/v3.1/toolkits/auth/callback`
   Older Composio guides show `https://backend.composio.dev/api/v1/auth-apps/add`; whitelisting both is harmless.
5. Create, then copy the **Client ID** and **Client Secret**.

### 4d. Composio auth config

1. Composio dashboard → **Auth Configs → Create Auth Config** → **Google Calendar**.
2. Choose **"Use your own developer credentials"**.
3. Paste the Client ID and Client Secret from 4c. Keep the default scopes (or the two from 4b).
4. Copy the `ac_...` id into `connectors.json` under `"GOOGLECALENDAR"`.

Restart Jarvis and click **CONNECT** on the Google Calendar card.

## 5. Optional extras (GitHub, Notion)

The panel also shows GitHub and Notion cards. Both have Composio-managed auth: create their auth configs the same way as Gmail (managed auth, two clicks) and add the ids to `connectors.json`:

```json
"authConfigs": {
  "GMAIL": "ac_...",
  "GOOGLECALENDAR": "ac_...",
  "GITHUB": "ac_...",
  "NOTION": "ac_..."
}
```

Cards without an auth config id simply show "setup needed" — nothing breaks.

Env-var alternative for any toolkit: `COMPOSIO_AUTH_CONFIG_GMAIL=ac_...`, `COMPOSIO_AUTH_CONFIG_GOOGLECALENDAR=ac_...`, etc. Env values override the file.

## 6. What the voice session can do once connected

Curated tools exposed to the realtime voice session:

| Tool                             | Effect                                                       | Confirmation            |
| -------------------------------- | ------------------------------------------------------------ | ----------------------- |
| `GMAIL_FETCH_EMAILS`             | read recent email (compacted to sender/subject/date/snippet) | no                      |
| `GMAIL_CREATE_EMAIL_DRAFT`       | create a draft                                               | no                      |
| `GMAIL_SEND_EMAIL`               | send email                                                   | **yes — say "confirm"** |
| `GMAIL_REPLY_TO_THREAD`          | reply in a thread                                            | **yes — say "confirm"** |
| `GOOGLECALENDAR_EVENTS_LIST`     | list events                                                  | no                      |
| `GOOGLECALENDAR_FIND_EVENT`      | search events                                                | no                      |
| `GOOGLECALENDAR_FIND_FREE_SLOTS` | find free time                                               | no                      |
| `GOOGLECALENDAR_CREATE_EVENT`    | create an event                                              | **yes — say "confirm"** |

Side-effect tools (send email, create event) never fire on the first call: Jarvis reads the action back and waits for your spoken confirmation before executing.

## 7. Troubleshooting

- **All cards say "setup needed" with a key hint** — Jarvis can't find `COMPOSIO_API_KEY` or a `composioApiKey` in `connectors.json`. Check the file path and JSON syntax.
- **Card stuck on CONNECTING** — the OAuth link expires after ~10 minutes. Click CONNECT again for a fresh link.
- **Calendar card flips back to "reconnect" after a week** — your Google consent screen is still in Testing mode. Publish it to Production (section 4b).
- **Google shows "app is blocked"** — you added non-default scopes to a managed auth config, or the redirect URI in Google Cloud doesn't match the one Composio expects.
- **"Session expired — reconnect"** — access was revoked from your Google account settings. Click CONNECT to re-authorize.
