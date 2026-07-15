import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from 'electron'

const MAX_REQUESTS_PER_WINDOW = 120
const RATE_WINDOW_MS = 10_000

interface RateBucket {
  startedAt: number
  count: number
}

const buckets = new Map<number, RateBucket>()

export function assertTrustedIpc(
  event: IpcMainInvokeEvent,
  getWindow: () => BrowserWindow | null
): void {
  const window = getWindow()
  if (!window || window.isDestroyed()) throw new Error('Jarvis window is unavailable')
  if (event.sender.id !== window.webContents.id) throw new Error('Untrusted IPC sender')
  const frame = event.senderFrame
  if (!frame || frame !== window.webContents.mainFrame)
    throw new Error('Subframes cannot call Jarvis IPC')
  if (!isTrustedRendererUrl(frame.url)) throw new Error('Untrusted renderer origin')
  enforceRateLimit(event.sender.id)
}

export function registerTrustedHandler<Args extends unknown[], Result>(
  ipcMain: IpcMain,
  channel: string,
  getWindow: () => BrowserWindow | null,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Result | Promise<Result>
): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    assertTrustedIpc(event, getWindow)
    return handler(event, ...(args as Args))
  })
}

export function assertPlainObject(
  value: unknown,
  options: { name: string; maxBytes?: number } = { name: 'payload' }
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${options.name} must be an object`)
  }
  const bytes = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (bytes > (options.maxBytes ?? 256 * 1024)) {
    throw new Error(`${options.name} exceeds the safety limit`)
  }
}

export function requireString(value: unknown, name: string, maxLength: number): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${name} is required`)
  const normalized = value.trim()
  if (normalized.length > maxLength) throw new Error(`${name} exceeds ${maxLength} characters`)
  return normalized
}

function isTrustedRendererUrl(raw: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol === 'file:') return true
    return (
      process.env.NODE_ENV === 'development' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
      (url.protocol === 'http:' || url.protocol === 'https:')
    )
  } catch {
    return false
  }
}

function enforceRateLimit(senderId: number): void {
  const now = Date.now()
  const current = buckets.get(senderId)
  if (!current || now - current.startedAt >= RATE_WINDOW_MS) {
    buckets.set(senderId, { startedAt: now, count: 1 })
    return
  }
  current.count += 1
  if (current.count > MAX_REQUESTS_PER_WINDOW) throw new Error('IPC rate limit exceeded')
}
