/**
 * Loopback OAuth callback server.
 *
 * Binds 127.0.0.1 on port 1455 (fallback 1457 — the ONLY two ports on OpenAI's
 * redirect-URI allow-list for the Codex client). The registered redirect_uri host
 * is literally `localhost`, so the redirect URI we hand to the authorize endpoint
 * is http://localhost:{port}/auth/callback while the socket itself binds 127.0.0.1.
 *
 * Lifecycle: started by signIn, torn down after one successful callback, on
 * cancel(), or after a 5-minute timeout.
 */
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'

export const LOGIN_PORTS: readonly number[] = [1455, 1457]
export const CALLBACK_PATH = '/auth/callback'
export const LOGIN_TIMEOUT_MS = 5 * 60 * 1000

export interface LoginServerOptions {
  /** state param generated for this flow; callbacks with any other value are rejected. */
  expectedState: string
  /**
   * Called with the authorization code once state validates. Perform the token
   * exchange here — if it resolves the browser gets the success page, if it
   * throws the browser gets the error page and `done` rejects. `redirectUri`
   * is the exact value that must be echoed in the token exchange.
   */
  onCode: (code: string, redirectUri: string) => Promise<void>
  timeoutMs?: number
}

export interface LoginServerHandle {
  port: number
  /** Exact redirect_uri to place in the authorize URL and the token exchange. */
  redirectUri: string
  /** Settles when the flow finishes: resolves after a successful callback+exchange. */
  done: Promise<void>
  /** Abort the flow (e.g. user retried); safe to call after settle. */
  cancel: (reason?: string) => void
}

export async function startLoginServer(options: LoginServerOptions): Promise<LoginServerHandle> {
  const timeoutMs = options.timeoutMs ?? LOGIN_TIMEOUT_MS
  const sockets = new Set<Socket>()
  let settled = false
  let resolveDone!: () => void
  let rejectDone!: (err: Error) => void
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve
    rejectDone = reject
  })
  // A callback can settle `done` before the caller has awaited it — pre-attach
  // a handler so an early rejection never becomes an unhandled-rejection crash.
  done.catch(() => {})

  const server = createServer()
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })

  const port = await listenOnAllowedPort(server)
  const redirectUri = `http://localhost:${port}${CALLBACK_PATH}`

  const teardown = (): void => {
    server.close()
    for (const socket of sockets) socket.destroy()
    sockets.clear()
    clearTimeout(timer)
  }

  const settle = (err: Error | null): void => {
    if (settled) return
    settled = true
    if (err) rejectDone(err)
    else resolveDone()
    // Give the final response a beat to flush before nuking sockets.
    setTimeout(teardown, 300)
  }

  const timer = setTimeout(() => {
    settle(new Error('Sign-in timed out after 5 minutes. Try again.'))
  }, timeoutMs)

  server.on('request', (req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`)
      if (req.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found')
        return
      }
      if (settled) {
        sendHtml(res, 200, successPage())
        return
      }

      const oauthError = url.searchParams.get('error')
      if (oauthError) {
        const description = url.searchParams.get('error_description') ?? ''
        sendHtml(res, 400, errorPage(`${oauthError}${description ? `: ${description}` : ''}`))
        settle(new Error(`Authorization failed: ${oauthError} ${description}`.trim()))
        return
      }

      const state = url.searchParams.get('state')
      const code = url.searchParams.get('code')
      if (!state || state !== options.expectedState) {
        // Stray or forged request — reject it but keep listening for the real callback.
        sendHtml(res, 400, errorPage('State mismatch. Close this tab and retry from Jarvis.'))
        return
      }
      if (!code) {
        sendHtml(res, 400, errorPage('Missing authorization code.'))
        settle(new Error('Callback arrived without an authorization code'))
        return
      }

      try {
        await options.onCode(code, redirectUri)
        sendHtml(res, 200, successPage())
        settle(null)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        sendHtml(res, 500, errorPage(message))
        settle(new Error(message))
      }
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Internal error')
      } catch {
        /* response already closed */
      }
      settle(new Error(message))
    })
  })

  return {
    port,
    redirectUri,
    done,
    cancel: (reason?: string) => settle(new Error(reason ?? 'Sign-in cancelled'))
  }
}

async function listenOnAllowedPort(server: Server): Promise<number> {
  for (const port of LOGIN_PORTS) {
    const ok = await tryListen(server, port)
    if (ok) return port
  }
  throw new Error(
    `Ports ${LOGIN_PORTS.join(' and ')} are busy (another sign-in or "codex login" running?). ` +
      'Close it and try again.'
  )
}

function tryListen(server: Server, port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      if (err.code === 'EADDRINUSE' || err.code === 'EACCES') resolve(false)
      else reject(err)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      resolve(true)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  try {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end(html)
  } catch {
    /* socket already gone */
  }
}

function pageShell(body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Jarvis</title>
<style>
  html, body { height: 100%; margin: 0; }
  body {
    display: grid; place-items: center;
    background: #0b0b0f; color: #e8e8ee;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    text-align: center;
  }
  .card { max-width: 26rem; padding: 2rem; }
  .mark { font-size: 0.8rem; letter-spacing: 0.35em; color: #7d7d8f; margin-bottom: 1.2rem; }
  h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 0.6rem; }
  p { color: #a0a0b2; font-size: 0.95rem; line-height: 1.5; margin: 0; }
  .ok h1 { color: #9fe8c5; }
  .err h1 { color: #ff8f8f; }
  code { color: #c8c8d8; word-break: break-word; }
</style>
</head>
<body>
${body}
<script>setTimeout(function () { window.close() }, 2000)</script>
</body>
</html>`
}

function successPage(): string {
  return pageShell(`<div class="card ok">
  <div class="mark">J A R V I S</div>
  <h1>Signed in</h1>
  <p>You can return to Jarvis. This window will close itself.</p>
</div>`)
}

function errorPage(message: string): string {
  return pageShell(`<div class="card err">
  <div class="mark">J A R V I S</div>
  <h1>Sign-in failed</h1>
  <p><code>${escapeHtml(message)}</code></p>
  <p style="margin-top:0.8rem">Return to Jarvis and try again.</p>
</div>`)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
