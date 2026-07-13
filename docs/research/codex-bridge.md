# Driving Codex CLI Programmatically from Jarvis (Electron main process)

Research date: 2026-07-13. Versions verified against npm registry the same day:
`@openai/codex` (CLI) latest = **0.144.3**, `@openai/codex-sdk` latest = **0.144.3** (alpha channel 0.145.0-alpha.7). SDK and CLI version in lockstep.

Primary sources (all fetched, not just skimmed):

- Non-interactive mode docs: https://developers.openai.com/codex/noninteractive (308-redirects to https://learn.chatgpt.com/docs/non-interactive-mode)
- SDK docs: https://developers.openai.com/codex/sdk (redirects to https://learn.chatgpt.com/docs/codex-sdk)
- App server docs: https://developers.openai.com/codex/app-server (redirects to https://learn.chatgpt.com/docs/app-server.md) and repo README https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md
- CLI reference: https://developers.openai.com/codex/cli/reference (learn.chatgpt.com/docs/cli/reference)
- Auth docs: https://developers.openai.com/codex/auth (learn.chatgpt.com/docs/auth)
- Config reference: https://developers.openai.com/codex/config-reference (learn.chatgpt.com/docs/config-file/config-reference)
- Models: https://developers.openai.com/codex/models
- SDK source (read in full): https://github.com/openai/codex/tree/main/sdk/typescript/src — `codex.ts`, `codexOptions.ts`, `thread.ts`, `threadOptions.ts`, `turnOptions.ts`, `events.ts`, `items.ts`, `exec.ts`
- Auth internals (read): `codex-rs/login/src/auth/storage.rs` (AuthDotJson struct), `codex-rs/login/src/token_data.rs`, `codex-rs/login/src/auth/manager.rs`, `codex-rs/login/src/server.rs`
- OpenAI engineering post on the app server: https://openai.com/index/unlocking-the-codex-harness/

---

## 1. The four integration surfaces (and one dead one)

| Surface | Command | Protocol | Best for |
|---|---|---|---|
| **TypeScript SDK** | spawns `codex exec --experimental-json` internally | JSONL over child stdout | **Jarvis v1 — recommended** |
| **Raw exec** | `codex exec --json "<prompt>"` | JSONL on stdout | scripts/CI, language-agnostic |
| **App server** | `codex app-server` | bidirectional JSON-RPC 2.0 over stdio (also `--listen ws://…` / `unix://…`) | deep product integration: approvals UI, login flows, rate-limit display, steer/interrupt |
| **MCP server** | `codex mcp-server` | MCP (JSON-RPC over stdio) | exposing Codex as a *tool* to another agent |
| ~~proto~~ | `codex proto` | — | **REMOVED.** Not in v0.144 CLI (`codex-rs/cli/src/main.rs` has no `Proto` subcommand). Replaced by `app-server`. Do not build against it. |

---

## 2. `codex exec` — non-interactive mode (the layer under everything)

```bash
codex exec "summarize the repository structure"          # human output
codex exec --json "analyze the codebase" | jq            # JSONL events
codex exec "extract metadata" --output-schema ./schema.json -o ./out.json
codex exec resume --last "continue with next task"
codex exec resume <SESSION_ID> "follow-up instruction"
cat prompt.txt | codex exec -                             # prompt from stdin
```

Flags (exact, v0.144):

- `--json` / `--experimental-json` — newline-delimited JSON event stream on stdout (the SDK passes `--experimental-json`; both accepted)
- `--output-last-message <path>` / `-o` — write final agent message to a file
- `--output-schema <path>` — JSON Schema the final response must conform to (structured output)
- `-C` / `--cd <dir>` — working directory
- `--add-dir <dir>` — additional writable/visible directories (repeatable)
- `-s` / `--sandbox <read-only|workspace-write|danger-full-access>` (default read-only)
- `-a` / `--ask-for-approval <untrusted|on-request|never>` (SDK also emits `on-failure` via config; approval prompts are meaningless in exec mode — see §7)
- `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo`) — no sandbox at all
- `--full-auto` — deprecated; use explicit `--sandbox`
- `-m` / `--model <slug>`
- `-i` / `--image <path>` — attach image(s)
- `--skip-git-repo-check` — allow running outside a git repo (Codex refuses otherwise)
- `--ephemeral` — don't persist session rollout files
- `--ignore-user-config` — skip `$CODEX_HOME/config.toml`
- `--ignore-rules` — skip user/project `.rules`/execpolicy files
- `-c key=value` / `--config key=value` — override any config.toml key (TOML literal values)
- `-p` / `--profile <name>` — config profile
- `--color always|never|auto`

