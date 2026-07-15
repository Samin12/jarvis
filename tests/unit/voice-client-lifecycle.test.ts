import { afterEach, describe, expect, it, vi } from 'vitest'

import { FallbackVoiceClient } from '../../src/renderer/src/features/voice/fallbackClient'
import { RealtimeVoiceClient } from '../../src/renderer/src/features/voice/realtimeClient'
import {
  pushToTalkKeyAction,
  retireVoiceClient,
  settleVoiceClientStartup
} from '../../src/renderer/src/features/voice/useVoice'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('voice client teardown races', () => {
  it('always releases a push-to-talk hold even when focus moved into the composer', () => {
    expect(
      pushToTalkKeyAction('down', 'Space', 'Space', {
        repeat: false,
        typingTarget: false
      })
    ).toBe('press')
    expect(
      pushToTalkKeyAction('up', 'Space', 'Space', {
        repeat: false,
        typingTarget: true
      })
    ).toBe('release')
    expect(
      pushToTalkKeyAction('down', 'Space', 'Space', {
        repeat: false,
        typingTarget: true
      })
    ).toBe('ignore')
  })

  it('does not let an old fallback settlement close or relabel a fresh realtime client', () => {
    const oldFallback = { close: vi.fn() }
    const freshRealtime = { close: vi.fn() }
    let current: { close(): void } | null = oldFallback
    let epoch = 0
    let lane = 'fallback'

    // Stand down closes the old client, then the user immediately engages again.
    epoch += 1
    retireVoiceClient(
      () => current,
      () => {
        current = null
      },
      oldFallback
    )
    current = freshRealtime
    lane = 'realtime'

    const published = settleVoiceClientStartup(
      () => current,
      () => {
        current = null
      },
      () => epoch,
      oldFallback,
      0,
      () => {
        lane = 'fallback'
      }
    )

    expect(published).toBe(false)
    expect(current).toBe(freshRealtime)
    expect(lane).toBe('realtime')
    expect(freshRealtime.close).not.toHaveBeenCalled()
  })

  it('lets a failed old reconnect retire itself without clearing a fresh client', () => {
    const oldReconnect = { close: vi.fn() }
    const freshClient = { close: vi.fn() }
    let current: { close(): void } | null = oldReconnect

    // Stand down retires the reconnect, then a fresh Engage owns the slot.
    retireVoiceClient(
      () => current,
      () => {
        current = null
      },
      oldReconnect
    )
    current = freshClient

    // The old connect promise rejects later and runs its cleanup continuation.
    retireVoiceClient(
      () => current,
      () => {
        current = null
      },
      oldReconnect
    )

    expect(current).toBe(freshClient)
    expect(oldReconnect.close).toHaveBeenCalledTimes(2)
    expect(freshClient.close).not.toHaveBeenCalled()
  })

  it('stops a microphone granted after realtime startup was closed', async () => {
    const permission = deferred<MediaStream>()
    const stopTrack = vi.fn()
    const realtimeStart = vi.fn()
    const realtimeStop = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(() => permission.promise) }
    })
    vi.stubGlobal('window', {
      jarvis: {
        voice: { realtimeStart, realtimeStop }
      }
    })

    const client = new RealtimeVoiceClient()
    const connecting = client.connect()
    const rejected = expect(connecting).rejects.toThrow('startup was cancelled')
    client.close()
    permission.resolve({
      getTracks: () => [{ stop: stopTrack }],
      getAudioTracks: () => [{ stop: stopTrack }]
    } as unknown as MediaStream)

    await rejected
    expect(stopTrack).toHaveBeenCalledTimes(1)
    expect(realtimeStart).not.toHaveBeenCalled()
    expect(realtimeStop).toHaveBeenCalledTimes(1)
  })

  it('never falls back to browser speech after the fallback client closes', async () => {
    const localSpeak = deferred<void>()
    const browserSpeak = vi.fn()
    const speechSynthesis = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      cancel: vi.fn(),
      getVoices: vi.fn(() => []),
      speak: browserSpeak
    }
    vi.stubGlobal('SpeechSynthesisUtterance', class {})
    vi.stubGlobal('window', {
      jarvis: {
        core: {
          onDelta: vi.fn(() => () => undefined),
          cancel: vi.fn().mockResolvedValue(undefined)
        },
        voice: {
          onLocalEvent: vi.fn(() => () => undefined),
          localStatus: vi.fn().mockResolvedValue('ready'),
          localPermission: vi.fn().mockResolvedValue('ready'),
          localSpeak: vi.fn(() => localSpeak.promise),
          localCancel: vi.fn().mockResolvedValue(undefined),
          localStopSpeaking: vi.fn().mockResolvedValue(undefined)
        }
      },
      speechSynthesis
    })

    const client = new FallbackVoiceClient()
    await client.start()
    client.announceSystemUpdate('private account text')
    client.close()
    localSpeak.reject(new Error('native speech stopped'))
    await Promise.resolve()
    await Promise.resolve()

    expect(browserSpeak).not.toHaveBeenCalled()
  })

  it('opens typed fallback without waiting for the macOS permission sheet', async () => {
    const permission = deferred<'ready'>()
    const onLocalState = vi.fn()
    vi.stubGlobal('window', {
      jarvis: {
        core: {
          onDelta: vi.fn(() => () => undefined),
          cancel: vi.fn().mockResolvedValue(undefined)
        },
        voice: {
          onLocalEvent: vi.fn(() => () => undefined),
          localStatus: vi.fn().mockResolvedValue('permission_unknown'),
          localPermission: vi.fn(() => permission.promise),
          localCancel: vi.fn().mockResolvedValue(undefined),
          localStopSpeaking: vi.fn().mockResolvedValue(undefined)
        }
      },
      speechSynthesis: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        cancel: vi.fn(),
        getVoices: vi.fn(() => [])
      }
    })

    const client = new FallbackVoiceClient({ onLocalState })
    await client.start()

    expect(onLocalState).toHaveBeenCalledWith('permission_unknown')
    permission.resolve('ready')
    await Promise.resolve()
    await Promise.resolve()
    expect(onLocalState).toHaveBeenLastCalledWith('ready')
    client.close()
  })

  it('suppresses queued realtime data-channel events after close', () => {
    const transcript = vi.fn()
    const error = vi.fn()
    vi.stubGlobal('window', {
      jarvis: {
        voice: { realtimeStop: vi.fn().mockResolvedValue(undefined) }
      }
    })
    const client = new RealtimeVoiceClient({ onTranscript: transcript, onError: error })
    client.close()

    const probe = client as unknown as {
      handleServerEvent(event: Record<string, unknown>): void
    }
    probe.handleServerEvent({
      type: 'response.output_audio_transcript.done',
      item_id: 'old-item',
      transcript: 'private old account text'
    })
    probe.handleServerEvent({ type: 'error', error: { message: 'old account error' } })

    expect(transcript).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('suppresses a pending core-send rejection after fallback teardown', async () => {
    const sending = deferred<void>()
    const onError = vi.fn()
    vi.stubGlobal('window', {
      jarvis: {
        core: {
          onDelta: vi.fn(() => () => undefined),
          send: vi.fn(() => sending.promise),
          cancel: vi.fn().mockResolvedValue(undefined)
        },
        voice: {
          onLocalEvent: vi.fn(() => () => undefined),
          localStatus: vi.fn().mockResolvedValue('ready'),
          localPermission: vi.fn().mockResolvedValue('ready'),
          localCancel: vi.fn().mockResolvedValue(undefined),
          localStopSpeaking: vi.fn().mockResolvedValue(undefined)
        }
      },
      speechSynthesis: {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        cancel: vi.fn(),
        getVoices: vi.fn(() => [])
      }
    })

    const client = new FallbackVoiceClient({ onError })
    await client.start()
    client.send('private prompt')
    client.close()
    sending.reject(new Error('late core error'))
    await Promise.resolve()
    await Promise.resolve()

    expect(onError).not.toHaveBeenCalled()
  })
})

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
