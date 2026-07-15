/**
 * Voice orchestrator hook — picks the ChatGPT realtime WebRTC lane when the
 * signed-in app-server supports it, with native local voice as fallback,
 * owns session lifecycle, push-to-talk (hold Space), the greeting trigger,
 * and surfaces transcript/coreMode callbacks for app state.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CoreMode,
  LocalVoiceState,
  TranscriptEntry,
  VoiceLane
} from '../../../../shared/types'
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
  /** True while Jarvis is opening LIVE or preparing the LOCAL fallback. */
  starting: boolean
  active: boolean
  coreMode: CoreMode
  /** Whether the mic gate is currently open (realtime PTT). */
  micOpen: boolean
  localVoiceState: LocalVoiceState
  error: string | null
  start: () => Promise<void>
  stop: () => void
  /** 'Good morning, Jarvis' greeting trigger (button-driven wake, wake-word is v2). */
  greet: () => void
  /** Text input path — the only input on the fallback lane, optional on realtime. */
  sendText: (text: string) => void
  /** 0..1 audio level for the orb; safe to call every frame. */
  getLevel: () => number
  /** Re-probe lane availability after authentication/runtime changes. */
  refreshLane: () => Promise<void>
}

const GREETING = 'Good morning, Jarvis.'

type ActiveClient =
  | { lane: 'realtime'; client: RealtimeVoiceClient }
  | { lane: 'fallback'; client: FallbackVoiceClient }

interface ClosableVoiceClient {
  close(): void
}

export function pushToTalkKeyAction(
  phase: 'down' | 'up',
  eventCode: string,
  configuredCode: string,
  options: { repeat: boolean; typingTarget: boolean }
): 'press' | 'release' | 'ignore' {
  if (eventCode !== configuredCode) return 'ignore'
  if (phase === 'up') return 'release'
  return options.repeat || options.typingTarget ? 'ignore' : 'press'
}

/**
 * Retire one specific client without disturbing a newer owner of the shared slot.
 * Exported so the stop/restart ordering can be regression-tested without a DOM.
 */
export function retireVoiceClient(
  currentClient: () => ClosableVoiceClient | null,
  clearCurrent: () => void,
  client: ClosableVoiceClient
): void {
  if (currentClient() === client) clearCurrent()
  client.close()
}

/** Publish async startup state only while the same client still owns this epoch. */
export function settleVoiceClientStartup(
  currentClient: () => ClosableVoiceClient | null,
  clearCurrent: () => void,
  currentEpoch: () => number,
  client: ClosableVoiceClient,
  expectedEpoch: number,
  publish: () => void
): boolean {
  if (currentClient() !== client || currentEpoch() !== expectedEpoch) {
    retireVoiceClient(currentClient, clearCurrent, client)
    return false
  }
  publish()
  return true
}

