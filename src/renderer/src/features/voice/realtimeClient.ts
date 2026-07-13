/**
 * Realtime WebRTC lane — renderer client.
 * Mints an ek_ secret via main, does the SDP exchange with /v1/realtime/calls,
 * runs the oai-events data channel (transcripts + manual function-call loop, D2),
 * and exposes getLevel() for the orb.
 */
import type { CoreMode, TranscriptEntry } from '../../../../shared/types'
import { JARVIS_PERSONA_REALTIME } from '../../../../shared/persona'

const CALLS_URL = 'https://api.openai.com/v1/realtime/calls'
/** Sessions hard-cap at 60 minutes — ask the orchestrator to reconnect before that. */
const RECONNECT_BEFORE_MS = 55 * 60 * 1000
const MAX_TOOL_OUTPUT_CHARS = 8_000

export const DISPATCH_CODEX_TOOL = {
  type: 'function',
  name: 'dispatch_codex_task',
  description:
    'Run an agentic computer task on this machine via Codex (file cleanup, coding, automation). ' +
    'SIDE-EFFECT TOOL: first call it WITHOUT `confirmed` to get a preview, read the task back to ' +
    'the user and wait for their spoken confirmation, then call again with the same task plus ' +
    '`confirmed: true` to actually dispatch. ' +
    'Returns immediately with a task id; results stream into the task panel and are announced later.',
  parameters: {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Self-contained natural-language description of the task to perform.'
      },
      confirmed: {
        type: 'boolean',
        description:
          'Set true ONLY after the user has explicitly confirmed this task out loud. Omit on the first call.'
      }
    },
    required: ['task']
  }
} as const

type ServerEvent = { type?: string } & Record<string, any>

