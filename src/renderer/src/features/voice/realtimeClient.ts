/**
 * Realtime WebRTC lane — renderer client.
 * The renderer owns microphone/media only. The pinned Codex app-server owns
 * ChatGPT authentication, session policy, tools, and the SDP exchange.
 */
import type { CoreMode, RealtimeHostEvent, TranscriptEntry } from '../../../../shared/types'

/** Sessions hard-cap at 60 minutes — ask the orchestrator to reconnect before that. */
const RECONNECT_BEFORE_MS = 55 * 60 * 1000
const MAX_DATA_CHANNEL_EVENT_CHARS = 256 * 1024
const MAX_OUTGOING_EVENT_CHARS = 64 * 1024
const MAX_USER_TEXT_CHARS = 16 * 1024
const EXPECTED_HOST_CLOSE_REASONS = new Set([
  'account_logout',
  'account_signed_out',
  'account_changed',
  'core_stopped',
  'voice_service_close'
])
type ServerEvent = { type?: string } & Record<string, unknown>

export interface RealtimeClientEvents {
  onCoreMode?: (mode: CoreMode) => void
  onTranscript?: (entry: TranscriptEntry) => void
  /** Streaming (not yet final) transcript text, keyed by a stable id. */
  onPartialTranscript?: (partial: { id: string; role: 'user' | 'jarvis'; text: string }) => void
  onError?: (message: string) => void
  /** Fired ~5 minutes before the 60-minute session cap — reconnect now. */
  onSessionExpiring?: () => void
  onClosed?: (unexpected: boolean) => void
}

function entryId(): string {
  return crypto.randomUUID()
}

export class RealtimeVoiceClient {
  private events: RealtimeClientEvents
  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private micStream: MediaStream | null = null
  private micTrack: MediaStreamTrack | null = null
  private audioEl: HTMLAudioElement | null = null
  private audioCtx: AudioContext | null = null
  private outAnalyser: AnalyserNode | null = null
  private micAnalyser: AnalyserNode | null = null
  private levelBuf: Uint8Array<ArrayBuffer> = new Uint8Array(1024)
  private reconnectTimer: number | null = null
  private readonly requestId = crypto.randomUUID()
  private sessionId: string | null = null
  private offHostEvent: (() => void) | null = null
  private closed = false
  private connected = false
  private mode: CoreMode = 'idle'
  /** Serialize response.create — the server rejects one while another response is active. */
  private responseActive = false
  private responseQueued = false
  private userPartials = new Map<string, { id: string; text: string }>()
  private assistantPartials = new Map<string, { id: string; text: string }>()

  constructor(events: RealtimeClientEvents = {}) {
    this.events = events
  }

  get micEnabled(): boolean {
    return this.micTrack?.enabled ?? false
  }

  /** Push-to-talk gate: the mic track starts muted; hold-to-talk enables it. */
  setMicEnabled(on: boolean): void {
    if (this.micTrack) this.micTrack.enabled = on
    if (!on && this.mode === 'listening') this.setMode('idle')
  }

  async connect(): Promise<void> {
    const micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    if (this.closed) {
      micStream.getTracks().forEach((track) => track.stop())
      throw new Error('Voice startup was cancelled.')
    }
    this.micStream = micStream
    this.micTrack = micStream.getAudioTracks()[0] ?? null
    if (!this.micTrack) {
      micStream.getTracks().forEach((track) => track.stop())
      this.micStream = null
      throw new Error('No microphone track available.')
    }
    this.micTrack.enabled = false // push-to-talk: closed until held open

    const pc = new RTCPeerConnection()
    this.pc = pc
    pc.addTrack(this.micTrack, micStream)

    this.audioEl = document.createElement('audio')
    this.audioEl.autoplay = true
    pc.ontrack = (e): void => {
      const stream = e.streams[0] ?? new MediaStream([e.track])
      if (!this.audioEl) return
      this.audioEl.srcObject = stream
      void this.audioEl.play().catch(() => undefined)
      this.attachAnalysers(stream)
    }
    pc.onconnectionstatechange = (): void => {
      if (this.closed) return
      const state = pc.connectionState
      // 'disconnected' is transient — ICE usually recovers within seconds;
      // only 'failed'/'closed' are terminal.
      if (state === 'failed' || state === 'closed') {
        this.events.onError?.(`Voice connection ${state}.`)
        this.closeInternal(true)
      }
    }

    const dc = pc.createDataChannel('oai-events')
    this.dc = dc
    const dataChannelReady = waitForDataChannelOpen(dc, 15_000)
    // Startup can still be awaiting the main-process SDP exchange when this
    // rejects; attach a handler now and await the same promise below.
    void dataChannelReady.catch(() => {
      if (!this.closed) this.closeInternal(true)
    })
    dc.addEventListener('message', (e) => {
      if (
        this.closed ||
        typeof e.data !== 'string' ||
        e.data.length > MAX_DATA_CHANNEL_EVENT_CHARS
      ) {
        return
      }
      try {
        this.handleServerEvent(JSON.parse(e.data) as ServerEvent)
      } catch {
        // non-JSON payloads are ignored
      }
    })
    dc.addEventListener('close', () => {
      if (this.closed) return
      this.events.onError?.('The live voice event channel closed.')
      this.closeInternal(true)
    })
    dc.addEventListener('error', () => {
      if (this.closed) return
      this.events.onError?.('The live voice event channel failed.')
      this.closeInternal(true)
    })
    // The app-server owns instructions, tool policy, startup context, and the
    // authenticated session sideband; the renderer never overrides them.

    this.offHostEvent = window.jarvis.voice.onRealtimeEvent((event) => this.handleHostEvent(event))

    const offer = await pc.createOffer()
    this.assertOpen()
    await pc.setLocalDescription(offer)
    this.assertOpen()
    const offerSdp = pc.localDescription?.sdp
    if (!offerSdp) throw new Error('The microphone connection did not produce an SDP offer.')
    const result = await window.jarvis.voice.realtimeStart({
      requestId: this.requestId,
      offerSdp
    })
    if (this.closed) {
      void window.jarvis.voice.realtimeStop({ requestId: this.requestId }).catch(() => undefined)
      throw new Error('Voice startup was cancelled.')
    }
    this.sessionId = result.sessionId
    await pc.setRemoteDescription({ type: 'answer', sdp: result.answerSdp })
    await dataChannelReady
    if (this.closed) throw new Error('Voice startup was cancelled.')
    this.connected = true

    this.reconnectTimer = window.setTimeout(() => {
      if (!this.closed) this.events.onSessionExpiring?.()
    }, RECONNECT_BEFORE_MS)
  }

