/**
 * Settings service — plain JSON persistence in userData/settings.json.
 *
 * The manually pasted Platform API key is NOT stored here: the voice service
 * owns it (safeStorage-encrypted, main process only). JarvisSettings.hasManualApiKey
 * is derived at read time so the renderer sees a truthful flag without ever
 * touching the key itself.
 *
 * Integration wiring (src/main/index.ts):
 *   registerSettings(ipcMain)
 *   registerVoice(ipcMain, getWindow, { executeTool, getSettings: getSettingsSnapshot })
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app, type IpcMain } from 'electron'
import { IPC } from '../../../shared/ipc'
import type { JarvisSettings } from '../../../shared/types'
import { hasManualApiKey } from '../voice'

/** Everything persisted to disk — hasManualApiKey is derived, never stored. */
type PersistedSettings = Omit<JarvisSettings, 'hasManualApiKey'>

const DEFAULTS: PersistedSettings = {
  voiceModel: 'gpt-realtime-2.1',
  voice: 'marin',
  costMode: false,
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
  if (input.voiceModel === 'gpt-realtime-2.1' || input.voiceModel === 'gpt-realtime-2.1-mini') {
    out.voiceModel = input.voiceModel
  }
  if (typeof input.voice === 'string' && input.voice.trim().length > 0) {
    out.voice = input.voice.trim()
  }
  if (typeof input.costMode === 'boolean') {
    out.costMode = input.costMode
  }
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
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`)
  } catch {
    // in-memory copy still serves this session
  }
}

/** Synchronous snapshot for main-side consumers (voice's getSettings dep). */
export function getSettingsSnapshot(): PersistedSettings {
  return { ...load() }
}

/** Full settings object as the renderer sees it. */
export async function getSettings(): Promise<JarvisSettings> {
  let manualKey = false
  try {
    manualKey = await hasManualApiKey()
  } catch {
    manualKey = false
  }
  return { ...load(), hasManualApiKey: manualKey }
}

export function registerSettings(ipcMain: IpcMain): void {
  ipcMain.handle(IPC.settings.get, () => getSettings())
  ipcMain.handle(IPC.settings.update, async (_event, patch: Partial<JarvisSettings>) => {
    persist({ ...load(), ...sanitize(patch) })
    return getSettings()
  })
}
