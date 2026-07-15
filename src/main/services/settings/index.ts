/** Settings service — allowlisted JSON persistence in userData/settings.json. */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, type BrowserWindow, type IpcMain } from 'electron'
import { IPC } from '../../../shared/ipc'
import type { JarvisSettings } from '../../../shared/types'
import { assertPlainObject, registerTrustedHandler } from '../../security'

type PersistedSettings = JarvisSettings

const DEFAULTS: PersistedSettings = {
  pushToTalkKey: 'Space'
}

let cache: PersistedSettings | null = null

function settingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/** Accept only known keys with plausible values; drop everything else. */
function sanitize(raw: unknown): Partial<PersistedSettings> {
  if (!raw || typeof raw !== 'object') return {}
  const input = raw as Record<string, unknown>
  const out: Partial<PersistedSettings> = {}
  if (typeof input.pushToTalkKey === 'string' && input.pushToTalkKey.trim().length > 0) {
    out.pushToTalkKey = input.pushToTalkKey.trim()
  }
  return out
}

function load(): PersistedSettings {
  if (cache) return cache
  try {
    const raw: unknown = JSON.parse(readFileSync(settingsPath(), 'utf8'))
    cache = { ...DEFAULTS, ...sanitize(raw) }
  } catch {
    cache = { ...DEFAULTS }
  }
  return cache
}

function persist(next: PersistedSettings): void {
  cache = next
  try {
    const file = settingsPath()
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    chmodSync(file, 0o600)
  } catch {
    // in-memory copy still serves this session
  }
}

export function getSettingsSnapshot(): PersistedSettings {
  return { ...load() }
}

export function getSettings(): JarvisSettings {
  return { ...load() }
}

export function registerSettings(ipcMain: IpcMain, getWindow: () => BrowserWindow | null): void {
  registerTrustedHandler(ipcMain, IPC.settings.get, getWindow, () => getSettings())
  registerTrustedHandler(
    ipcMain,
    IPC.settings.update,
    getWindow,
    async (_event, patch: unknown) => {
      assertPlainObject(patch, { name: 'settings update', maxBytes: 4_096 })
      persist({ ...load(), ...sanitize(patch) })
      return getSettings()
    }
  )
}
