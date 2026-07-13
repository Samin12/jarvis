/**
 * D1 key ladder — resolve a Platform API key for the Realtime lane.
 *   1. OPENAI_API_KEY inside ~/.codex/auth.json (codex login / our own token exchange mirror)
 *   2. token-exchange key handed over by the auth service
 *   3. process.env.OPENAI_API_KEY
 *   4. manual key pasted in Settings (safeStorage-persisted, main-process only)
 * The key NEVER crosses to the renderer; only ephemeral ek_ secrets do.
 */
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { app, safeStorage } from 'electron'
import type { VoiceKeySource } from '../../../shared/types'
import { readCodexAuthFile } from './codexAuthFile'
import { getPlatformApiKey } from '../auth'

export interface ResolvedVoiceKey {
  key: string
  source: VoiceKeySource
}

const MANUAL_KEY_FILE = 'voice-manual-key.enc'

/** In-memory copy so a pasted key works immediately (and survives even if safeStorage is off). */
let manualKeyMemory: string | null = null

function plausibleKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 20
}

function manualKeyPath(): string {
  return join(app.getPath('userData'), MANUAL_KEY_FILE)
}

async function loadManualKey(): Promise<string | null> {
  if (manualKeyMemory) return manualKeyMemory
  try {
    const blob = await readFile(manualKeyPath())
    if (!safeStorage.isEncryptionAvailable()) return null
    const key = safeStorage.decryptString(blob)
    if (plausibleKey(key)) {
      manualKeyMemory = key.trim()
      return manualKeyMemory
    }
  } catch {
    // no stored key
  }
  return null
}

/**
 * Persist (or clear, with an empty string) the manually pasted Platform key.
 * Returns true when the key was accepted.
 */
export async function setManualApiKey(rawKey: string): Promise<boolean> {
  const key = typeof rawKey === 'string' ? rawKey.trim() : ''
  if (key.length === 0) {
    manualKeyMemory = null
    await rm(manualKeyPath(), { force: true }).catch(() => undefined)
    return true
  }
  if (!plausibleKey(key)) return false
  manualKeyMemory = key
  try {
    if (safeStorage.isEncryptionAvailable()) {
      const file = manualKeyPath()
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, safeStorage.encryptString(key), { mode: 0o600 })
    }
    // If Keychain encryption is unavailable we keep the key in memory only (works
    // until restart) rather than writing plaintext to disk.
    return true
  } catch {
    return true // memory copy still active for this session
  }
}

/** Whether a manual key is currently present (for JarvisSettings.hasManualApiKey). */
export async function hasManualApiKey(): Promise<boolean> {
  return (await loadManualKey()) !== null
}

/** Walk the D1 ladder; null means the app must use the no-key fallback lane. */
export async function resolveVoiceKey(): Promise<ResolvedVoiceKey | null> {
  // 1. ~/.codex/auth.json
  const codexAuth = await readCodexAuthFile()
  if (plausibleKey(codexAuth?.OPENAI_API_KEY)) {
    return { key: codexAuth!.OPENAI_API_KEY!.trim(), source: 'codex-auth-json' }
  }

  // 2. token-exchange key from the auth service
  try {
    const exchanged: unknown = await getPlatformApiKey()
    if (plausibleKey(exchanged)) return { key: exchanged.trim(), source: 'token-exchange' }
  } catch {
    // auth service not ready / no platform org — keep walking the ladder
  }

  // 3. environment
  if (plausibleKey(process.env.OPENAI_API_KEY)) {
    return { key: process.env.OPENAI_API_KEY!.trim(), source: 'env' }
  }

  // 4. manual key from settings
  const manual = await loadManualKey()
  if (manual) return { key: manual, source: 'settings' }

  return null
}