export function useVoice(options: UseVoiceOptions = {}): UseVoiceResult {
  const optsRef = useRef(options)
  useEffect(() => {
    optsRef.current = options
  })

  // Without the preload bridge (plain browser preview) no probe can run — fallback.
  const [lane, setLane] = useState<VoiceLane | null>(() => (window.jarvis ? null : 'fallback'))
  const [starting, setStarting] = useState(false)
  const [active, setActive] = useState(false)
  const [coreMode, setCoreMode] = useState<CoreMode>('idle')
  const [micOpen, setMicOpen] = useState(false)
  const [localVoiceState, setLocalVoiceState] = useState<LocalVoiceState>('unavailable')
  const [error, setError] = useState<string | null>(null)

  const clientRef = useRef<ActiveClient | null>(null)
  const startingRef = useRef(false)
  /** Bumped by stop() so in-flight start()/reconnects know they were cancelled. */
  const sessionEpochRef = useRef(0)
  /** Lets the ~55-minute onSessionExpiring reconnect re-invoke startRealtime. */
  const startRealtimeRef = useRef<(epoch: number) => Promise<boolean>>(async () => false)

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

  const retireClient = useCallback((client: ClosableVoiceClient): void => {
    retireVoiceClient(
      () => clientRef.current?.client ?? null,
      () => {
        clientRef.current = null
      },
      client
    )
  }, [])

  const commitClientStartup = useCallback(
    (client: ClosableVoiceClient, epoch: number, nextLane: VoiceLane): boolean =>
      settleVoiceClientStartup(
        () => clientRef.current?.client ?? null,
        () => {
          clientRef.current = null
        },
        () => sessionEpochRef.current,
        client,
        epoch,
        () => setLane(nextLane)
      ),
    []
  )

  const startFallback = useCallback(
    async (epoch: number): Promise<boolean> => {
      if (sessionEpochRef.current !== epoch) return false
      const client = new FallbackVoiceClient({
        onCoreMode: emitMode,
        onTranscript: (e) => optsRef.current.onTranscript?.(e),
        onPartialTranscript: (p) => optsRef.current.onPartialTranscript?.(p),
        onLocalState: setLocalVoiceState,
        onMicOpen: setMicOpen,
        onError: (m) => emitError(m)
      })
      clientRef.current = { lane: 'fallback', client }
      try {
        await client.start()
      } catch (error) {
        retireClient(client)
        throw error
      }
      return commitClientStartup(client, epoch, 'fallback')
    },
    [commitClientStartup, emitMode, emitError, retireClient]
  )

  const startRealtime = useCallback(
    async (epoch: number): Promise<boolean> => {
      if (sessionEpochRef.current !== epoch) return false
      const client = new RealtimeVoiceClient({
        onCoreMode: emitMode,
        onTranscript: (e) => optsRef.current.onTranscript?.(e),
        onPartialTranscript: (p) => optsRef.current.onPartialTranscript?.(p),
        onError: (m) => emitError(m),
        onClosed: (unexpected) => {
          if (!unexpected || clientRef.current?.client !== client) return
          clientRef.current = null
          setActive(false)
          setMicOpen(false)
          optsRef.current.onTranscript?.({
            id: crypto.randomUUID(),
            role: 'system',
            text: 'The live channel closed. Switching to on-device voice.',
            at: Date.now()
          })
          void startFallback(epoch)
            .then((started) => {
              if (!started) return
              setError(null)
              setActive(true)
              emitMode('idle')
            })
            .catch((err) => {
              if (sessionEpochRef.current === epoch) {
                emitError(err instanceof Error ? err.message : String(err))
              }
            })
        },
        onSessionExpiring: () => {
          if (clientRef.current?.client !== client) return
          // Reconnect before the 60-minute session cap: fresh grant, fresh peer connection.
          const epoch = sessionEpochRef.current
          optsRef.current.onTranscript?.({
            id: crypto.randomUUID(),
            role: 'system',
            text: 'Refreshing the voice session…',
            at: Date.now()
          })
          teardown()
          void startRealtimeRef.current(epoch).catch((err) => {
            if (sessionEpochRef.current !== epoch) return // user stood down meanwhile
            optsRef.current.onTranscript?.({
              id: crypto.randomUUID(),
              role: 'system',
              text: `Live voice unavailable (${err instanceof Error ? err.message : String(err)}). Switching to fallback lane.`,
              at: Date.now()
            })
            void startFallback(epoch)
              .then((started) => {
                if (!started) return
                setError(null)
                setActive(true)
                emitMode('idle')
              })
              .catch((fallbackError) => {
                if (sessionEpochRef.current !== epoch) return
                setActive(false)
                emitError(
                  fallbackError instanceof Error ? fallbackError.message : String(fallbackError)
                )
              })
          })
        }
      })
      clientRef.current = { lane: 'realtime', client }
      try {
        await client.connect()
      } catch (error) {
        retireClient(client)
        throw error
      }
      return commitClientStartup(client, epoch, 'realtime')
    },
    [commitClientStartup, emitMode, emitError, retireClient, teardown, startFallback]
  )

  useEffect(() => {
    startRealtimeRef.current = startRealtime
  }, [startRealtime])

  const start = useCallback(async (): Promise<void> => {
    if (clientRef.current || startingRef.current) return
    startingRef.current = true
    setStarting(true)
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
          if (!(await startRealtime(epoch))) return
        } catch (err) {
          // The experimental app-server lane or microphone may be unavailable — degrade cleanly.
          if (sessionEpochRef.current !== epoch) return // stopped mid-connect — stay down
          optsRef.current.onTranscript?.({
            id: crypto.randomUUID(),
            role: 'system',
            text: `Live voice unavailable (${err instanceof Error ? err.message : String(err)}). Switching to fallback lane.`,
            at: Date.now()
          })
          if (!(await startFallback(epoch))) return
        }
      } else {
        if (!(await startFallback(epoch))) return
      }
      if (sessionEpochRef.current !== epoch) return
      setError(null)
      setActive(true)
      emitMode('idle')
    } catch (err) {
      if (sessionEpochRef.current === epoch) {
        setActive(false)
        emitError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      startingRef.current = false
      setStarting(false)
    }
  }, [startRealtime, startFallback, emitMode, emitError])

  const stop = useCallback((): void => {
    sessionEpochRef.current += 1 // cancel any in-flight start()/reconnect
    teardown()
    setStarting(false)
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

  // Push-to-talk: realtime gates its WebRTC track; the default local lane starts
  // and finalizes one native speech-recognition session per key hold.
  useEffect(() => {
    if (!active) return undefined
    const code = optsRef.current.pushToTalkCode ?? 'Space'

    const setRealtimeMic = (on: boolean): boolean => {
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
      if (
        pushToTalkKeyAction('down', e.code, code, {
          repeat: e.repeat,
          typingTarget: isTypingTarget(e.target)
        }) !== 'press'
      ) {
        return
      }
      e.preventDefault()
      const current = clientRef.current
      if (current?.lane === 'realtime') {
        if (setRealtimeMic(true)) setMicOpen(true)
      } else if (current?.lane === 'fallback') {
        void current.client.startListening()
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      // Always close a hold that may have started outside an input. Focus can
      // move into the composer while Space is still held; filtering keyup by
      // its current target would otherwise leave the microphone/recognizer on.
      if (
        pushToTalkKeyAction('up', e.code, code, {
          repeat: e.repeat,
          typingTarget: isTypingTarget(e.target)
        }) !== 'release'
      ) {
        return
      }
      e.preventDefault()
      const current = clientRef.current
      if (current?.lane === 'realtime') {
        setRealtimeMic(false)
        setMicOpen(false)
      } else if (current?.lane === 'fallback') {
        void current.client.stopListening()
      }
    }
    const onBlur = (): void => {
      const current = clientRef.current
      if (current?.lane === 'realtime') setRealtimeMic(false)
      else if (current?.lane === 'fallback') void current.client.cancelListening()
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
      sessionEpochRef.current += 1
      clientRef.current?.client.close()
      clientRef.current = null
    }
  }, [])

  return {
    lane,
    starting,
    active,
    coreMode,
    micOpen,
    localVoiceState,
    error,
    start,
    stop,
    greet,
    sendText,
    getLevel,
    refreshLane
  }
}
