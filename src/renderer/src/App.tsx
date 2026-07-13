import { useCallback, useEffect, useRef } from 'react'
import { LoginScreen } from './features/auth'
import HudShell from './components/hud/HudShell'
import TranscriptPanel from './components/hud/TranscriptPanel'
import { ConnectorsPanel } from './features/connectors'
import { CodexPanel } from './features/codex'
import { SettingsPanel } from './features/settings'
import { useVoice, VoiceDock } from './features/voice'
import { useAppState, useAppDispatch } from './state/appState'
import type { TranscriptEntry } from '../../shared/types'

// ---------------------------------------------------------------------------
// APP — signed_out → LoginScreen (features/auth); signed_in → the HUD shell
// composed from the real feature panels: TranscriptPanel (bottom-left),
// ConnectorsPanel (top-right), CodexPanel (bottom-right), VoiceDock (bottom
// center). The voice hook drives the orb (mode + audio level) and feeds the
// transcript/lane slices of the shared store.
// ---------------------------------------------------------------------------

function IdentityStatus(): React.JSX.Element | null {
  const { auth, voiceLane } = useAppState()
  if (auth.state !== 'signed_in') return null
  return (
    <div className="identity">
      <div className="id-row">
        <span className="k">operator</span>
        <span className="v">{auth.email ?? 'unknown'}</span>
      </div>
      <div className="id-row">
        <span className="k">plan</span>
        <span className="v">{auth.planType ?? '—'}</span>
      </div>
      <div className="id-row">
        <span className="k">voice</span>
        <span className={`v ${auth.voiceKeyAvailable ? 'hot' : ''}`}>
          {auth.voiceKeyAvailable ? `realtime · ${auth.voiceKeySource ?? 'key'}` : voiceLane}
        </span>
      </div>
    </div>
  )
}

function HudApp(): React.JSX.Element {
  const state = useAppState()
  const dispatch = useAppDispatch()

  // Transcript ids we've already appended — lets streaming partials and their
  // final entries (same id) collapse into in-place updates.
  const knownIds = useRef(new Set<string>())

  const handleTranscript = useCallback(
    (entry: TranscriptEntry): void => {
      if (knownIds.current.has(entry.id)) {
        dispatch({
          type: 'transcript/update',
          id: entry.id,
          patch: { text: entry.text, at: entry.at, tool: entry.tool }
        })
      } else {
        knownIds.current.add(entry.id)
        dispatch({ type: 'transcript/append', entry })
      }
    },
    [dispatch]
  )

  const handlePartial = useCallback(
    (partial: { id: string; role: 'user' | 'jarvis'; text: string }): void => {
      if (knownIds.current.has(partial.id)) {
        dispatch({ type: 'transcript/update', id: partial.id, patch: { text: partial.text } })
      } else {
        knownIds.current.add(partial.id)
        dispatch({
          type: 'transcript/append',
          entry: { id: partial.id, role: partial.role, text: partial.text, at: Date.now() }
        })
      }
    },
    [dispatch]
  )

  const voice = useVoice({
    onTranscript: handleTranscript,
    onPartialTranscript: handlePartial,
    onCoreModeChange: (mode) => dispatch({ type: 'core/setMode', mode })
  })

  // lane → store (IdentityStatus + anything else reading voiceLane)
  useEffect(() => {
    if (voice.lane) dispatch({ type: 'voice/setLane', lane: voice.lane })
  }, [voice.lane, dispatch])

  // Real speech envelope for the orb; null hands GraphCore its synthetic one.
  const voiceActive = voice.active
  const getVoiceLevel = voice.getLevel
  const getOrbLevel = useCallback(
    (): number | null => (voiceActive ? getVoiceLevel() : null),
    [voiceActive, getVoiceLevel]
  )

  const resetTranscript = useCallback((): void => {
    knownIds.current.clear()
    dispatch({ type: 'transcript/reset' })
  }, [dispatch])

  return (
    <HudShell
      mode={state.coreMode}
      getLevel={getOrbLevel}
      topLeft={
        <>
          <IdentityStatus />
          <SettingsPanel onVoiceKeyChanged={() => void voice.refreshLane()} />
        </>
      }
      topRight={<ConnectorsPanel />}
      bottomLeft={<TranscriptPanel entries={state.transcript} onReset={resetTranscript} />}
      bottomRight={<CodexPanel />}
      statusExtra={
        voice.active ? (
          <span className="chip on">lane · {voice.lane ?? 'probing'}</span>
        ) : (
          <span className="chip">voice · standby</span>
        )
      }
      dock={<VoiceDock voice={voice} />}
    />
  )
}

export default function App(): React.JSX.Element {
  const state = useAppState()
  const dispatch = useAppDispatch()

  // bootstrap the auth slice — initial pull + push updates from main
  useEffect(() => {
    if (!window.jarvis) return undefined // non-preload context (plain browser preview)
    let alive = true
    window.jarvis.auth
      .getStatus()
      .then((s) => {
        if (alive) dispatch({ type: 'auth/set', status: s })
      })
      .catch(() => undefined)
    const off = window.jarvis.auth.onStatusChanged((s) => dispatch({ type: 'auth/set', status: s }))
    return () => {
      alive = false
      off()
    }
  }, [dispatch])

  if (state.auth.state !== 'signed_in') {
    return <LoginScreen />
  }

  return <HudApp />
}
