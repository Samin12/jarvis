/**
 * Voice service registration — IPC.voice.* handlers.
 * Integration wires this from src/main/index.ts:
 *   registerVoice(ipcMain, getWindow, { executeTool: connectorsExecutor, getSettings })
 */
import type { BrowserWindow, IpcMain } from 'electron'
import { IPC } from '../../../shared/ipc'
import type { JarvisSettings, VoiceLane } from '../../../shared/types'
import { resolveVoiceKey, setManualApiKey } from './voiceKey'
import { mintRealtimeSession } from './realtimeSessions'
import { streamChatFallback, type ChatSendRequest } from './chatFallback'
import { setManualPlatformApiKey } from '../auth'

export { resolveVoiceKey, setManualApiKey, hasManualApiKey } from './voiceKey'
export { mintRealtimeSession } from './realtimeSessions'
export { streamChatFallback } from './chatFallback'

export interface VoiceServiceDeps {
  /**
   * Connector tool executor (owned by the connectors service). Integration passes
   * connectors' executor here; until then tool calls return a clean failure payload.
   */
  executeTool?: (name: string, argsJson: string) => Promise<{ ok: boolean; resultJson: string }>
  /** Settings snapshot provider (settings service / integration). Defaults applied per key. */
  getSettings?: () => Promise<Partial<JarvisSettings>> | Partial<JarvisSettings>
}

const DEFAULT_SETTINGS: Pick<JarvisSettings, 'voiceModel' | 'voice' | 'costMode'> = {
  voiceModel: 'gpt-realtime-2.1',
  voice: 'marin',
  costMode: false
}

export function registerVoice(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
  deps: VoiceServiceDeps = {}
): void {
  const readSettings = async (): Promise<typeof DEFAULT_SETTINGS> => {
    try {
      const partial = deps.getSettings ? await deps.getSettings() : {}
      return {
        voiceModel: partial.voiceModel ?? DEFAULT_SETTINGS.voiceModel,
        voice: partial.voice ?? DEFAULT_SETTINGS.voice,
        costMode: partial.costMode ?? DEFAULT_SETTINGS.costMode
      }
    } catch {
      return DEFAULT_SETTINGS
    }
  }

  ipcMain.handle(IPC.voice.mintRealtimeSession, async () => {
    const resolved = await resolveVoiceKey()
    if (!resolved) {
      return {
        error:
          'No Platform API key available for live voice — using the fallback lane. Paste a key in Settings or run `codex login` to enable full-duplex voice.'
      }
    }
    const settings = await readSettings()
    const model = settings.costMode ? 'gpt-realtime-2.1-mini' : settings.voiceModel
    return mintRealtimeSession(resolved.key, { model, voice: settings.voice })
  })

  ipcMain.handle(IPC.voice.laneAvailable, async (): Promise<VoiceLane> => {
    const resolved = await resolveVoiceKey()
    return resolved ? 'realtime' : 'fallback'
  })

  ipcMain.handle(IPC.voice.setManualApiKey, async (_event, key: string) => {
    const normalized = typeof key === 'string' ? key : ''
    const accepted = await setManualApiKey(normalized)
    if (accepted) {
      try {
        // Keep AuthStatus.voiceKeyAvailable truthful (auth service exposes this hook).
        setManualPlatformApiKey(normalized.trim().length > 0 ? normalized.trim() : null)
      } catch {
        /* auth service not registered yet — status refresh happens on wiring */
      }
    }
    return accepted
  })

  ipcMain.handle(IPC.voice.chatSend, (_event, req: ChatSendRequest) => {
    if (!req || typeof req.requestId !== 'string' || typeof req.text !== 'string') return
    const sanitized: ChatSendRequest = {
      requestId: req.requestId,
      text: req.text,
      history: Array.isArray(req.history) ? req.history : []
    }
    // Fire-and-forget: deltas stream over IPC.voice.chatDelta; errors surface as error deltas.
    void streamChatFallback(sanitized, (delta) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) win.webContents.send(IPC.voice.chatDelta, delta)
    })
  })

  ipcMain.handle(IPC.voice.executeTool, async (_event, req: { name: string; argsJson: string }) => {
    if (!req || typeof req.name !== 'string') {
      return { ok: false, resultJson: JSON.stringify({ error: 'Malformed tool request.' }) }
    }
    if (!deps.executeTool) {
      return {
        ok: false,
        resultJson: JSON.stringify({
          error: 'Connector tools are not available yet — the connectors service is not wired.'
        })
      }
    }
    try {
      return await deps.executeTool(req.name, req.argsJson ?? '{}')
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, resultJson: JSON.stringify({ error: msg }) }
    }
  })
}
