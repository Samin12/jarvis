/**
 * Voice orchestrator hook — picks the lane (realtime WebRTC vs no-key fallback),
 * owns session lifecycle, push-to-talk (hold Space), the greeting trigger,
 * and surfaces transcript/coreMode callbacks for app state.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { CoreMode, TranscriptEntry, VoiceLane } from '../../../../shared/types'
import { RealtimeVoiceClient } from './realtimeClient'
import { FallbackVoiceClient } from './fallbackClient'

export interface UseVoiceOptions {
  onTranscript?: (entry: TranscriptEntry) => void
  onPartialTranscript?: (partial: { id: string; role: 'user' | 'jarvis'; text: string }) => void
  onCoreModeChange?: (mode: CoreMode) => void
  onError?: (message: string) => void
  /** Push-to-talk key (KeyboardEvent.code). Defaults to Space. */
  pushToTalkCode?: string
}

export interface UseVoiceResult {
  /** Best available lane (null until first probe resolves). */
  lane: VoiceLane | null
  active: boolean
  coreMode: CoreMode
  /** Whether the mic gate is currently open (realtime PTT). */
  micOpen: boolean
  error: string | null
  start: () => Promise<void>
  stop: () => void
  /** 'Good morning, Jarvis' greeting trigger (button-driven wake, wake-word is v2). */
  greet: () => void
  /** Text input path — the only input on the fallback lane, optional on realtime. */
  sendText: (text: string) => void
  /** 0..1 audio level for the orb; safe to call every frame. */
  getLevel: () => number
  /** Re-probe lane availability (e.g. after pasting a key in Settings). */
  refreshLane: () => Promise<void>
}

const GREETING = 'Good morning, Jarvis.'

type ActiveClient =
  | { lane: 'realtime'; client: RealtimeVoiceClient }
  | { lane: 'fallback'; client: FallbackVoiceClient }

export function useVoice(options: UseVoiceOptions = {}): UseVoiceResult {
  const optsRef = useRef(options)
  optsRef.current = options

  const [lane, setLane] = useState<VoiceLane | null>(null)
  const [active, setActive] = useState(false)
  const [coreMode, setCoreMode] = useState<CoreMode>('idle')
  const [micOpen, setMicOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clientRef = useRef<ActiveClient | null>(null)
  const startingRef = useRef(false)

  const emitMode = useCallback((mode: CoreMode): void => {
    setCoreMode(mode)
    optsRef.current.onCoreModeChange?.(mode)
  }, [])

  const emitError = useCallback(
    (message: string): void => {
      setError(message)
      optsRef.current.onError?.(message)
      optsRef.current.onTranscript?.({
        id: crypto.randomUUID(),
        role: 'system',
        text: message,
        at: Date.now()
      })
      emitMode('error')
    },
    [emitMode]
  )

  const refreshLane = useCallback(async (): Promise<void> => {
    try {
      setLane(await window.jarvis.voice.laneAvailable())
    } catch {
      setLane('fallback')
    }
  }, [])

  useEffect(() => {
    void refreshLane()
  }, [refreshLane])

  const teardown = useCallback((): void => {
    const current = clientRef.current
    clientRef.current = null
    current?.client.close()
    setMicOpen(false)
  }, [])

  const startRealtime = useCallback(async (): Promise<void> => {
    const client = new RealtimeVoiceClient({
      onCoreMode: emitMode,
      onTranscript: (e) => optsRef.current.onTranscript?.(e),
      onPartialTranscript: (p) => optsRef.current.onPartialTranscript?.(p),
      onError: (m) => emitError(m),
      onSessionExpiring: () => {
        // Reconnect before the 60-minute session cap: fresh grant, fresh peer connection.
        optsRef.current.onTranscript?.({
          id: crypto.randomUUID(),
          role: 'system',
          text: 'Refreshing the voice session…',
          at: Date.now()
        })
        teardown()
        void startRealtime().catch((err) =>
          emitError(err instanceof Error ? err.message : String(err))
        )
      }
    })
    clientRef.current = { lane: 'realtime', client }
    await client.connect()
    setLane('realtime')
  }, [emitMode, emitError, teardown])

  const startFallback = useCallback((): void => {
    const client = new FallbackVoiceClient({
      onCoreMode: emitMode,
      onTranscript: (e) => optsRef.current.onTranscript?.(e),
      onPartialTranscript: (p) => optsRef.current.onPartialTranscript?.(p),
      onError: (m) => emitError(m)
    })
    client.start()
    clientRef.current = { lane: 'fallback', client }
    setLane('fallback')
  }, [emitMode, emitError])

  const start = useCallback(async (): Promise<void> => {
    if (clientRef.current || startingRef.current) return
    startingRef.current = true
    setError(null)
    try {
      let probed: VoiceLane = 'fallback'
      try {
        probed = await window.jarvis.voice.laneAvailable()
      } catch {
        probed = 'fallback'
      }
      if (probed === 'realtime') {
        try {
          await startRealtime()
        } catch (err) {
          // Realtime refused (revoked key, network, mic denied on mint path) — degrade cleanly.
          teardown()
          optsRef.current.onTranscript?.({
            id: crypto.randomUUID(),
            role: 'system',
            text: `Live voice unavailable (${err instanceof Error ? err.message : String(err)}). Switching to fallback lane.`,
            at: Date.now()
          })
          startFallback()
        }
      } else {
        startFallback()
      }
      setActive(true)
      emitMode('idle')
    } finally {
      startingRef.current = false
    }
  }, [startRealtime, startFallback, teardown, emitMode])

  const stop = useCallback((): void => {
    teardown()
    setActive(false)
    emitMode('idle')
  }, [teardown, emitMode])

  const sendText = useCallback((text: string): void => {
    const current = clientRef.current
    if (!current) return
    if (current.lane === 'realtime') current.client.sendUserText(text)
    else current.client.send(text)
  }, [])

  const greet = useCallback((): void => {
    sendText(GREETING)
  }, [sendText])

  const getLevel = useCallback((): number => {
    return clientRef.current?.client.getLevel() ?? 0
  }, [])

  // Push-to-talk: hold Space (while the HUD window has focus) to open the mic gate.
  useEffect(() => {
    if (!active) return undefined
    const current = clientRef.current
    if (!current || current.lane !== 'realtime') return undefined
    const client = current.client
    const code = optsRef.current.pushToTalkCode ?? 'Space'

    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false
      return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== code || e.repeat || isTypingTarget(e.target)) return
      e.preventDefault()
      client.setMicEnabled(true)
      setMicOpen(true)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== code || isTypingTarget(e.target)) return
      e.preventDefault()
      client.setMicEnabled(false)
      setMicOpen(false)
    }
    const onBlur = (): void => {
      client.setMicEnabled(false)
      setMicOpen(false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', onBlur)
    return (): void => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
    }
  }, [active, lane])

  // Teardown on unmount.
  useEffect(() => {
    return (): void => {
      clientRef.current?.client.close()
      clientRef.current = null
    }
  }, [])

  return {
    lane,
    active,
    coreMode,
    micOpen,
    error,
    start,
    stop,
    greet,
    sendText,
    getLevel,
    refreshLane
  }
}