Output routing: progress → stderr; final agent message → stdout (when not `--json`). Exit code non-zero on failure (SDK throws on `code !== 0 || signal`).

### JSONL event schema (`--json`), verified from `sdk/typescript/src/events.ts` (generated from `codex-rs/exec/src/exec_events.rs`)

Top-level `ThreadEvent` union — exact `type` strings:

- `thread.started` → `{ type, thread_id: string }` (first event; save `thread_id` to resume later)
- `turn.started` → `{ type }`
- `turn.completed` → `{ type, usage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens } }`
- `turn.failed` → `{ type, error: { message: string } }`
- `item.started` / `item.updated` / `item.completed` → `{ type, item: ThreadItem }`
- `error` → `{ type, message }` (fatal stream error)

`ThreadItem` union — exact `item.type` strings and payloads (from `items.ts`):

- `agent_message` — `{ id, text }` (text is JSON when `--output-schema`/outputSchema used)
- `reasoning` — `{ id, text }` (reasoning summary)
- `command_execution` — `{ id, command, aggregated_output, exit_code?, status: "in_progress"|"completed"|"failed" }`
- `file_change` — `{ id, changes: [{ path, kind: "add"|"delete"|"update" }], status: "completed"|"failed" }`
- `mcp_tool_call` — `{ id, server, tool, arguments, result?, error?, status: "in_progress"|"completed"|"failed" }`
- `web_search` — `{ id, query }`
- `todo_list` — `{ id, items: [{ text, completed: boolean }] }` (the agent's plan — great for HUD)
- `error` — `{ id, message }` (non-fatal)

Example lines:

```json
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, examples."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
```

---

## 3. `@openai/codex-sdk` — the TypeScript SDK (exists, first-party, recommended)

- npm: https://www.npmjs.com/package/@openai/codex-sdk — latest **0.144.3** (2026-07-13). Node 18+.
- It is a thin wrapper: it **spawns the bundled `codex` binary** (`codex exec --experimental-json`) and parses JSONL from stdout. Prompt is written to child stdin. Resume = appends `resume <threadId>` to the argv.
- Binary resolution: resolves `@openai/codex` → platform package (`@openai/codex-darwin-arm64`, `@openai/codex-darwin-x64`, `-linux-x64/arm64`, `-win32-x64/arm64`) → `vendor/<triple>/bin/codex`. Override with `codexPathOverride`.
- Sets env `CODEX_INTERNAL_ORIGINATOR_OVERRIDE=codex_sdk_ts` on the child.

### Exact API (from source)

```ts
// codexOptions.ts
type CodexOptions = {
  codexPathOverride?: string;   // absolute path to a codex binary
  baseUrl?: string;             // becomes --config openai_base_url="…"
  apiKey?: string;              // becomes env CODEX_API_KEY on the child
  config?: CodexConfigObject;   // flattened to repeated --config dotted.key=tomlValue
  env?: Record<string,string>;  // if set, child does NOT inherit process.env
};

// threadOptions.ts
type ApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";
type SandboxMode  = "read-only" | "workspace-write" | "danger-full-access";
type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";
type WebSearchMode = "disabled" | "cached" | "live";

type ThreadOptions = {
  model?: string;
  sandboxMode?: SandboxMode;              // --sandbox
  workingDirectory?: string;              // --cd
  skipGitRepoCheck?: boolean;             // --skip-git-repo-check
  modelReasoningEffort?: ModelReasoningEffort; // --config model_reasoning_effort
  networkAccessEnabled?: boolean;         // --config sandbox_workspace_write.network_access
  webSearchMode?: WebSearchMode;          // --config web_search="live" etc.
  webSearchEnabled?: boolean;             // legacy
  approvalPolicy?: ApprovalMode;          // --config approval_policy
  additionalDirectories?: string[];       // --add-dir
};

// turnOptions.ts
type TurnOptions = {
  outputSchema?: unknown;   // JSON Schema; SDK writes temp file, passes --output-schema
  signal?: AbortSignal;     // kills the child process => cancellation
};
```

```ts
import { Codex } from "@openai/codex-sdk";

const codex = new Codex();                      // uses ~/.codex auth automatically
const thread = codex.startThread({ workingDirectory: "/path", skipGitRepoCheck: true });

// buffered
const turn = await thread.run("Diagnose the test failure and propose a fix");
// turn: { items: ThreadItem[], finalResponse: string, usage: Usage | null }

// streaming
const { events } = await thread.runStreamed("Fix the bug");
for await (const ev of events) { /* ThreadEvent, schema above */ }

// multi-turn: call run() again on same Thread. thread.id populated after
// the "thread.started" event; persist it and later:
const resumed = codex.resumeThread(savedThreadId);   // sessions live in ~/.codex/sessions

// images
await thread.run([
  { type: "text", text: "Describe this screenshot" },
  { type: "local_image", path: "/tmp/shot.png" },
]);

// structured output
const t = await thread.run("Summarize repo health", {
  outputSchema: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"], additionalProperties: false },
}); // t.finalResponse is a JSON string conforming to the schema
```

Notes:
- `run()` throws on `turn.failed`.
- If `apiKey` omitted, the child inherits whatever auth `codex` itself resolves — i.e. the ChatGPT OAuth login in `~/.codex/auth.json`. **This is exactly how one ChatGPT login serves both Jarvis voice and Codex.**
- There is no approval callback in the SDK — exec mode cannot prompt. Pick sandbox/approval up front (§7).

---

## 4. `codex app-server` — the deep-integration surface (what the VS Code extension and ChatGPT desktop app use)

Launch: `codex app-server` (stdio default; newline-delimited JSON-RPC 2.0). Experimental: `--listen ws://127.0.0.1:4500`, `--listen unix://PATH`. Env: `RUST_LOG`, `LOG_FORMAT=json` (structured logs on stderr). Overload responses use JSON-RPC error `-32001` "Server overloaded; retry later."

Generate typed bindings pinned to your binary version:

```bash
codex app-server generate-ts --out DIR
codex app-server generate-json-schema --out DIR
```

### Handshake

```json
{"method":"initialize","id":0,"params":{
  "clientInfo":{"name":"jarvis","title":"Jarvis Desktop","version":"0.1.0"},
  "capabilities":{"experimentalApi":true,
                   "optOutNotificationMethods":["item/reasoning/textDelta"]}}}
```
Then send `initialized` notification. Anything before that → "Not initialized" errors.

### Core lifecycle

`initialize → thread/start | thread/resume | thread/fork → turn/start → (stream notifications) → turn/completed`

```json
{"method":"thread/start","id":10,"params":{
  "model":"gpt-5.6-terra","cwd":"/Users/me/project",
  "approvalPolicy":"never","sandbox":"workspaceWrite"}}
```
(NB: app-server enums are camelCase — `workspaceWrite`, `dangerFullAccess` — unlike the CLI's kebab-case.)

```json
{"method":"turn/start","id":30,"params":{
  "threadId":"thr_123",
  "input":[{"type":"text","text":"Run tests"},{"type":"localImage","path":"/tmp/shot.png"}],
  "model":"gpt-5.6-terra","effort":"medium","approvalPolicy":"unlessTrusted"}}
```

Streaming notifications (server → client): `turn/started`, `item/started`, `item/agentMessage/delta`, `item/reasoning/summaryTextDelta`, `item/reasoning/textDelta`, `item/commandExecution/outputDelta`, `item/fileChange/patchUpdated`, `item/plan/delta`, `item/completed`, `turn/completed` (`turn.status: "completed"|"interrupted"|"failed"`, error carries `codexErrorInfo` such as `ContextWindowExceeded`, `UsageLimitExceeded`, `Unauthorized`, `SandboxError`, plus `httpStatusCode`).

Mid-turn control: `turn/steer` (inject more input, with `expectedTurnId`), `turn/interrupt`.

### Approvals (server sends the client JSON-RPC *requests*; you answer)

- `item/commandExecution/requestApproval` — params include `itemId, threadId, turnId, reason?, command?, cwd?, commandActions?, availableDecisions?`; respond `accept | acceptForSession | decline | cancel`
- `item/fileChange/requestApproval` — `accept | acceptForSession | decline | cancel` (payload has `grantRoot?`)
- `item/permissions/requestApproval`, `tool/requestUserInput`, `mcpServer/elicitation/request`

This is the only surface with a real interactive-approval loop, i.e. "Jarvis asks you out loud: Codex wants to run `rm -rf node_modules`, allow?"

### Auth & account methods (relevant to "one ChatGPT login")

- `account/read` — current auth state (optionally refresh)
- `account/login/start` with `type: "chatgpt"` (browser OAuth), `"chatgptDeviceCode"`, `"apiKey"`, or experimental `"chatgptAuthTokens"` (host app owns tokens); `account/login/cancel`, `account/logout`
- Notifications: `account/updated` (`authMode`, `planType`), `account/login/completed`
- `account/rateLimits/read` → `{ rateLimits: { primary: { usedPercent, windowDurationMins, resetsAt }, secondary }, … }` and `account/rateLimits/updated` push — ideal for a HUD quota meter
- `account/usage/read` — token activity summaries

### Other useful methods

`thread/list`, `thread/read`, `thread/archive|delete|unarchive`, `thread/name/set`, `thread/compact/start`, `model/list` (returns models with `supportedReasoningEfforts`), `permissionProfile/list`, `config/read`, `config/value/write`, `mcpServer/tool/call`, `fs/*` (readFile/writeFile/watch…), `command/exec` (run a one-off command in the sandbox), `review/start`.

Full method inventory captured in research: thread/*, turn/*, account/*, model/list, skills/*, plugin/*, mcpServer/*, fs/*, hooks/list, feedback/upload.

---

## 5. `codex mcp-server` — Codex as an MCP tool

- Command: `codex mcp-server` (stdio, JSON-RPC/MCP). Debug: `npx @modelcontextprotocol/inspector codex mcp-server`.
- Tools exposed:
  - `codex` — params: `prompt` (required), `model`, `cwd`, `sandbox` (`read-only|workspace-write|danger-full-access`), `approval-policy` (`untrusted|on-failure|on-request|never`), `profile`, `base-instructions`, `config`. Returns when the turn completes with `threadId` + content.
  - `codex-reply` — same + required `threadId` for follow-up turns.
- Approvals propagate via MCP **elicitation** when `approval-policy=on-request`.
- Do not confuse with `codex mcp list|add|get|remove|login|logout`, which manages MCP servers that *Codex consumes* (configured under `[mcp_servers.*]` in config.toml).
- Relevance to Jarvis: this is the natural bridge if you want the **Realtime/voice agent itself** to invoke Codex as a tool via an MCP client library, instead of Jarvis' main process orchestrating. Blocking (no streaming progress until turn end), so worse for HUD progress than exec/app-server.

---

## 6. Auth: one ChatGPT login serving Jarvis voice + Codex

- `codex login` → browser OAuth. Issuer **https://auth.openai.com**, local callback server on **port 1455** (`codex-rs/login/src/server.rs`: `DEFAULT_ISSUER = "https://auth.openai.com"`, `DEFAULT_PORT = 1455`), OAuth client id **`app_EMoamEEZ73f0CkXaXp7hrann`** (`codex-rs/login/src/auth/manager.rs`, `pub const CLIENT_ID`), overridable via env `CODEX_APP_SERVER_LOGIN_CLIENT_ID`. PKCE flow (`pkce.rs`).
- `codex login --device-auth` — device-code flow (beta, for headless).
- `printenv OPENAI_API_KEY | codex login --with-api-key` — API-key mode (platform billing, not ChatGPT plan).
- Non-interactive: env var **`CODEX_API_KEY`** (used by `codex exec` and set by the SDK's `apiKey` option).
- Credential cache: **`$CODEX_HOME/auth.json`** (default `~/.codex/auth.json`). `CODEX_HOME` env moves everything.
- Exact `auth.json` schema (from `codex-rs/login/src/auth/storage.rs` `AuthDotJson`):

```json
{
  "auth_mode": "…optional…",
  "OPENAI_API_KEY": "sk-… or null",
  "tokens": {
    "id_token": "<JWT — claims include email, https://api.openai.com/auth: {chatgpt_plan_type, chatgpt_user_id, chatgpt_account_id}>",
    "access_token": "<JWT>",
    "refresh_token": "…",
    "account_id": "…"
  },
  "last_refresh": "2026-07-13T00:00:00Z"
}
```

- **Caveat:** `cli_auth_credentials_store = "file" | "keyring" | "auto"` in config.toml. If the user (or a future default) switches to `keyring`, `auth.json` won't hold tokens. So Jarvis should *detect* login state by running `codex login status` or app-server `account/read`, not by parsing auth.json — and let `codex` resolve its own credentials for task execution.
- Tokens auto-refresh during use. Copying `~/.codex/auth.json` between machines works for headless setups.
- Enforcement knobs: `forced_login_method = "chatgpt" | "api"`, `forced_chatgpt_workspace_id = "<uuid>"`.
- Practical Jarvis flow: Jarvis "Sign in with ChatGPT" button → spawn `codex login` (it opens the browser and completes on localhost:1455) or, richer, run `codex app-server` and drive `account/login/start {type:"chatgpt"}` + listen for `account/login/completed`. After that, both the voice layer (if it reuses the same OAuth tokens — separate research track) and every Codex invocation are authenticated with zero extra prompts.

---

## 7. Sandbox & approvals (what to actually set)

- Sandbox on macOS = Seatbelt-based OS sandbox; `--sandbox` values `read-only` (default), `workspace-write` (cwd + `--add-dir` writable; network **off** unless `sandbox_workspace_write.network_access = true`), `danger-full-access`.
- Approval policy `--ask-for-approval untrusted|on-request|never` (+ `on-failure` value in config/SDK). In `codex exec` there is **no interactive approver** — commands that would need approval simply fail/skip; docs recommend explicit sandbox instead.
- `--dangerously-bypass-approvals-and-sandbox` / `--yolo` — never ship as a default.
- Sensible Jarvis presets:
  - "Look into X" (read-only research): `sandboxMode: "read-only"`, `approvalPolicy: "never"`.
  - "Fix/build X" (default): `sandboxMode: "workspace-write"`, `approvalPolicy: "never"`, `networkAccessEnabled: false`; escalate to `true` when task needs installs.
  - "Full access" behind an explicit voice confirmation: `danger-full-access`.
  - If/when Jarvis adopts app-server: `approvalPolicy: "unlessTrusted"` + surface `item/commandExecution/requestApproval` as a voice/HUD confirmation.

## 8. config.toml essentials (`~/.codex/config.toml`; project-scoped `.codex/config.toml` in trusted projects)

```toml
model = "gpt-5.6-terra"
model_provider = "openai"            # or ollama, lmstudio, custom id
model_reasoning_effort = "medium"    # minimal|low|medium|high|xhigh
model_verbosity = "medium"
approval_policy = "never"            # untrusted|on-request|never (+granular table form)
sandbox_mode = "workspace-write"     # read-only|workspace-write|danger-full-access

[sandbox_workspace_write]
writable_roots = ["/extra/path"]
network_access = false
exclude_tmpdir_env_var = false
exclude_slash_tmp = false

[mcp_servers.composio]               # MCP servers Codex itself can call
command = "npx"
args = ["-y", "@composio/mcp@latest"]
startup_timeout_sec = 10
tool_timeout_sec = 60
[mcp_servers.composio.env]
COMPOSIO_API_KEY = "…"

notify = ["/usr/local/bin/jarvis-notify"]   # external program invoked with JSON payload per event

cli_auth_credentials_store = "file"  # file|keyring|auto
# forced_login_method = "chatgpt"
# profile = "jarvis"
```

Anything here can be overridden per-invocation with `-c key=value` (this is what the SDK `config` object compiles to; values are TOML literals, e.g. `-c model_reasoning_effort="high"`). Project-scoped config may NOT override: `model_provider(s)`, `approval_policy`, `sandbox_mode`, `sandbox_workspace_write.*`, `notify`, `profile(s)`, `openai_base_url`, `otel`.

## 9. Models (as of 2026-07-13, ChatGPT sign-in)

From https://developers.openai.com/codex/models: `gpt-5.6-sol` (flagship), `gpt-5.6-terra` (balanced default), `gpt-5.6-luna` (fast/cheap), `gpt-5.5` (prev-gen), `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark` (real-time coding research preview, Pro only, text-only — interesting for low-latency voice-driven edits). Reasoning efforts: low → medium (default) → high → xhigh (+ "max"/"ultra" tiers on newer models). Older `gpt-5.2*`/`gpt-5.3-codex` deprecated for ChatGPT sign-in. Don't hardcode: query `codex app-server` `model/list` or ship a config default of `gpt-5.6-terra` and let users pick.

---

## 10. Recommended invocation pattern for Jarvis (Electron main process)

**Phase 1 (ship now): `@openai/codex-sdk` in the main process.** One dependency, version-pinned binary, typed events, AbortSignal cancellation, session resume. No approval loop needed if you fix sandbox up front.

```ts
// main/codexBridge.ts (Electron main process)
import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import { BrowserWindow } from "electron";

const codex = new Codex(); // resolves bundled binary + ~/.codex/auth.json (ChatGPT login)

export type CodexTaskOpts = { cwd: string; prompt: string; resumeId?: string; escalated?: boolean };

export async function runCodexTask(win: BrowserWindow, t: CodexTaskOpts) {
  const ac = new AbortController();
  const thread = t.resumeId
    ? codex.resumeThread(t.resumeId, baseOpts(t))
    : codex.startThread(baseOpts(t));

  const { events } = await thread.runStreamed(t.prompt, {
    signal: ac.signal,
    outputSchema: {                    // force a voice-friendly final message
      type: "object",
      properties: {
        spoken_summary: { type: "string", description: "<=2 sentences, for TTS" },
        details: { type: "string" },
        files_changed: { type: "array", items: { type: "string" } },
      },
      required: ["spoken_summary", "details", "files_changed"],
      additionalProperties: false,
    },
  });

  for await (const ev of events) {
    win.webContents.send("codex:event", ev);          // raw feed to HUD renderer
    routeForVoice(ev);                                 // condensed feed to Realtime session
  }
  return { threadId: thread.id, cancel: () => ac.abort() };
}

function baseOpts(t: CodexTaskOpts) {
  return {
    workingDirectory: t.cwd,
    skipGitRepoCheck: true,
    sandboxMode: t.escalated ? "danger-full-access" : "workspace-write",
    approvalPolicy: "never",
    networkAccessEnabled: t.escalated ?? false,
    model: "gpt-5.6-terra",
    modelReasoningEffort: "medium",
  } as const;
}
```

HUD/voice mapping table:

| Event | HUD | Voice |
|---|---|---|
| `thread.started` | show task card, persist `thread_id` in Jarvis DB (for "keep going on that") | "On it." |
| `item.started` `todo_list` / `item.updated` | render checklist | optional: "I've made a plan — 4 steps." |
| `item.started` `command_execution` | terminal-style row with `command`; append `aggregated_output` on `item.updated` | silent |
| `item.completed` `command_execution` | mark exit_code | only on failure: "A test command failed…" |
| `item.completed` `file_change` | file list with add/update/delete badges | silent |
| `item.completed` `reasoning` | dim status line ("thinking: …") | silent |
| `item.completed` `agent_message` | final message panel | speak `spoken_summary` from parsed JSON |
| `turn.completed` | token usage footer | — |
| `turn.failed` / `error` | error toast | "That task hit an error: …" |

Operational notes:
- Spawn happens inside the SDK; because Electron apps launched from Finder get a minimal PATH, prefer the SDK's bundled binary (default behavior) or set `codexPathOverride` explicitly; if you pass `env`, remember it **replaces** inheritance — include `PATH` and `HOME` (HOME is required for `~/.codex` resolution).
- Concurrency: one child process per task; the SDK is stateless across calls, so parallel tasks are fine. Serialize turns *within* a thread.
- Cancellation: `TurnOptions.signal` → child killed → treat as interrupted.
- Persistence: store `thread.id` → `codex.resumeThread(id)` after app restart (sessions in `~/.codex/sessions`).

**Phase 2 (upgrade path): `codex app-server` child process.** Move to it when you want: voice-mediated approvals (`item/commandExecution/requestApproval`), token-by-token HUD streaming (`item/agentMessage/delta`, `item/commandExecution/outputDelta`), in-app ChatGPT login (`account/login/start`), quota display (`account/rateLimits/read`), steer/interrupt (`turn/steer`, `turn/interrupt`), model listing (`model/list`). Generate typed bindings with `codex app-server generate-ts --out src/generated/codex` at build time, pinned to the binary you ship. This is what OpenAI's own desktop app does (bundle platform binary, long-lived child, stdio JSON-RPC).

Do **not** build on `codex proto` (removed) and don't use `codex mcp-server` for the primary bridge (blocking, no incremental progress) — reserve MCP mode for letting the voice agent call Codex as a tool if you later flip the orchestration.
