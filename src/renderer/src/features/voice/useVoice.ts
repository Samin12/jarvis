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
  useEffect(() => {
    optsRef.current = options
  })

  // Without the preload bridge (plain browser preview) no probe can run — fallback.
  const [lane, setLane] = useState<VoiceLane | null>(() => (window.jarvis ? null : 'fallback'))
  const [active, setActive] = useState(false)
  const [coreMode, setCoreMode] = useState<CoreMode>('idle')
  const [micOpen, setMicOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const clientRef = useRef<ActiveClient | null>(null)
  const startingRef = useRef(false)
  /** Bumped by stop() so in-flight start()/reconnects know they were cancelled. */
  const sessionEpochRef = useRef(0)
  /** Lets the ~55-minute onSessionExpiring reconnect re-invoke startRealtime. */
  const startRealtimeRef = useRef<() => Promise<void>>(async () => {})

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

  // Initial lane probe (async — resolves into state when the answer lands).
  useEffect(() => {
    if (!window.jarvis) return undefined // lane already initialized to 'fallback'
    let alive = true
    window.jarvis.voice
      .laneAvailable()
      .then((probed) => {
        if (alive) setLane(probed)
      })
      .catch(() => {
        if (alive) setLane('fallback')
      })
    return () => {
      alive = false
    }
  }, [])

  const teardown = useCallback((): void => {
    const current = clientRef.current
    clientRef.current = null
    current?.client.close()
    setMicOpen(false)
  }, [])

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

  const startRealtime = useCallback(async (): Promise<void> => {
    const client = new RealtimeVoiceClient({
      onCoreMode: emitMode,
      onTranscript: (e) => optsRef.current.onTranscript?.(e),
      onPartialTranscript: (p) => optsRef.current.onPartialTranscript?.(p),
      onError: (m) => emitError(m),
      onSessionExpiring: () => {
        // Reconnect before the 60-minute session cap: fresh grant, fresh peer connection.
        const epoch = sessionEpochRef.current
        optsRef.current.onTranscript?.({
          id: crypto.randomUUID(),
          role: 'system',
          text: 'Refreshing the voice session…',
          at: Date.now()
        })
        teardown()
        void startRealtimeRef.current().catch((err) => {
          // The failed client may still hold the mic and peer connection — release them.
          teardown()
          if (sessionEpochRef.current !== epoch) return // user stood down meanwhile
          optsRef.current.onTranscript?.({
            id: crypto.randomUUID(),
            role: 'system',
            text: `Live voice unavailable (${err instanceof Error ? err.message : String(err)}). Switching to fallback lane.`,
            at: Date.now()
          })
          startFallback()
        })
      }
    })
    clientRef.current = { lane: 'realtime', client }
    await client.connect()
    setLane('realtime')
  }, [emitMode, emitError, teardown, startFallback])

  useEffect(() => {
    startRealtimeRef.current = startRealtime
  }, [startRealtime])

  const start = useCallback(async (): Promise<void> => {
    if (clientRef.current || startingRef.current) return
    startingRef.current = true
    const epoch = sessionEpochRef.current
    setError(null)
    try {
      let probed: VoiceLane = 'fallback'
      try {
        probed = await window.jarvis.voice.laneAvailable()
      } catch {
        probed = 'fallback'
      }
      if (sessionEpochRef.current !== epoch) return // stopped while probing
      if (probed === 'realtime') {
        try {
          await startRealtime()
        } catch (err) {
          // Realtime refused (revoked key, network, mic denied on mint path) — degrade cleanly.
          teardown()
          if (sessionEpochRef.current !== epoch) return // stopped mid-connect — stay down
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
      if (sessionEpochRef.current !== epoch) {
        teardown()
        return
      }
      setActive(true)
      emitMode('idle')
    } finally {
      startingRef.current = false
    }
  }, [startRealtime, startFallback, teardown, emitMode])

  const stop = useCallback((): void => {
    sessionEpochRef.current += 1 // cancel any in-flight start()/reconnect
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
  // The client is resolved per event via clientRef — the ~55-minute auto-reconnect
  // swaps in a new RealtimeVoiceClient without changing `active`/`lane`, and PTT
  // must drive the live client, not a closed one captured at bind time.
  useEffect(() => {
    if (!active || lane !== 'realtime') return undefined
    const code = optsRef.current.pushToTalkCode ?? 'Space'

    const setMic = (on: boolean): boolean => {
      const current = clientRef.current
      if (!current || current.lane !== 'realtime') return false
      current.client.setMicEnabled(on)
      return true
    }
    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false
      return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== code || e.repeat || isTypingTarget(e.target)) return
      e.preventDefault()
      if (setMic(true)) setMicOpen(true)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== code || isTypingTarget(e.target)) return
      e.preventDefault()
      setMic(false)
      setMicOpen(false)
    }
    const onBlur = (): void => {
      setMic(false)
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

  // Codex task completion → announce into the live voice session. The dispatch
  // ack promises "completion will be announced separately"; this is that path.
  const announcedTasksRef = useRef(new Set<string>())
  useEffect(() => {
    if (!window.jarvis) return undefined // non-preload context (plain browser preview)
    return window.jarvis.codex.onTaskChanged((task) => {
      if (task.state === 'running') return
      if (announcedTasksRef.current.has(task.taskId)) return
      announcedTasksRef.current.add(task.taskId)
      const summary = task.spokenSummary?.trim()
      if (!summary) return
      const current = clientRef.current
      if (!current) return // session stopped — the CodexPanel still shows the result
      if (current.lane === 'realtime') {
        current.client.announceSystemUpdate(
          `The Codex task you dispatched just finished (${task.state}): ${summary} ` +
            'Report this back to the user in one or two spoken sentences.'
        )
      } else {
        current.client.announceSystemUpdate(summary)
      }
    })
  }, [])

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
