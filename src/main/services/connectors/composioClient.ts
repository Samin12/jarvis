/**
 * Lazy Composio client + config resolution for the connectors layer.
 *
 * API key resolution order (first hit wins):
 *   1. env COMPOSIO_API_KEY
 *   2. <userData>/connectors.json  { "composioApiKey": "...", "authConfigs": { "GMAIL": "ac_...", ... } }
 *
 * Auth config ids (ac_...) are NOT secrets; they live in the same file or in
 * env vars COMPOSIO_AUTH_CONFIG_<TOOLKIT> (e.g. COMPOSIO_AUTH_CONFIG_GMAIL).
 *
 * userId sent to Composio = the ChatGPT account id from the auth service
 * (stable per user), falling back to 'default' when signed out. The
 * integration layer may override the source via setUserIdProvider().
 *
 * The Composio key never leaves the main process.
 */
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Composio } from '@composio/core'
import { loadStoredAuth } from '../auth/tokenStore'

export interface ConnectorsFileConfig {
  composioApiKey?: string
  /** toolkit slug (GMAIL, GOOGLECALENDAR, ...) -> auth config id (ac_...) */
  authConfigs?: Record<string, string>
}

export interface ResolvedConnectorsConfig {
  apiKey: string | null
  apiKeySource: 'env' | 'file' | null
  authConfigs: Record<string, string>
  configPath: string
}

// ---------- config ----------

const CONFIG_FILE = 'connectors.json'
const CONFIG_TTL_MS = 5_000 // tiny cache so hot paths don't hit disk every call

let cachedConfig: ResolvedConnectorsConfig | null = null
let cachedConfigAt = 0

export function connectorsConfigPath(): string {
  return join(app.getPath('userData'), CONFIG_FILE)
}

function readConfigFile(): ConnectorsFileConfig {
  try {
    const path = connectorsConfigPath()
    if (!existsSync(path)) return {}
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ConnectorsFileConfig
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

export function loadConnectorsConfig(force = false): ResolvedConnectorsConfig {
  const now = Date.now()
  if (!force && cachedConfig && now - cachedConfigAt < CONFIG_TTL_MS) return cachedConfig

  const file = readConfigFile()
  const envKey = (process.env.COMPOSIO_API_KEY ?? '').trim()
  const fileKey = (file.composioApiKey ?? '').trim()

  const authConfigs: Record<string, string> = {}
  for (const [slug, id] of Object.entries(file.authConfigs ?? {})) {
    if (typeof id === 'string' && id.trim()) authConfigs[slug.toUpperCase()] = id.trim()
  }
  // env override/extension: COMPOSIO_AUTH_CONFIG_GMAIL=ac_...
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('COMPOSIO_AUTH_CONFIG_') && value && value.trim()) {
      authConfigs[key.slice('COMPOSIO_AUTH_CONFIG_'.length).toUpperCase()] = value.trim()
    }
  }

  cachedConfig = {
    apiKey: envKey || fileKey || null,
    apiKeySource: envKey ? 'env' : fileKey ? 'file' : null,
    authConfigs,
    configPath: connectorsConfigPath()
  }
  cachedConfigAt = now
  return cachedConfig
}

export function hasComposioKey(): boolean {
  return loadConnectorsConfig().apiKey !== null
}

export function getAuthConfigId(slug: string): string | null {
  return loadConnectorsConfig().authConfigs[slug.toUpperCase()] ?? null
}

// ---------- lazy Composio instance ----------

let instance: Composio | null = null
let instanceKey: string | null = null

/**
 * Returns the shared Composio client, or null when no API key is configured.
 * Lazy dynamic import keeps the ESM-only @composio/core off the boot path and
 * loadable from the CJS main bundle.
 */
export async function getComposio(): Promise<Composio | null> {
  const { apiKey } = loadConnectorsConfig()
  if (!apiKey) {
    instance = null
    instanceKey = null
    return null
  }
  if (instance && instanceKey === apiKey) return instance
  const mod = await import('@composio/core')
  instance = new mod.Composio({ apiKey, allowTracking: false })
  instanceKey = apiKey
  return instance
}

// ---------- user id ----------

let userIdProvider: (() => string | null) | null = null
let cachedUserId: string | null = null
let cachedUserIdAt = 0
const USER_ID_TTL_MS = 30_000

/**
 * Integration hook: lets the wiring layer supply the ChatGPT account id from
 * the live auth service instead of the fallback read of the token store.
 */
export function setUserIdProvider(provider: () => string | null): void {
  userIdProvider = provider
  cachedUserId = null
  cachedUserIdAt = 0
}

/** Stable per-user id for Composio (chatgpt account id, else 'default'). */
export function getUserId(): string {
  if (userIdProvider) {
    try {
      const fromProvider = userIdProvider()
      if (fromProvider && fromProvider.trim()) return fromProvider.trim()
    } catch {
      // fall through to token store
    }
  }
  const now = Date.now()
  if (cachedUserId && now - cachedUserIdAt < USER_ID_TTL_MS) return cachedUserId
  let accountId: string | null = null
  try {
    accountId = loadStoredAuth()?.accountId ?? null
  } catch {
    accountId = null
  }
  cachedUserId = accountId && accountId.trim() ? accountId.trim() : 'default'
  cachedUserIdAt = now
  return cachedUserId
}
