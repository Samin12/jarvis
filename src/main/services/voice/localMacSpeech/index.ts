export { LocalMacSpeechClient } from './client'
export type { LocalMacSpeechLaunchOptions, LocalMacSpeechListener } from './client'
export { resolveLocalMacSpeechExecutable } from './resolver'
export type { LocalMacSpeechResolveOptions } from './resolver'
export {
  decodeLocalMacSpeechEvent,
  LOCAL_MAC_SPEECH_MAX_LINE_BYTES,
  LOCAL_MAC_SPEECH_PROTOCOL_VERSION
} from './protocol'
export type {
  AuthorizationState,
  ListeningStateData,
  LocalMacSpeechEvent,
  PermissionData,
  ReadyData,
  SpeakOptions,
  SpeechStateData,
  StartListeningOptions,
  TranscriptData,
  VoiceErrorData,
  VoiceStatusData
} from './protocol'
