import type { BrowserWindow, IpcMain } from 'electron'
import { IPC } from '../../../shared/ipc'
import type { RealtimeStartRequest, RealtimeStopRequest, VoiceLane } from '../../../shared/types'
import { assertPlainObject, registerTrustedHandler, requireString } from '../../security'
import type { JarvisCoreService } from '../core'
import { LocalVoiceService } from './localVoiceService'

export interface VoiceServiceDeps {
  core: JarvisCoreService
}

export interface RegisteredVoiceService {
  local: LocalVoiceService
  close(): Promise<void>
}

/** Register only the narrow, trusted voice bridge exposed by preload. */
export function registerVoice(
  ipcMain: IpcMain,
  getWindow: () => BrowserWindow | null,
  deps: VoiceServiceDeps
): RegisteredVoiceService {
  const local = new LocalVoiceService()

  registerTrustedHandler(ipcMain, IPC.voice.laneAvailable, getWindow, (): VoiceLane =>
    deps.core.canStartRealtime() ? 'realtime' : 'fallback'
  )

  registerTrustedHandler(ipcMain, IPC.voice.realtimeStart, getWindow, (_event, raw: unknown) =>
    deps.core.startRealtime(parseRealtimeStart(raw))
  )
  registerTrustedHandler(ipcMain, IPC.voice.realtimeStop, getWindow, (_event, raw: unknown) =>
    deps.core.stopRealtime(parseRealtimeStop(raw), 'client_stop')
  )

  registerTrustedHandler(ipcMain, IPC.voice.localStatus, getWindow, () => local.status())
  registerTrustedHandler(ipcMain, IPC.voice.localPermission, getWindow, () =>
    local.requestPermission()
  )
  registerTrustedHandler(ipcMain, IPC.voice.localStart, getWindow, () => local.startListening())
  registerTrustedHandler(ipcMain, IPC.voice.localStop, getWindow, () => local.stopListening())
  registerTrustedHandler(ipcMain, IPC.voice.localCancel, getWindow, () => local.cancelListening())
  registerTrustedHandler(ipcMain, IPC.voice.localSpeak, getWindow, (_event, raw: unknown) => {
    if (typeof raw !== 'string') throw new Error('Speech text must be a string')
    return local.speak(raw)
  })
  registerTrustedHandler(ipcMain, IPC.voice.localStopSpeaking, getWindow, () =>
    local.stopSpeaking()
  )

  local.onEvent((event) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.voice.localEvent, event)
  })
  const offRealtime = deps.core.onRealtimeEvent((event) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) window.webContents.send(IPC.voice.realtimeEvent, event)
  })

  return {
    local,
    close: async () => {
      offRealtime()
      await Promise.allSettled([
        deps.core.stopRealtime(undefined, 'voice_service_close'),
        local.close()
      ])
    }
  }
}

const MAX_SDP_CHARS = 256 * 1024

function parseRealtimeStart(raw: unknown): RealtimeStartRequest {
  assertPlainObject(raw, { name: 'realtime start', maxBytes: MAX_SDP_CHARS + 4_096 })
  const requestId = requireString(raw.requestId, 'requestId', 128)
  const offerSdp = requireSdp(raw.offerSdp, 'offerSdp')
  return { requestId, offerSdp }
}

function parseRealtimeStop(raw: unknown): RealtimeStopRequest {
  assertPlainObject(raw, { name: 'realtime stop', maxBytes: 2_048 })
  const requestId = requireString(raw.requestId, 'requestId', 128)
  if (raw.sessionId === undefined) return { requestId }
  return { requestId, sessionId: requireString(raw.sessionId, 'sessionId', 128) }
}

function requireSdp(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`)
  if (value.length > MAX_SDP_CHARS) throw new Error(`${name} exceeds the safety limit`)
  if (!value.startsWith('v=') || value.includes('\0')) throw new Error(`${name} is malformed`)
  return value
}
