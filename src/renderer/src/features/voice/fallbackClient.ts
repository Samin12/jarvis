/**
 * No-key fallback lane — text in, streamed ChatDeltas back from main (ChatGPT token lane),
 * spoken out through speechSynthesis with a native macOS voice.
 * Presents the same TranscriptEntry surface as the realtime client.
 */
import type { CoreMode, TranscriptEntry } from '../../../../shared/types'

const SPEECH_RATE = 1.05
const MAX_HISTORY_TURNS = 24
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
  private events: FallbackClientEvents
  private unsubscribe: (() => void) | null = null
  private pending = new Map<string, PendingTurn>()
  private history: { role: 'user' | 'assistant'; text: string }[] = []
  private cachedVoice: SpeechSynthesisVoice | null = null
  private speaking = false
  private closed = false

  constructor(events: FallbackClientEvents = {}) {
    this.events = events
  }

  start(): void {
    if (this.unsubscribe) return
    this.unsubscribe = window.jarvis.voice.onChatDelta((delta) => {
      const turn = this.pending.get(delta.requestId)
      if (!turn) return
      if (delta.kind === 'text_delta') {
        turn.text += delta.text ?? ''
        this.events.onPartialTranscript?.({ id: turn.entryId, role: 'jarvis', text: turn.text })
      } else if (delta.kind === 'done') {
        this.pending.delete(delta.requestId)
        this.completeTurn(turn)
      } else if (delta.kind === 'error') {
        this.pending.delete(delta.requestId)
        this.events.onError?.(delta.error ?? 'Chat request failed.')
        this.events.onCoreMode?.('idle')
      }
    })
    // Chromium loads speechSynthesis voices asynchronously.
    window.speechSynthesis?.addEventListener?.('voiceschanged', this.refreshVoice)
    this.refreshVoice()
  }

  /** One user turn: emits the user transcript entry, streams the reply, then speaks it. */
  send(text: string): void {
    const trimmed = text.trim()
    if (!trimmed || this.closed) return
    this.events.onTranscript?.({ id: entryId(), role: 'user', text: trimmed, at: Date.now() })
    this.events.onCoreMode?.('working')

    const requestId = crypto.randomUUID()
    this.pending.set(requestId, { entryId: entryId(), text: '' })
    const history = this.history.slice(-MAX_HISTORY_TURNS)
    this.history.push({ role: 'user', text: trimmed })
    void window.jarvis.voice.chatSend({ requestId, text: trimmed, history }).catch((err) => {
      this.pending.delete(requestId)
      this.events.onError?.(err instanceof Error ? err.message : String(err))
      this.events.onCoreMode?.('idle')
    })
  }

  /** Synthetic 0..1 level for the orb — speechSynthesis exposes no analyser. */
  getLevel(): number {
    if (!this.speaking) return 0
    const t = performance.now()
    return 0.3 + 0.2 * Math.abs(Math.sin(t / 170)) + 0.15 * Math.abs(Math.sin(t / 61))
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.unsubscribe?.()
    this.unsubscribe = null
    this.pending.clear()
    window.speechSynthesis?.removeEventListener?.('voiceschanged', this.refreshVoice)
    try {
      window.speechSynthesis?.cancel()
    } catch {
      /* nothing to cancel */
    }
    this.speaking = false
  }

  // ---------- internals ----------

  private completeTurn(turn: PendingTurn): void {
    const text = turn.text.trim()
    if (!text) {
      this.events.onCoreMode?.('idle')
      return
    }
    this.history.push({ role: 'assistant', text })
    this.events.onTranscript?.({ id: turn.entryId, role: 'jarvis', text, at: Date.now() })
    this.speak(text)
  }

  private refreshVoice = (): void => {
    const synth = window.speechSynthesis
    if (!synth) return
    const voices = synth.getVoices()
    if (voices.length === 0) return
    for (const name of PREFERRED_VOICES) {
      const match = voices.find((v) => v.name === name)
      if (match) {
        this.cachedVoice = match
        return
      }
    }
    this.cachedVoice =
      voices.find((v) => v.lang === 'en-US') ??
      voices.find((v) => v.lang.startsWith('en')) ??
      voices[0] ??
      null
  }

  private speak(text: string): void {
    const synth = window.speechSynthesis
    if (!synth) {
      this.events.onCoreMode?.('idle')
      return
    }
    synth.cancel() // barge-in: a new reply supersedes whatever is still playing
    if (!this.cachedVoice) this.refreshVoice()
    const utterance = new SpeechSynthesisUtterance(text)
    if (this.cachedVoice) utterance.voice = this.cachedVoice
    utterance.rate = SPEECH_RATE
    utterance.onstart = (): void => {
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
