export const LOCAL_MAC_SPEECH_PROTOCOL_VERSION = 1
export const LOCAL_MAC_SPEECH_MAX_LINE_BYTES = 64 * 1024

export type AuthorizationState =
  'notDetermined' | 'restricted' | 'denied' | 'authorized' | 'unknown'

interface VoiceEvent<Type extends string, Data> {
  type: Type
  protocolVersion: 1
  requestId?: string
  timestampMs: number
  data: Data
}

export interface ReadyData {
  helperVersion: string
  processId: number
  architecture: string
  capabilities: string[]
  maximumLineBytes: number
  maximumListeningDurationMs: number
  maximumTextBytes: number
}

export interface VoiceStatusData {
  speechAuthorization: AuthorizationState
  microphoneAuthorization: AuthorizationState
  recognizerAvailable: boolean
  supportsOnDeviceRecognition: boolean
  locale: string
  listening: boolean
  speaking: boolean
}

export interface PermissionData {
  speechAuthorization: AuthorizationState
  microphoneAuthorization: AuthorizationState
}

export interface ListeningStateData {
  state: 'started' | 'stopping' | 'stopped' | 'cancelled' | 'failed'
  sessionId: string
  startRequestId: string
  reason?: string
}

export interface TranscriptData {
  sessionId: string
  text: string
  isFinal: boolean
}

export interface SpeechStateData {
  state: 'started' | 'finished' | 'cancelled'
  sessionId: string
  speakRequestId: string
  reason?: string
}

export interface VoiceErrorData {
  code: string
  message: string
  recoverable: boolean
  domain?: string
  nativeCode?: number
}

export type LocalMacSpeechEvent =
  | VoiceEvent<'ready', ReadyData>
  | VoiceEvent<'status', VoiceStatusData>
  | VoiceEvent<'permission', PermissionData>
  | VoiceEvent<'listeningState', ListeningStateData>
  | VoiceEvent<'transcript', TranscriptData>
  | VoiceEvent<'speechState', SpeechStateData>
  | VoiceEvent<'error', VoiceErrorData>
  | VoiceEvent<'shutdown', { reason: string }>

export interface StartListeningOptions {
  locale?: string
  requireOnDevice?: boolean
  maxDurationMs?: number
}

export interface SpeakOptions {
  text: string
  voiceIdentifier?: string
  /** Normalized rate in the inclusive range 0...1. */
  rate?: number
  pitch?: number
  volume?: number
}

export type LocalMacSpeechCommand =
  | { id: string; type: 'status' }
  | { id: string; type: 'permission' }
  | ({ id: string; type: 'start' } & StartListeningOptions)
  | { id: string; type: 'stop' }
  | { id: string; type: 'cancel' }
  | ({ id: string; type: 'speak' } & SpeakOptions)
  | { id: string; type: 'stopSpeaking' }
  | { id: string; type: 'shutdown' }

type UnknownRecord = Record<string, unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(record: UnknownRecord, key: string): string {
  const value = record[key]
  if (typeof value !== 'string') throw new Error(`Invalid ${key}`)
  return value
}

