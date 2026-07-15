import { app } from 'electron'
import type { LocalVoiceEvent, LocalVoiceState } from '../../../shared/types'
import {
  LocalMacSpeechClient,
  resolveLocalMacSpeechExecutable,
  type LocalMacSpeechEvent,
  type VoiceStatusData
} from './localMacSpeech'

const REQUEST_TIMEOUT_MS = 12_000
const PERMISSION_TIMEOUT_MS = 120_000
const MAX_SPEECH_BYTES = 20_000
const MAX_LISTENING_MS = 30_000

type LocalVoiceListener = (event: LocalVoiceEvent) => void

interface PendingRequest {
  expected: ReadonlySet<LocalMacSpeechEvent['type']>
  resolve: (event: LocalMacSpeechEvent) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

/**
 * Owns the narrow macOS helper protocol and exposes semantic voice operations.
 * The renderer never sees the executable path or raw helper commands.
 */
export class LocalVoiceService {
  private client: LocalMacSpeechClient | null = null
  private launchPromise: Promise<LocalMacSpeechClient> | null = null
  private unsubscribe: (() => void) | null = null
  private readonly listeners = new Set<LocalVoiceListener>()
  private readonly pending = new Map<string, PendingRequest>()
  private operationChain: Promise<void> = Promise.resolve()
  private currentState: LocalVoiceState =
    process.platform === 'darwin' ? 'permission_unknown' : 'unavailable'
  private authorizationState: LocalVoiceState = this.currentState
  private listening = false
  private speaking = false
  private closed = false

