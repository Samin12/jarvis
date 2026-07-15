/**
 * Default no-key lane: native macOS push-to-talk + app-server conversation +
 * native TTS. Browser speechSynthesis remains a recovery path only.
 */
import type {
  ConversationDelta,
  CoreMode,
  LocalVoiceEvent,
  LocalVoiceState,
  TranscriptEntry
} from '../../../../shared/types'

const SPEECH_RATE = 1.05
const PREFERRED_VOICES = [
  'Samantha',
  'Ava (Premium)',
  'Ava',
  'Allison',
  'Zoe',
  'Evan',
  'Daniel',
  'Google US English'
]

export interface FallbackClientEvents {
  onCoreMode?: (mode: CoreMode) => void
  onTranscript?: (entry: TranscriptEntry) => void
  onPartialTranscript?: (partial: { id: string; role: 'user' | 'jarvis'; text: string }) => void
  onLocalState?: (state: LocalVoiceState) => void
  onMicOpen?: (open: boolean) => void
  onError?: (message: string) => void
}

interface PendingTurn {
  entryId: string
  text: string
}

function entryId(): string {
  return crypto.randomUUID()
}

export class FallbackVoiceClient {
  private readonly events: FallbackClientEvents
  private unsubscribeCore: (() => void) | null = null
  private unsubscribeLocal: (() => void) | null = null
  private pending = new Map<string, PendingTurn>()
  private transcriptIds = new Map<string, string>()
  private cachedVoice: SpeechSynthesisVoice | null = null
  private localState: LocalVoiceState = 'unavailable'
  private speaking = false
  private desiredListening = false
  private closed = false

  constructor(events: FallbackClientEvents = {}) {
    this.events = events
  }

  async start(): Promise<void> {
    if (this.unsubscribeCore) return
    this.unsubscribeCore = window.jarvis.core.onDelta((delta) => this.handleCoreDelta(delta))
    this.unsubscribeLocal = window.jarvis.voice.onLocalEvent((event) =>
      this.handleLocalEvent(event)
    )
    window.speechSynthesis?.addEventListener?.('voiceschanged', this.refreshVoice)
    this.refreshVoice()
    this.localState = await window.jarvis.voice.localStatus().catch(() => 'unavailable')
    if (this.closed) return
    if (this.localState === 'permission_unknown') {
      // Make typed Jarvis available immediately while macOS owns its permission
      // sheet. That sheet can remain open for minutes and must not make Engage
      // look frozen or hide the text fallback.
      this.events.onLocalState?.(this.localState)
      void window.jarvis.voice
        .localPermission()
        .then((state) => {
          if (this.closed) return
          this.localState = state
          this.events.onLocalState?.(state)
        })
        .catch(() => {
          if (this.closed) return
          this.localState = 'unavailable'
          this.events.onLocalState?.('unavailable')
        })
      return
    }
    if (this.closed) return
    this.events.onLocalState?.(this.localState)
  }

  /** One user turn. Voice finals can suppress the duplicate user transcript. */
  send(text: string, emitUser = true): void {
    const trimmed = text.trim()
    if (!trimmed || this.closed) return
    if (this.pending.size > 0) {
      this.events.onError?.(
        'Jarvis is still answering. Wait for the current reply or stop it first.'
      )
      return
    }
    if (emitUser) {
      this.events.onTranscript?.({ id: entryId(), role: 'user', text: trimmed, at: Date.now() })
    }
    this.events.onCoreMode?.('working')
    const requestId = crypto.randomUUID()
    this.pending.set(requestId, { entryId: entryId(), text: '' })
    void window.jarvis.core.send({ requestId, text: trimmed }).catch((error) => {
      this.pending.delete(requestId)
      if (this.closed) return
      this.events.onError?.(error instanceof Error ? error.message : String(error))
      this.events.onCoreMode?.('idle')
    })
  }

  async startListening(): Promise<void> {
    if (this.closed || (this.localState !== 'ready' && this.localState !== 'speaking')) return
    this.desiredListening = true
    try {
      await window.jarvis.voice.localStart()
      if (!this.desiredListening) await window.jarvis.voice.localStop()
    } catch (error) {
      if (this.desiredListening) {
        this.events.onError?.(error instanceof Error ? error.message : String(error))
      }
    }
  }

  async stopListening(): Promise<void> {
    this.desiredListening = false
    await window.jarvis.voice.localStop().catch(() => undefined)
  }

  async cancelListening(): Promise<void> {
    this.desiredListening = false
    await window.jarvis.voice.localCancel().catch(() => undefined)
  }

  announceSystemUpdate(text: string): void {
    const trimmed = text.trim()
    if (!trimmed || this.closed) return
    this.events.onTranscript?.({ id: entryId(), role: 'jarvis', text: trimmed, at: Date.now() })
    this.speak(trimmed)
  }

  getLocalState(): LocalVoiceState {
    return this.localState
  }