export interface RealtimeClientEvents {
  onCoreMode?: (mode: CoreMode) => void
  onTranscript?: (entry: TranscriptEntry) => void
  /** Streaming (not yet final) transcript text, keyed by a stable id. */
  onPartialTranscript?: (partial: { id: string; role: 'user' | 'jarvis'; text: string }) => void
  onError?: (message: string) => void
  /** Fired ~5 minutes before the 60-minute session cap — reconnect now. */
  onSessionExpiring?: () => void
  onClosed?: () => void
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
  private closed = false
  private mode: CoreMode = 'idle'
  /** Serialize response.create — the server rejects one while another response is active. */
  private responseActive = false
  private responseQueued = false
  private handledCallIds = new Set<string>()
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
    const grant = await window.jarvis.voice.mintRealtimeSession()
    if ('error' in grant) throw new Error(grant.error)

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    })
    this.micTrack = this.micStream.getAudioTracks()[0] ?? null
    if (!this.micTrack) throw new Error('No microphone track available.')
    this.micTrack.enabled = false // push-to-talk: closed until held open

    const pc = new RTCPeerConnection()
    this.pc = pc
    pc.addTrack(this.micTrack, this.micStream)

    this.audioEl = document.createElement('audio')
    this.audioEl.autoplay = true
    pc.ontrack = (e): void => {
      const stream = e.streams[0]
      if (!stream || !this.audioEl) return
      this.audioEl.srcObject = stream
      this.attachAnalysers(stream)
    }
    pc.onconnectionstatechange = (): void => {
      if (this.closed) return
      const state = pc.connectionState
      // 'disconnected' is transient — ICE usually recovers within seconds;
      // only 'failed'/'closed' are terminal.
      if (state === 'failed' || state === 'closed') {
        this.events.onError?.(`Voice connection ${state}.`)
        this.close()
      }
    }

    const dc = pc.createDataChannel('oai-events')
    this.dc = dc
    dc.addEventListener('message', (e) => {
      try {
        this.handleServerEvent(JSON.parse(e.data) as ServerEvent)
      } catch {
        // non-JSON payloads are ignored
      }
    })
    dc.addEventListener('open', () => {
      void this.configureSession()
    })

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    const sdpResponse = await fetch(`${CALLS_URL}?model=${encodeURIComponent(grant.model)}`, {
      method: 'POST',
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${grant.clientSecret}`,
        'Content-Type': 'application/sdp'
      }
    })
    if (!sdpResponse.ok) {
      const body = await sdpResponse.text().catch(() => '')
      throw new Error(
        `Realtime SDP exchange failed (HTTP ${sdpResponse.status}). ${body.slice(0, 200)}`
      )
    }
    await pc.setRemoteDescription({ type: 'answer', sdp: await sdpResponse.text() })

    this.reconnectTimer = window.setTimeout(() => {
      if (!this.closed) this.events.onSessionExpiring?.()
    }, RECONNECT_BEFORE_MS)
  }

  /** Inject a typed user turn (greeting button, mixed text input) and ask for a response. */
  sendUserText(text: string): void {
    const trimmed = text.trim()
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
    const trimmed = text.trim()
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
    if (this.closed) return
    this.closed = true
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
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
    this.setMode('idle')
    this.events.onClosed?.()
  }

  // ---------- internals ----------

  private send(payload: Record<string, unknown>): void {
    if (this.dc && this.dc.readyState === 'open') this.dc.send(JSON.stringify(payload))
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

  private async configureSession(): Promise<void> {
    let connectorTools: unknown[] = []
    try {
      connectorTools = await window.jarvis.connectors.voiceTools()
    } catch {
      connectorTools = []
    }
    const tools = [...(connectorTools as Record<string, unknown>[]), DISPATCH_CODEX_TOOL]
    this.send({
      type: 'session.update',
      session: {
        type: 'realtime',
        instructions: JARVIS_PERSONA_REALTIME,
        tools,
        tool_choice: 'auto'
      }
    })
  }

  private handleServerEvent(ev: ServerEvent): void {
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
      case 'response.function_call_arguments.done':
        if (typeof ev.name === 'string' && typeof ev.call_id === 'string') {
          void this.runFunctionCall(ev.name, ev.call_id, String(ev.arguments ?? '{}'))
        }
        break
      case 'response.done': {
        this.responseActive = false
        const output = (ev.response as Record<string, any> | undefined)?.output
        if (Array.isArray(output)) {
          for (const item of output) {
            if (
              item &&
              item.type === 'function_call' &&
              typeof item.name === 'string' &&
              typeof item.call_id === 'string'
            ) {
              void this.runFunctionCall(item.name, item.call_id, String(item.arguments ?? '{}'))
            }
          }
        }
        if (this.responseQueued) {
          this.responseQueued = false
          this.requestResponse()
        }
        if (this.mode === 'working') this.setMode('idle')
        break
      }
      case 'error': {
        const msg =
          typeof ev.error === 'object' && ev.error && typeof ev.error.message === 'string'
            ? ev.error.message
            : 'Realtime session error.'
        this.events.onError?.(msg)
        break
      }
      default:
        break
    }
  }

  private async runFunctionCall(name: string, callId: string, argsJson: string): Promise<void> {
    if (this.handledCallIds.has(callId)) return
    this.handledCallIds.add(callId)

    const toolEntryId = entryId()
    this.events.onTranscript?.({
      id: toolEntryId,
      role: 'system',
      text: name,
      at: Date.now(),
      tool: { name, status: 'running' }
    })

    let output: string
    let ok = true
    try {
      if (name === 'dispatch_codex_task') {
        let task = ''
        let confirmed = false
        try {
          const parsed = JSON.parse(argsJson) as { task?: unknown; confirmed?: unknown }
          task = typeof parsed.task === 'string' ? parsed.task : ''
          confirmed = parsed.confirmed === true
        } catch {
          task = ''
        }
        if (!task.trim()) throw new Error('dispatch_codex_task called without a task description.')
        if (!confirmed) {
          // Codex runs autonomously with write access — gate it like the other
          // side-effect tools: preview first, dispatch only after confirmation.
          ok = false
          output = JSON.stringify({
            needs_confirmation: true,
            tool: name,
            preview: { task },
            message:
              'Dispatching a Codex task changes files on this machine. Read the task back to the user, wait for their spoken confirmation, then call dispatch_codex_task again with the same task plus confirmed: true.'
          })
        } else {
          const { taskId } = await window.jarvis.codex.dispatch({ prompt: task })
          output = JSON.stringify({
            status: 'started',
            taskId,
            note: 'Task dispatched to Codex. Tell the user it is underway; completion will be announced separately.'
          })
        }
      } else {
        const res = await window.jarvis.voice.executeTool({ name, argsJson })
        ok = res.ok
        output = res.resultJson ?? JSON.stringify({ error: 'empty tool result' })
      }
    } catch (err) {
      ok = false
      const msg = err instanceof Error ? err.message : String(err)
      output = JSON.stringify({ error: msg })
    }

    if (output.length > MAX_TOOL_OUTPUT_CHARS) {
      output = `${output.slice(0, MAX_TOOL_OUTPUT_CHARS)}…(truncated)`
    }

    // The intentional confirmation round-trip is not an error — surface it as
    // its own status so the HUD shows a "confirm?" chip instead of a red one.
    let awaitingConfirmation = false
    if (!ok) {
      try {
        const parsed = JSON.parse(output) as { needs_confirmation?: unknown }
        awaitingConfirmation = parsed.needs_confirmation === true
      } catch {
        /* not JSON — plain error */
      }
    }

    this.events.onTranscript?.({
      id: entryId(),
      role: 'system',
      text: name,
      at: Date.now(),
      tool: { name, status: ok ? 'done' : awaitingConfirmation ? 'awaiting_confirmation' : 'error' }
    })

    this.send({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: callId, output }
    })
    this.requestResponse()
  }
}