function readOptionalString(record: UnknownRecord, key: string): string | undefined {
  const value = record[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new Error(`Invalid ${key}`)
  return value
}

function readBoolean(record: UnknownRecord, key: string): boolean {
  const value = record[key]
  if (typeof value !== 'boolean') throw new Error(`Invalid ${key}`)
  return value
}

function readNumber(record: UnknownRecord, key: string): number {
  const value = record[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid ${key}`)
  return value
}

function readOptionalNumber(record: UnknownRecord, key: string): number | undefined {
  if (record[key] === undefined) return undefined
  return readNumber(record, key)
}

function readAuthorization(record: UnknownRecord, key: string): AuthorizationState {
  const value = readString(record, key)
  const allowed: readonly AuthorizationState[] = [
    'notDetermined',
    'restricted',
    'denied',
    'authorized',
    'unknown'
  ]
  if (!allowed.includes(value as AuthorizationState)) throw new Error(`Invalid ${key}`)
  return value as AuthorizationState
}

function readStringArray(record: UnknownRecord, key: string): string[] {
  const value = record[key]
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new Error(`Invalid ${key}`)
  }
  return value
}

function decodeBase(value: UnknownRecord): {
  requestId?: string
  timestampMs: number
  data: UnknownRecord
} {
  if (value.protocolVersion !== LOCAL_MAC_SPEECH_PROTOCOL_VERSION) {
    throw new Error('Unsupported local speech protocol version')
  }
  const requestId = readOptionalString(value, 'requestId')
  const timestampMs = readNumber(value, 'timestampMs')
  if (!isRecord(value.data)) throw new Error('Invalid event data')
  return { requestId, timestampMs, data: value.data }
}

function envelope<Type extends LocalMacSpeechEvent['type'], Data>(
  type: Type,
  base: { requestId?: string; timestampMs: number },
  data: Data
): VoiceEvent<Type, Data> {
  return {
    type,
    protocolVersion: LOCAL_MAC_SPEECH_PROTOCOL_VERSION,
    ...(base.requestId ? { requestId: base.requestId } : {}),
    timestampMs: base.timestampMs,
    data
  }
}

/** Strictly validates an event before it crosses into the Electron main process. */
export function decodeLocalMacSpeechEvent(value: unknown): LocalMacSpeechEvent {
  if (!isRecord(value)) throw new Error('Voice event must be an object')
  const type = readString(value, 'type')
  const base = decodeBase(value)
  const data = base.data

  switch (type) {
    case 'ready':
      return envelope(type, base, {
        helperVersion: readString(data, 'helperVersion'),
        processId: readNumber(data, 'processId'),
        architecture: readString(data, 'architecture'),
        capabilities: readStringArray(data, 'capabilities'),
        maximumLineBytes: readNumber(data, 'maximumLineBytes'),
        maximumListeningDurationMs: readNumber(data, 'maximumListeningDurationMs'),
        maximumTextBytes: readNumber(data, 'maximumTextBytes')
      })
    case 'status':
      return envelope(type, base, {
        speechAuthorization: readAuthorization(data, 'speechAuthorization'),
        microphoneAuthorization: readAuthorization(data, 'microphoneAuthorization'),
        recognizerAvailable: readBoolean(data, 'recognizerAvailable'),
        supportsOnDeviceRecognition: readBoolean(data, 'supportsOnDeviceRecognition'),
        locale: readString(data, 'locale'),
        listening: readBoolean(data, 'listening'),
        speaking: readBoolean(data, 'speaking')
      })
    case 'permission':
      return envelope(type, base, {
        speechAuthorization: readAuthorization(data, 'speechAuthorization'),
        microphoneAuthorization: readAuthorization(data, 'microphoneAuthorization')
      })
    case 'listeningState': {
      const state = readString(data, 'state')
      if (!['started', 'stopping', 'stopped', 'cancelled', 'failed'].includes(state)) {
        throw new Error('Invalid listening state')
      }
      return envelope(type, base, {
        state: state as ListeningStateData['state'],
        sessionId: readString(data, 'sessionId'),
        startRequestId: readString(data, 'startRequestId'),
        reason: readOptionalString(data, 'reason')
      })
    }
    case 'transcript':
      return envelope(type, base, {
        sessionId: readString(data, 'sessionId'),
        text: readString(data, 'text'),
        isFinal: readBoolean(data, 'isFinal')
      })
    case 'speechState': {
      const state = readString(data, 'state')
      if (!['started', 'finished', 'cancelled'].includes(state)) {
        throw new Error('Invalid speech state')
      }
      return envelope(type, base, {
        state: state as SpeechStateData['state'],
        sessionId: readString(data, 'sessionId'),
        speakRequestId: readString(data, 'speakRequestId'),
        reason: readOptionalString(data, 'reason')
      })
    }
    case 'error':
      return envelope(type, base, {
        code: readString(data, 'code'),
        message: readString(data, 'message'),
        recoverable: readBoolean(data, 'recoverable'),
        domain: readOptionalString(data, 'domain'),
        nativeCode: readOptionalNumber(data, 'nativeCode')
      })
    case 'shutdown':
      return envelope(type, base, { reason: readString(data, 'reason') })
    default:
      throw new Error(`Unsupported voice event type: ${type}`)
  }
}
