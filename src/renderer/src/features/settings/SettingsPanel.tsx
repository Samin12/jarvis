/** Compact operator-facing runtime facts. Credentials never enter this panel. */
import { useState, type CSSProperties, type JSX } from 'react'

export function SettingsPanel(): JSX.Element | null {
  const [open, setOpen] = useState(false)
  if (!window.jarvis) return null

  return (
    <div className="settings-panel" style={styles.panel}>
      <button
        type="button"
        className="panel-btn settings-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        {open ? 'voice routing ▴' : 'voice routing ▾'}
      </button>

      {open && (
        <div className="settings-body" style={styles.body}>
          <div className="settings-row" style={styles.row}>
            <span style={styles.label}>live</span>
            <span style={styles.value}>signed-in ChatGPT · experimental</span>
          </div>
          <div className="settings-row" style={styles.row}>
            <span style={styles.label}>fallback</span>
            <span style={styles.value}>on-device speech · automatic</span>
          </div>
          <p style={styles.hint}>
            Jarvis uses the local pinned Codex runtime for the live channel. No Platform key is
            required. Hold Space to open the microphone; release it to close the gate.
          </p>
        </div>
      )}
    </div>
  )
}

const styles: Record<string, CSSProperties> = {
  panel: {
    marginTop: 14,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
    maxWidth: 280
  },
  body: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8
  },
  row: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 10,
    fontSize: 8.5,
    letterSpacing: '0.14em',
    textTransform: 'uppercase'
  },
  label: {
    color: 'var(--ink-faint, #63636f)',
    letterSpacing: '0.22em',
    fontSize: 7.5,
    minWidth: 64
  },
  value: {
    color: 'var(--ink-dim, #a0a0b2)'
  },
  hint: {
    margin: 0,
    fontSize: 8,
    lineHeight: 1.5,
    letterSpacing: '0.06em',
    color: 'var(--ink-faint, #63636f)'
  }
}

export default SettingsPanel