  onEvent(listener: LocalVoiceListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async status(): Promise<LocalVoiceState> {
    try {
      const client = await this.ensureClient()
      const id = client.status()
      await this.waitFor(id, ['status'], REQUEST_TIMEOUT_MS)
      return this.currentState
    } catch {
      this.setState('unavailable')
      return this.currentState
    }
  }

  async requestPermission(): Promise<LocalVoiceState> {
    return this.enqueue(async () => {
      const client = await this.ensureClient()
      const id = client.requestPermission()
      await this.waitFor(id, ['permission'], PERMISSION_TIMEOUT_MS)
      const statusId = client.status()
      await this.waitFor(statusId, ['status'], REQUEST_TIMEOUT_MS)
      return this.currentState
    })
  }

  async startListening(): Promise<void> {
    return this.enqueue(async () => {
      const client = await this.ensureClient()
      if (this.listening) return
      if (this.speaking) await this.stopSpeakingNow(client)
      if (this.authorizationState !== 'ready') {
        throw new Error(
          this.authorizationState === 'permission_denied'
            ? 'Microphone or speech recognition permission was denied in System Settings.'
            : 'Enable microphone and speech recognition before talking to Jarvis.'
        )
      }
      const id = client.startListening({
        requireOnDevice: false,
        maxDurationMs: MAX_LISTENING_MS
      })
      await this.waitFor(id, ['listeningState'], REQUEST_TIMEOUT_MS)
    })
  }

  async stopListening(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.client || !this.listening) return
      const id = this.client.stopListening()
      await this.waitFor(id, ['listeningState'], REQUEST_TIMEOUT_MS)
    })
  }

  async cancelListening(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.client || !this.listening) return
      const id = this.client.cancelListening()
      await this.waitFor(id, ['listeningState'], REQUEST_TIMEOUT_MS)
    })
  }

  async speak(text: string): Promise<void> {
    const normalized = text.trim()
    if (!normalized) return
    if (Buffer.byteLength(normalized, 'utf8') > MAX_SPEECH_BYTES) {
      throw new Error('Speech text exceeds the local voice safety limit')
    }
    return this.enqueue(async () => {
      const client = await this.ensureClient()
      if (this.listening) await this.cancelListeningNow(client)
      if (this.speaking) await this.stopSpeakingNow(client)
      const id = client.speak({ text: normalized })
      await this.waitFor(id, ['speechState'], REQUEST_TIMEOUT_MS)
    })
  }

  async stopSpeaking(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.client || !this.speaking) return
      await this.stopSpeakingNow(this.client)
    })
  }

  async close(): Promise<void> {
    this.closed = true
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(new Error('Local voice service closed'))
    }
    this.pending.clear()
    this.unsubscribe?.()
    this.unsubscribe = null
    const client = this.client
    this.client = null
    this.launchPromise = null
    if (client) await client.close()
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation, operation)
    this.operationChain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private async ensureClient(): Promise<LocalMacSpeechClient> {
    if (this.closed) throw new Error('Local voice service is closed')
    if (this.client) return this.client
    if (this.launchPromise) return this.launchPromise
    this.launchPromise = (async () => {
      const executablePath = await resolveLocalMacSpeechExecutable({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        projectRoot: process.cwd(),
        architecture: process.arch,
        configuration: 'release'
      })
      const client = await LocalMacSpeechClient.launch({ executablePath })
      if (this.closed) {
        await client.close()
        throw new Error('Local voice service is closed')
      }
      this.client = client
      this.unsubscribe = client.subscribe((event) => this.handleNativeEvent(event))
      return client
    })()
    try {
      return await this.launchPromise
    } catch (error) {
      this.launchPromise = null
      throw error
    }
  }

  private waitFor(
    requestId: string,
    expected: readonly LocalMacSpeechEvent['type'][],
    timeoutMs: number
  ): Promise<LocalMacSpeechEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('Local speech helper did not respond in time'))
      }, timeoutMs)
      timer.unref()
      this.pending.set(requestId, { expected: new Set(expected), resolve, reject, timer })
    })
  }

  private handleNativeEvent(event: LocalMacSpeechEvent): void {
    if (event.type === 'status') this.applyStatus(event.data)
    if (event.type === 'permission') {
      this.authorizationState = authorizationToState(
        event.data.speechAuthorization,
        event.data.microphoneAuthorization,
        true
      )
      if (!this.listening && !this.speaking) this.setState(this.authorizationState)
    }
    if (event.type === 'listeningState') {
      if (event.data.state === 'started') {
        this.listening = true
        this.setState('listening')
      } else if (event.data.state === 'stopping') {
        this.setState('transcribing')
      } else {
        this.listening = false
        this.setState(this.authorizationState)
      }
    }
    if (event.type === 'speechState') {
      if (event.data.state === 'started') {
        this.speaking = true
        this.setState('speaking')
      } else {
        this.speaking = false
        this.setState(this.authorizationState)
      }
    }
    if (event.type === 'error' && !event.data.recoverable) this.setState('error')

    const mapped = mapEvent(event, this.currentState)
    if (mapped) this.emit(mapped)

    const requestId = event.requestId
    if (!requestId) {
      if (event.type === 'error' && event.data.code === 'helper_exited') {
        this.rejectAll(new Error(event.data.message))
      }
      return
    }
    const pending = this.pending.get(requestId)
    if (!pending) return
    if (event.type === 'error') {
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      if (isIdempotentError(event.data.code)) pending.resolve(event)
      else pending.reject(new Error(event.data.message))
      return
    }
    if (pending.expected.has(event.type)) {
      clearTimeout(pending.timer)
      this.pending.delete(requestId)
      pending.resolve(event)
    }
  }

  private applyStatus(status: VoiceStatusData): void {
    this.listening = status.listening
    this.speaking = status.speaking
    this.authorizationState = authorizationToState(
      status.speechAuthorization,
      status.microphoneAuthorization,
      status.recognizerAvailable
    )
    this.setState(
      this.listening ? 'listening' : this.speaking ? 'speaking' : this.authorizationState
    )
  }

  private async cancelListeningNow(client: LocalMacSpeechClient): Promise<void> {
    if (!this.listening) return
    const id = client.cancelListening()
    await this.waitFor(id, ['listeningState'], REQUEST_TIMEOUT_MS)
  }

  private async stopSpeakingNow(client: LocalMacSpeechClient): Promise<void> {
    if (!this.speaking) return
    const id = client.stopSpeaking()
    await this.waitFor(id, ['speechState'], REQUEST_TIMEOUT_MS)
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    this.pending.clear()
    this.client = null
    this.launchPromise = null
    this.unsubscribe?.()
    this.unsubscribe = null
    this.setState('unavailable')
  }

  private setState(state: LocalVoiceState): void {
    this.currentState = state
  }

  private emit(event: LocalVoiceEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

function authorizationToState(
  speech: string,
  microphone: string,
  recognizerAvailable: boolean
): LocalVoiceState {
  if (
    speech === 'denied' ||
    speech === 'restricted' ||
    microphone === 'denied' ||
    microphone === 'restricted'
  ) {
    return 'permission_denied'
  }
  if (speech !== 'authorized' || microphone !== 'authorized') return 'permission_unknown'
  return recognizerAvailable ? 'ready' : 'unavailable'
}

function mapEvent(event: LocalMacSpeechEvent, state: LocalVoiceState): LocalVoiceEvent | null {
  const base = {
    state,
    ...(event.requestId ? { requestId: event.requestId } : {})
  }
  switch (event.type) {
    case 'status':
    case 'permission':
    case 'ready':
      return { kind: 'status', ...base }
    case 'listeningState':
      return { kind: 'status', ...base, sessionId: event.data.sessionId }
    case 'transcript':
      return {
        kind: event.data.isFinal ? 'final' : 'partial',
        ...base,
        sessionId: event.data.sessionId,
        text: event.data.text
      }
    case 'speechState':
      return {
        kind: event.data.state === 'started' ? 'speech_started' : 'speech_finished',
        ...base,
        sessionId: event.data.sessionId
      }
    case 'error':
      if (isIdempotentError(event.data.code)) return null
      return {
        kind: 'error',
        ...base,
        code: event.data.code,
        message: event.data.message,
        recoverable: event.data.recoverable
      }
    case 'shutdown':
      return { kind: 'status', ...base }
  }
}

function isIdempotentError(code: string): boolean {
  return code === 'not_listening' || code === 'already_stopping' || code === 'not_speaking'
}