  getLevel(): number {
    if (!this.speaking && this.localState !== 'listening') return 0
    const t = performance.now()
    return 0.3 + 0.2 * Math.abs(Math.sin(t / 170)) + 0.15 * Math.abs(Math.sin(t / 61))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.desiredListening = false
    this.unsubscribeCore?.()
    this.unsubscribeLocal?.()
    this.unsubscribeCore = null
    this.unsubscribeLocal = null
    for (const requestId of this.pending.keys()) {
      void window.jarvis.core.cancel(requestId).catch(() => undefined)
    }
    this.pending.clear()
    this.transcriptIds.clear()
    void window.jarvis.voice.localCancel().catch(() => undefined)
    void window.jarvis.voice.localStopSpeaking().catch(() => undefined)
    window.speechSynthesis?.removeEventListener?.('voiceschanged', this.refreshVoice)
    window.speechSynthesis?.cancel()
    this.speaking = false
  }

  private handleCoreDelta(delta: ConversationDelta): void {
    if (this.closed) return
    const turn = this.pending.get(delta.requestId)
    if (!turn) return
    if (delta.kind === 'text_delta') {
      turn.text += delta.text ?? ''
      this.events.onPartialTranscript?.({ id: turn.entryId, role: 'jarvis', text: turn.text })
      return
    }
    if (delta.kind === 'done') {
      this.pending.delete(delta.requestId)
      this.completeTurn(turn)
      return
    }
    if (delta.kind === 'error' || delta.kind === 'blocked') {
      this.pending.delete(delta.requestId)
      this.events.onError?.(delta.error ?? 'Jarvis could not complete the response.')
      this.events.onCoreMode?.('idle')
    }
  }

  private handleLocalEvent(event: LocalVoiceEvent): void {
    if (this.closed) return
    this.localState = event.state
    this.events.onLocalState?.(event.state)
    if (event.kind === 'status') {
      this.events.onMicOpen?.(event.state === 'listening')
      if (event.state === 'listening') this.events.onCoreMode?.('listening')
      else if (event.state === 'transcribing') this.events.onCoreMode?.('working')
      return
    }
    if ((event.kind === 'partial' || event.kind === 'final') && event.text) {
      const sessionId = event.sessionId ?? event.requestId ?? 'local'
      const id = this.transcriptIds.get(sessionId) ?? entryId()
      this.transcriptIds.set(sessionId, id)
      if (event.kind === 'partial') {
        this.events.onPartialTranscript?.({ id, role: 'user', text: event.text })
      } else {
        this.transcriptIds.delete(sessionId)
        this.events.onTranscript?.({ id, role: 'user', text: event.text, at: Date.now() })
        this.send(event.text, false)
      }
      return
    }
    if (event.kind === 'speech_started') {
      this.speaking = true
      this.events.onCoreMode?.('speaking')
      return
    }
    if (event.kind === 'speech_finished') {
      this.speaking = false
      this.events.onCoreMode?.('idle')
      return
    }
    if (event.kind === 'error') {
      this.events.onError?.(event.message ?? 'Local voice failed.')
    }
  }

  private completeTurn(turn: PendingTurn): void {
    if (this.closed) return
    const text = turn.text.trim()
    if (!text) {
      this.events.onCoreMode?.('idle')
      return
    }
    this.events.onTranscript?.({ id: turn.entryId, role: 'jarvis', text, at: Date.now() })
    this.speak(text)
  }

  private speak(text: string): void {
    if (this.closed) return
    if (this.localState !== 'unavailable' && this.localState !== 'permission_denied') {
      void window.jarvis.voice.localSpeak(text).catch(() => {
        if (!this.closed) this.speakInBrowser(text)
      })
      return
    }
    this.speakInBrowser(text)
  }

  private refreshVoice = (): void => {
    const synth = window.speechSynthesis
    if (!synth) return
    const voices = synth.getVoices()
    if (voices.length === 0) return
    for (const name of PREFERRED_VOICES) {
      const match = voices.find((voice) => voice.name === name)
      if (match) {
        this.cachedVoice = match
        return
      }
    }
    this.cachedVoice =
      voices.find((voice) => voice.lang === 'en-US') ??
      voices.find((voice) => voice.lang.startsWith('en')) ??
      voices[0] ??
      null
  }

  private speakInBrowser(text: string): void {
    if (this.closed) return
    const synth = window.speechSynthesis
    if (!synth) {
      this.events.onCoreMode?.('idle')
      return
    }
    synth.cancel()
    if (!this.cachedVoice) this.refreshVoice()
    const utterance = new SpeechSynthesisUtterance(text)
    if (this.cachedVoice) utterance.voice = this.cachedVoice
    utterance.rate = SPEECH_RATE
    utterance.onstart = (): void => {
      if (this.closed) return
      this.speaking = true
      this.events.onCoreMode?.('speaking')
    }
    const settle = (): void => {
      this.speaking = false
      if (!this.closed) this.events.onCoreMode?.('idle')
    }
    utterance.onend = settle
    utterance.onerror = settle
    synth.speak(utterance)
  }
}
