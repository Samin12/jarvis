import { useEffect } from 'react'
import LoginScreen from './features/auth/LoginScreen'
import HudShell from './components/hud/HudShell'
import TranscriptPanel from './components/hud/TranscriptPanel'
import { useAppState, useAppDispatch } from './state/appState'
import type { CodexTaskRow, ConnectorCard } from '../../shared/types'

// ---------------------------------------------------------------------------
// APP — signed_out → LoginScreen (features/auth); signed_in → the HUD shell
// with its four edge zones. The zone panels below are visual placeholders
// reading the shared store; the integration wave swaps in the feature panels
// (ConnectorsPanel, CodexPanel, voice controls) via the same slots.
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

const CONN_DOT: Record<ConnectorCard['status'], string> = {
  connected: '',
  connecting: 'stale',
  disconnected: 'off',
  not_configured: 'mock',
  error: 'error'
}

function ConnectorsSummary(): React.JSX.Element {
  const { connectors } = useAppState()
  const connected = connectors.filter((c) => c.status === 'connected').length
  return (
    <section className="block connectors-summary" style={{ width: '100%' }}>
      <div className="sec-title">
        <span>Connectors</span>
        <span className="tick">
          {connectors.length > 0 ? `${connected}/${connectors.length} LINKED` : 'STANDBY'}
        </span>
      </div>
      {connectors.length === 0 && <div className="panel-empty">no connectors registered</div>}
      {connectors.map((c) => (
        <div key={c.slug} className={`conn-row ${c.status}`}>
          <i className={`status-dot ${CONN_DOT[c.status]}`} />
          <span className="conn-title">{c.title}</span>
          {c.detail && <span className="conn-detail">{c.detail}</span>}
          <span className="conn-state">{c.status.replace('_', ' ')}</span>
        </div>
      ))}
    </section>
  )
}

function taskStateCls(t: CodexTaskRow): string {
  if (t.state === 'running') return 'running'
  if (t.state === 'done') return 'done'
  return 'failed' // failed | cancelled render the err hue
}

function CodexZone(): React.JSX.Element {
  const { codexTasks } = useAppState()
  const rows = codexTasks.slice(-5)
  return (
    <section className="block codex-zone">
      <div className="sec-title">
        <span>Codex Tasks</span>
        <span className="tick">
          {codexTasks.length > 0
            ? `${codexTasks.filter((t) => t.state === 'running').length} RUNNING`
            : 'IDLE'}
        </span>
      </div>
      {rows.length === 0 && <div className="panel-empty">no tasks dispatched</div>}
      {rows.map((t) => {
        const last = t.events[t.events.length - 1]
        return (
          <div key={t.taskId} className={`task-row ${taskStateCls(t)}`}>
            <div className="task-head">
              <span className="task-prompt">{t.prompt}</span>
              <span className="task-state">{t.terminal ?? t.state}</span>
            </div>
            <span
              className={`task-bar ${t.state === 'running' ? 'indet' : t.state === 'done' ? 'done' : 'failed'}`}
            >
              <i />
            </span>
            {last && <span className="task-last">{last.summary}</span>}
          </div>
        )
      })}
    </section>
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

  return (
    <HudShell
      mode={state.coreMode}
      topLeft={<IdentityStatus />}
      topRight={<ConnectorsSummary />}
      bottomLeft={
        <TranscriptPanel
          entries={state.transcript}
          onReset={() => dispatch({ type: 'transcript/reset' })}
        />
      }
      bottomRight={<CodexZone />}
    />
  )
}
