/**
 * SettingsPanel — minimal settings surface (top-left zone, under IdentityStatus).
 *
 * D1 ladder step 3: lets the user paste (or clear) a Platform API key so the
 * realtime voice lane can be enabled from inside the app — the key goes to
 * main over voice:set-manual-api-key and never renders back out.
 */
import { useCallback, useState, type CSSProperties, type FormEvent, type JSX } from 'react'

export interface SettingsPanelProps {
  /** Called after the manual key changes so the voice lane can re-probe. */
  onVoiceKeyChanged?: () => void
}

export function SettingsPanel({ onVoiceKeyChanged }: SettingsPanelProps): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [hasKey, setHasKey] = useState(false)
  const [draft, setDraft] = useState('')
  const [feedback, setFeedback] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (!window.jarvis) return
    try {
      const settings = await window.jarvis.settings.get()
      setHasKey(settings.hasManualApiKey)
    } catch {
      /* keep the last known state */
    }
  }, [])

  if (!window.jarvis) return null // non-preload context (plain browser preview)

  const toggleOpen = (): void => {
    const next = !open
    setOpen(next)
    if (next) void refresh() // re-check hasManualApiKey whenever the panel opens
  }

  const saveKey = async (e: FormEvent): Promise<void> => {
    e.preventDefault()
    const key = draft.trim()
    if (!key || busy) return
    setBusy(true)
    setFeedback(null)
    try {
      const accepted = await window.jarvis.voice.setManualApiKey(key)
      if (accepted) {
        setDraft('')
        setFeedback('Key saved — live voice enabled.')
        await refresh()
        onVoiceKeyChanged?.()
      } else {
        setFeedback('That does not look like a valid API key.')
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const clearKey = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFeedback(null)
    try {
      await window.jarvis.voice.setManualApiKey('')
      setFeedback('Key cleared.')
      await refresh()
      onVoiceKeyChanged?.()
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-panel" style={styles.panel}>
      <button
        type="button"
        className="panel-btn settings-toggle"
        onClick={toggleOpen}
        aria-expanded={open}
      >
        {open ? 'settings ▴' : 'settings ▾'}
      </button>

      {open && (
        <div className="settings-body" style={styles.body}>
          <div className="settings-row" style={styles.row}>
            <span style={styles.label}>voice key</span>
            <span style={styles.value}>{hasKey ? 'manual key set' : 'none pasted'}</span>
          </div>
          <form className="settings-form" style={styles.form} onSubmit={(e) => void saveKey(e)}>
            <input
              className="settings-input"
              style={styles.input}
              type="password"
              value={draft}
              placeholder="Paste OpenAI Platform API key…"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
            />
            <div className="settings-actions" style={styles.actions}>
              <button type="submit" className="panel-btn" disabled={busy || !draft.trim()}>
                Save
              </button>
              <button
                type="button"
                className="panel-btn danger"
                disabled={busy || !hasKey}
                onClick={() => void clearKey()}
              >
                Clear
              </button>
            </div>
          </form>
          <p style={styles.hint}>
            Enables full-duplex realtime voice. Stored encrypted in the main process — it never
            reaches this window again. Alternatively run `codex login`.
          </p>
          {feedback && (
            <p className="settings-feedback" style={styles.feedback} role="status">
              {feedback}
            </p>
          )}
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
    maxWidth: 260
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
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6
  },
  input: {
    background: 'rgba(255, 255, 255, 0.04)',
    border: '1px solid var(--line, rgba(255, 255, 255, 0.14))',
    color: 'var(--white-hot, #e8e8ee)',
    fontFamily: 'inherit',
    fontSize: 10,
    padding: '6px 8px',
    outline: 'none'
  },
  actions: {
    display: 'flex',
    gap: 8
  },
  hint: {
    margin: 0,
    fontSize: 8,
    lineHeight: 1.5,
    letterSpacing: '0.06em',
    color: 'var(--ink-faint, #63636f)'
  },
  feedback: {
    margin: 0,
    fontSize: 8.5,
    letterSpacing: '0.08em',
    color: 'var(--ink-dim, #a0a0b2)'
  }
}

export default SettingsPanel