  /** Inject a typed user turn (greeting button, mixed text input) and ask for a response. */
  sendUserText(text: string): void {
    const trimmed = text.trim().slice(0, MAX_USER_TEXT_CHARS)
    if (!trimmed || !this.dc || this.dc.readyState !== 'open') return
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: trimmed }]
      }
    })
    this.requestResponse()
    this.events.onTranscript?.({
      id: entryId(),
      role: 'user',
      text: trimmed,
      at: Date.now()
    })
    this.setMode('working')
  }

  /**
   * Inject an out-of-band system update (e.g. a Codex task finishing) into the
   * conversation and have the model speak it (research gpt-live-voice.md §2.8).
   */
  announceSystemUpdate(text: string): void {
    const trimmed = text.trim().slice(0, MAX_USER_TEXT_CHARS)
    if (!trimmed || !this.dc || this.dc.readyState !== 'open') return
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: trimmed }]
      }
    })
    this.requestResponse()
  }

  /** 0..1 output/mic level for the orb. */
  getLevel(): number {
    const out = this.readLevel(this.outAnalyser)
    const mic = this.micEnabled ? this.readLevel(this.micAnalyser) : 0
    return Math.max(out, mic)
  }

  close(): void {
    this.closeInternal(false)
  }

  private closeInternal(unexpected: boolean): void {
    if (this.closed) return
    const wasConnected = this.connected
    this.closed = true
    this.connected = false
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.offHostEvent?.()
    this.offHostEvent = null
    void window.jarvis.voice
      .realtimeStop({
        requestId: this.requestId,
        ...(this.sessionId ? { sessionId: this.sessionId } : {})
      })
      .catch(() => undefined)
    this.sessionId = null
    try {
      this.dc?.close()
    } catch {
      /* already closed */
    }
    this.dc = null
    try {
      this.pc?.close()
    } catch {
      /* already closed */
    }
    this.pc = null
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.micStream = null
    this.micTrack = null
    if (this.audioEl) {
      this.audioEl.srcObject = null
      this.audioEl = null
    }
    void this.audioCtx?.close().catch(() => undefined)
    this.audioCtx = null
    this.outAnalyser = null
    this.micAnalyser = null
    this.userPartials.clear()
    this.assistantPartials.clear()
    this.responseActive = false
    this.responseQueued = false
    this.setMode('idle')
    this.events.onClosed?.(unexpected && wasConnected)
  }

  // ---------- internals ----------

  private assertOpen(): void {
    if (this.closed) throw new Error('Voice startup was cancelled.')
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.dc || this.dc.readyState !== 'open') return
    const encoded = JSON.stringify(payload)
    if (encoded.length <= MAX_OUTGOING_EVENT_CHARS) this.dc.send(encoded)
  }

  /**
   * Ask for a model response, deferring while another response is active —
   * two back-to-back response.create events (e.g. parallel function-call
   * outputs) would otherwise error with conversation_already_has_active_response.
   */
  private requestResponse(): void {
    if (this.responseActive) {
      this.responseQueued = true
      return
    }
    this.responseActive = true
    this.send({ type: 'response.create' })
  }

  private setMode(mode: CoreMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.events.onCoreMode?.(mode)
  }

  private attachAnalysers(remoteStream: MediaStream): void {
    try {
      this.audioCtx = new AudioContext()
      this.outAnalyser = this.audioCtx.createAnalyser()
      this.outAnalyser.fftSize = 2048
      this.audioCtx.createMediaStreamSource(remoteStream).connect(this.outAnalyser)
      if (this.micStream) {
        this.micAnalyser = this.audioCtx.createAnalyser()
        this.micAnalyser.fftSize = 2048
        this.audioCtx.createMediaStreamSource(this.micStream).connect(this.micAnalyser)
      }
    } catch {
      // level metering is cosmetic — never fail the session over it
    }
  }

  private readLevel(analyser: AnalyserNode | null): number {
    if (!analyser) return 0
    const len = Math.min(analyser.fftSize, this.levelBuf.length)
    const buf = this.levelBuf.subarray(0, len)
    analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (let i = 0; i < len; i++) {
      const centered = (buf[i] - 128) / 128
      sum += centered * centered
    }
    const rms = Math.sqrt(sum / len)
    return Math.min(1, rms * 2.5)
  }

  private handleHostEvent(event: RealtimeHostEvent): void {
    if (event.requestId !== this.requestId || this.closed) return
    if (event.kind === 'error') {
      this.events.onError?.(event.message ?? 'The ChatGPT live voice session failed.')
    }
    const unexpected =
      event.kind === 'error' || !event.reason || !EXPECTED_HOST_CLOSE_REASONS.has(event.reason)
    this.closeInternal(unexpected)
  }

  private handleServerEvent(ev: ServerEvent): void {
    if (this.closed) return
    switch (ev.type) {
      case 'input_audio_buffer.speech_started':
        this.setMode('listening')
        break
      case 'input_audio_buffer.speech_stopped':
        this.setMode('working')
        break
      case 'conversation.item.input_audio_transcription.delta': {
        const key = String(ev.item_id ?? 'user')
        const partial = this.userPartials.get(key) ?? { id: entryId(), text: '' }
        partial.text += typeof ev.delta === 'string' ? ev.delta : ''
        this.userPartials.set(key, partial)
        this.events.onPartialTranscript?.({ id: partial.id, role: 'user', text: partial.text })
        break
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const key = String(ev.item_id ?? 'user')
        const partial = this.userPartials.get(key)
        this.userPartials.delete(key)
        const text = typeof ev.transcript === 'string' ? ev.transcript.trim() : ''
        if (text) {
          this.events.onTranscript?.({
            id: partial?.id ?? entryId(),
            role: 'user',
            text,
            at: Date.now()
          })
        }
        break
      }
      case 'response.created':
        this.responseActive = true // covers server-initiated (VAD) responses too
        this.setMode('working')
        break
      case 'response.output_audio_transcript.delta': {
        const key = String(ev.item_id ?? ev.response_id ?? 'jarvis')
        const partial = this.assistantPartials.get(key) ?? { id: entryId(), text: '' }
        partial.text += typeof ev.delta === 'string' ? ev.delta : ''
        this.assistantPartials.set(key, partial)
        this.events.onPartialTranscript?.({ id: partial.id, role: 'jarvis', text: partial.text })
        this.setMode('speaking')
        break
      }
      case 'response.output_audio_transcript.done': {
        const key = String(ev.item_id ?? ev.response_id ?? 'jarvis')
        const partial = this.assistantPartials.get(key)
        this.assistantPartials.delete(key)
        const text =
          typeof ev.transcript === 'string' && ev.transcript.trim()
            ? ev.transcript.trim()
            : (partial?.text ?? '')
        if (text) {
          this.events.onTranscript?.({
            id: partial?.id ?? entryId(),
            role: 'jarvis',
            text,
            at: Date.now()
          })
        }
        break
      }
      case 'output_audio_buffer.started':
        this.setMode('speaking')
        break
      case 'output_audio_buffer.stopped':
      case 'output_audio_buffer.cleared':
        this.setMode('idle')
        break
      case 'response.done': {
        this.responseActive = false
        if (this.responseQueued) {
          this.responseQueued = false
          this.requestResponse()
        }
        if (this.mode === 'working') this.setMode('idle')
        break
      }
      case 'error': {
        const detail =
          typeof ev.error === 'object' && ev.error ? (ev.error as Record<string, unknown>) : null
        const msg =
          detail && typeof detail.message === 'string' ? detail.message : 'Realtime session error.'
        this.events.onError?.(msg)
        break
      }
      default:
        break
    }
  }
}

function waitForDataChannelOpen(channel: RTCDataChannel, timeoutMs: number): Promise<void> {
  if (channel.readyState === 'open') return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error('The live voice event channel did not open in time.'))
    }, timeoutMs)
    const onOpen = (): void => {
      cleanup()
      resolve()
    }
    const onClosed = (): void => {
      cleanup()
      reject(new Error('The live voice event channel closed during startup.'))
    }
    const cleanup = (): void => {
      window.clearTimeout(timer)
      channel.removeEventListener('open', onOpen)
      channel.removeEventListener('close', onClosed)
      channel.removeEventListener('error', onClosed)
    }
    channel.addEventListener('open', onOpen, { once: true })
    channel.addEventListener('close', onClosed, { once: true })
    channel.addEventListener('error', onClosed, { once: true })
  })
}
